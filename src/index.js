import express from "express";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { connectDB } from "./db/connect.js";

// ── Tools ─────────────────────────────────────────────────────────────────────
import { setProfileTool,       setProfile       } from "./tools/set_profile.js";
import { findJobsTool,         findJobs         } from "./tools/find_jobs.js";
import { getJobDetailsTool,    getJobDetails    } from "./tools/get_job_details.js";
import { trackApplicationTool, trackApplication } from "./tools/track_application.js";
import { matchResumeTool,      matchResume      } from "./tools/match_resume.js";

// ── Single source of truth for registered tools ────────────────────────────────
const TOOLS = [
  { def: setProfileTool,       fn: setProfile       },
  { def: findJobsTool,         fn: findJobs         },
  { def: getJobDetailsTool,    fn: getJobDetails    },
  { def: trackApplicationTool, fn: trackApplication },
  { def: matchResumeTool,      fn: matchResume      },
];

const TOOL_NAMES = TOOLS.map((t) => t.def.name);
const TOOL_DEFS  = TOOLS.map((t) => t.def);
const TOOL_MAP   = Object.fromEntries(TOOLS.map((t) => [t.def.name, t.fn]));

// ── Connect to MongoDB (needed by match_resume, get_job_details, track_application)
await connectDB();

// ── MCP Server factory ────────────────────────────────────────────────────────
function createMcpServer() {
  const server = new Server(
    { name: "youunemployedlol", version: "2.0.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    let text;
    try {
      const fn = TOOL_MAP[name];
      if (fn) {
        text = await fn(args);
      } else {
        text = `Unknown tool: "${name}". Available: ${TOOL_NAMES.join(", ")}`;
      }
    } catch (err) {
      text = `Error in "${name}": ${err.message}`;
    }
    return { content: [{ type: "text", text }] };
  });

  return server;
}

// ── Express app ───────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

// Streamable HTTP (modern — mcp-remote, Claude Desktop)
const streamableSessions = new Map();

app.post("/mcp", async (req, res) => {
  if (isInitializeRequest(req.body)) {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (sessionId) => {
        streamableSessions.set(sessionId, transport);
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) streamableSessions.delete(transport.sessionId);
    };
    const server = createMcpServer();
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    return;
  }
  const sessionId = req.headers["mcp-session-id"];
  const transport = streamableSessions.get(sessionId);
  if (!transport) {
    return res.status(400).json({ jsonrpc: "2.0", error: { code: -32000, message: "Invalid session" }, id: null });
  }
  await transport.handleRequest(req, res, req.body);
});

app.get("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  const transport = streamableSessions.get(sessionId);
  if (!transport) return res.status(400).json({ error: "Invalid session" });
  await transport.handleRequest(req, res);
});

app.delete("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  const transport = streamableSessions.get(sessionId);
  if (transport) { await transport.close(); streamableSessions.delete(sessionId); }
  res.status(200).json({ ok: true });
});

// Legacy SSE
const legacyTransports = {};

app.get("/sse", async (req, res) => {
  const transport = new SSEServerTransport("/messages", res);
  legacyTransports[transport.sessionId] = transport;
  res.on("close", () => { delete legacyTransports[transport.sessionId]; });
  const server = createMcpServer();
  await server.connect(transport);
});

app.post("/messages", async (req, res) => {
  const { sessionId } = req.query;
  const transport = legacyTransports[sessionId];
  if (!transport) return res.status(400).json({ error: "Invalid sessionId" });
  await transport.handlePostMessage(req, res);
});

// ── Health — dynamic from TOOLS array ─────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({
    status:     "ok",
    version:    "2.0.0",
    tools:      TOOL_NAMES,
    transports: ["streamable-http (POST /mcp)", "sse (GET /sse)"],
    flow:       "set_profile → find_jobs → get_job_details / track_application",
    note:       "find_jobs uses live Apify scraping (LinkedIn + Internshala). match_resume reads MongoDB.",
  });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.error(`🚀 YouUnemployedLol v2.0 on port ${PORT}`);
  console.error(`   Tools (${TOOL_NAMES.length}): ${TOOL_NAMES.join(", ")}`);
  console.error(`   Flow: set_profile → find_jobs → get_job_details / track_application`);
  console.error(`   POST /mcp | GET /sse | GET /health`);
});
