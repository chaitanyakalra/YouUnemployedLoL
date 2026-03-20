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

import { searchJobsTool,       searchJobs       } from "./tools/search_jobs.js";
import { matchResumeTool,      matchResume      } from "./tools/match_resume.js";
import { getJobDetailsTool,    getJobDetails    } from "./tools/get_job_details.js";
import { trackApplicationTool, trackApplication } from "./tools/track_application.js";

// ── Connect to MongoDB ────────────────────────────────────────────────────────
await connectDB();

// ── Helper: create a fresh MCP Server instance ────────────────────────────────
function createMcpServer() {
  const server = new Server(
    { name: "job-mcp-server", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [searchJobsTool, matchResumeTool, getJobDetailsTool, trackApplicationTool],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    let text;
    try {
      switch (name) {
        case "search_jobs":       text = await searchJobs(args);       break;
        case "match_resume":      text = await matchResume(args);      break;
        case "get_job_details":   text = await getJobDetails(args);    break;
        case "track_application": text = await trackApplication(args); break;
        default:
          text = `Unknown tool: "${name}". Available: search_jobs, match_resume, get_job_details, track_application`;
      }
    } catch (err) {
      text = `Error in tool "${name}": ${err.message}\n\nIf this is a database error, the server may still be starting up. Please try again in a moment.`;
    }
    return { content: [{ type: "text", text }] };
  });

  return server;
}

// ── Express App ───────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

// ── 1. Streamable HTTP Transport (modern — for mcp-remote, Claude Desktop) ────
//       All communication happens over POST /mcp
const streamableSessions = new Map();

app.post("/mcp", async (req, res) => {
  // New session: client sends initialize request
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

  // Existing session
  const sessionId = req.headers["mcp-session-id"];
  const transport = streamableSessions.get(sessionId);
  if (!transport) {
    return res.status(400).json({ jsonrpc: "2.0", error: { code: -32000, message: "Invalid or expired session" }, id: null });
  }
  await transport.handleRequest(req, res, req.body);
});

// GET /mcp — for SSE streaming responses in stateless mode
app.get("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  const transport = streamableSessions.get(sessionId);
  if (!transport) {
    return res.status(400).json({ error: "Invalid or expired session" });
  }
  await transport.handleRequest(req, res);
});

// DELETE /mcp — session cleanup
app.delete("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  const transport = streamableSessions.get(sessionId);
  if (transport) {
    await transport.close();
    streamableSessions.delete(sessionId);
  }
  res.status(200).json({ ok: true });
});

// ── 2. Legacy SSE Transport (for older clients) ───────────────────────────────
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
  if (!transport) {
    return res.status(400).json({ error: "Invalid or expired sessionId" });
  }
  await transport.handlePostMessage(req, res);
});

// ── Health check ──────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({ status: "ok", tools: 4, transports: ["streamable-http (/mcp)", "sse (/sse)"] });
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.error(`🚀 Job MCP Server running on port ${PORT}`);
  console.error(`   Streamable HTTP: POST /mcp`);
  console.error(`   Legacy SSE:      GET  /sse`);
  console.error(`   Health:          GET  /health`);
});
