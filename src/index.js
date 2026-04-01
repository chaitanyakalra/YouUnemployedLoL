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

// ── MCP Server factory — DEFINED BEFORE USE ──────────────────────────────────
function createMcpServer() {
  const mcpServer = new Server(
    { name: "youunemployedlol", version: "2.0.0" },
    { capabilities: { tools: {} } }
  );

  mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFS,
  }));

  mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    console.error(`[Tool] Calling: ${name}`);
    const start = performance.now();
    let text;
    try {
      const fn = TOOL_MAP[name];
      if (fn) {
        text = await fn(args);
      } else {
        text = `Unknown tool: "${name}". Available: ${TOOL_NAMES.join(", ")}`;
      }
    } catch (err) {
      console.error(`[Tool] Error in "${name}": ${err.message}`);
      text = `Error in "${name}": ${err.message}`;
    }
    const ms = (performance.now() - start).toFixed(0);
    console.error(`[Tool] "${name}" completed in ${ms}ms`);
    return { content: [{ type: "text", text: String(text) }] };
  });

  return mcpServer;
}

// ── Connect to MongoDB (non-blocking — DB features degrade gracefully) ────────
connectDB().catch((err) => {
  console.error("⚠️  connectDB error on startup:", err.message);
});

// ── Express app ───────────────────────────────────────────────────────────────
const app = express();

// Handle large resume payloads (up to 20MB)
app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ limit: "20mb", extended: true }));

// ── Streamable HTTP transport (Claude Desktop / mcp-remote) ───────────────────
const streamableSessions = new Map();

app.post("/mcp", async (req, res) => {
  // Tell Render / Nginx not to buffer long-running responses
  res.setHeader("X-Accel-Buffering", "no");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  // Disable Node's default 120s socket timeout for scrapers
  req.setTimeout(0);
  res.setTimeout(0);

  if (isInitializeRequest(req.body)) {
    console.error(`[Session] New initialization request`);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (sessionId) => {
        console.error(`[Session] Established: ${sessionId}`);
        streamableSessions.set(sessionId, transport);
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) {
        console.error(`[Session] Closed: ${transport.sessionId}`);
        streamableSessions.delete(transport.sessionId);
      }
    };
    // Each session gets its own MCP server instance
    const mcpServer = createMcpServer();
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, req.body);
    return;
  }

  const sessionId = req.headers["mcp-session-id"];
  const transport = streamableSessions.get(sessionId);
  if (!transport) {
    console.error(`[Session] ❌ Invalid session: ${sessionId}`);
    return res.status(400).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Invalid or expired session. Re-initialize." },
      id: null,
    });
  }

  try {
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error(`[MCP] Request error: ${err.message}`);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: err.message },
        id: null,
      });
    }
  }
});

app.get("/mcp", async (req, res) => {
  res.setHeader("X-Accel-Buffering", "no");
  const sessionId = req.headers["mcp-session-id"];
  const transport = streamableSessions.get(sessionId);
  if (!transport) return res.status(400).json({ error: "Invalid session" });
  await transport.handleRequest(req, res);
});

app.delete("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  const transport = streamableSessions.get(sessionId);
  if (transport) {
    console.error(`[Session] Deleted: ${sessionId}`);
    await transport.close();
    streamableSessions.delete(sessionId);
  }
  res.status(200).json({ ok: true });
});

// ── Legacy SSE transport (fallback) ──────────────────────────────────────────
const legacyTransports = {};

app.get("/sse", async (req, res) => {
  res.setHeader("X-Accel-Buffering", "no");
  const transport = new SSEServerTransport("/messages", res);
  legacyTransports[transport.sessionId] = transport;
  res.on("close", () => { delete legacyTransports[transport.sessionId]; });
  const mcpServer = createMcpServer();
  await mcpServer.connect(transport);
});

app.post("/messages", async (req, res) => {
  const { sessionId } = req.query;
  const transport = legacyTransports[sessionId];
  if (!transport) return res.status(400).json({ error: "Invalid sessionId" });
  await transport.handlePostMessage(req, res);
});

// ── Health ────────────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({
    status:     "ok",
    version:    "2.1.0",
    tools:      TOOL_NAMES,
    transports: ["streamable-http (POST /mcp)", "sse (GET /sse)"],
    flow:       "set_profile → find_jobs → get_job_details / track_application",
    sources:    "LinkedIn, Naukri, Internshala, ATS x13",
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.error(`🚀 YouUnemployedLol v2.1 on port ${PORT}`);
  console.error(`   Tools (${TOOL_NAMES.length}): ${TOOL_NAMES.join(", ")}`);
  console.error(`   POST /mcp | GET /sse | GET /health`);
});
