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
import { getStatusTool,       getStatus       } from "./tools/get_job_status.js";
import { getJobDetailsTool,    getJobDetails    } from "./tools/get_job_details.js";
import { trackApplicationTool, trackApplication } from "./tools/track_application.js";
import { matchResumeTool,      matchResume      } from "./tools/match_resume.js";
import { start as startScheduler } from "./scheduler.js";

const TOOLS = [
  { def: setProfileTool,       fn: setProfile       },
  { def: findJobsTool,         fn: findJobs         },
  { def: getStatusTool,       fn: getStatus       },
  { def: getJobDetailsTool,    fn: getJobDetails    },
  { def: trackApplicationTool, fn: trackApplication },
  { def: matchResumeTool,      fn: matchResume      },
];

const TOOL_NAMES = TOOLS.map((t) => t.def.name);
const TOOL_DEFS  = TOOLS.map((t) => t.def);
const TOOL_MAP   = Object.fromEntries(TOOLS.map((t) => [t.def.name, t.fn]));

// ── MCP Server factory ────────────────────────────────────────────────────────
function createMcpServer() {
  const mcpServer = new Server(
    { name: "youunemployedlol", version: "2.0.0" },
    { capabilities: { tools: {} } }
  );
  mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_DEFS }));
  mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    console.error(`[Tool] → ${name}`);
    const t0 = performance.now();
    let text;
    try {
      const fn = TOOL_MAP[name];
      text = fn ? await fn(args) : `Unknown tool: "${name}". Available: ${TOOL_NAMES.join(", ")}`;
    } catch (err) {
      console.error(`[Tool] ✗ ${name}: ${err.message}`);
      text = `Error in "${name}": ${err.message}`;
    }
    console.error(`[Tool] ✓ ${name} (${(performance.now() - t0).toFixed(0)}ms)`);
    return { content: [{ type: "text", text: String(text) }] };
  });
  return mcpServer;
}

// ── DB (non-blocking — server starts immediately regardless) ──────────────────
connectDB().catch((err) => console.error("⚠️  connectDB:", err.message));

// ── Express ───────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ limit: "20mb", extended: true }));

// ── Session store ─────────────────────────────────────────────────────────────
const streamableSessions = new Map();

// ── Helper: create a fresh transport and bind it to a given sessionId ─────────
// Used both for new sessions AND for re-attaching stale sessions after restart.
async function createSession(sessionId) {
  const transport = new StreamableHTTPServerTransport({
    // If sessionId provided, reuse it so mcp-remote never sees a new ID
    sessionIdGenerator: sessionId ? () => sessionId : () => crypto.randomUUID(),
    onsessioninitialized: (id) => {
      console.error(`[Session] ✓ ${id}`);
      streamableSessions.set(id, transport);
    },
  });
  transport.onclose = () => {
    if (transport.sessionId) {
      console.error(`[Session] ✗ closed ${transport.sessionId}`);
      streamableSessions.delete(transport.sessionId);
    }
  };
  const mcpServer = createMcpServer();
  await mcpServer.connect(transport);
  return transport;
}

// ── POST /mcp ─────────────────────────────────────────────────────────────────
app.post("/mcp", async (req, res) => {
  res.setHeader("X-Accel-Buffering", "no");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  req.setTimeout(0);
  res.setTimeout(0);

  // Case 1 — fresh initialize handshake
  if (isInitializeRequest(req.body)) {
    console.error("[Session] New init request");
    const transport = await createSession(null);
    await transport.handleRequest(req, res, req.body);
    return;
  }

  const sessionId = req.headers["mcp-session-id"];

  // Case 2 — known session, happy path
  let transport = streamableSessions.get(sessionId);
  if (transport) {
    try {
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error(`[MCP] request error: ${err.message}`);
      if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: err.message }, id: null });
    }
    return;
  }

  // Case 3 — STALE SESSION (server restarted, mcp-remote still has old ID)
  // Root fix: transparently re-create the session with the SAME sessionId
  // mcp-remote never gets a 400, so it never hangs or gives up.
  if (sessionId) {
    console.error(`[Session] ↺ Stale session ${sessionId} — auto-recovering`);
    try {
      transport = await createSession(sessionId);
      // Re-handle the original request on the fresh transport
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error(`[Session] Recovery failed: ${err.message}`);
      if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Session recovery failed" }, id: null });
    }
    return;
  }

  // Case 4 — no session ID at all and not an init request (malformed client)
  res.status(400).json({ jsonrpc: "2.0", error: { code: -32000, message: "Missing mcp-session-id. Send initialize first." }, id: null });
});

app.get("/mcp", async (req, res) => {
  res.setHeader("X-Accel-Buffering", "no");
  const transport = streamableSessions.get(req.headers["mcp-session-id"]);
  if (!transport) return res.status(400).json({ error: "Invalid session" });
  await transport.handleRequest(req, res);
});

app.delete("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  const transport = streamableSessions.get(sessionId);
  if (transport) { await transport.close(); streamableSessions.delete(sessionId); }
  res.status(200).json({ ok: true });
});

// ── SSE (legacy fallback) ─────────────────────────────────────────────────────
const legacyTransports = {};
app.get("/sse", async (req, res) => {
  res.setHeader("X-Accel-Buffering", "no");
  const transport = new SSEServerTransport("/messages", res);
  legacyTransports[transport.sessionId] = transport;
  res.on("close", () => delete legacyTransports[transport.sessionId]);
  await createMcpServer().connect(transport);
});
app.post("/messages", async (req, res) => {
  const transport = legacyTransports[req.query.sessionId];
  if (!transport) return res.status(400).json({ error: "Invalid sessionId" });
  await transport.handlePostMessage(req, res);
});

// ── Health ────────────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => res.json({
  status: "ok", version: "2.2.0",
  tools: TOOL_NAMES,
  sessions: streamableSessions.size,
  transports: ["POST /mcp (streamable-http)", "GET /sse (legacy)"],
  note: "Stale sessions auto-recover after server restart — no client reconnect needed.",
}));

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.error(`🚀 YouUnemployedLol v2.3 on :${PORT}`);
  console.error(`   Tools: ${TOOL_NAMES.join(", ")}`);
  
  // Start background worker scheduler
  startScheduler().catch(err => console.error("⚠️ [Scheduler] Failed to start:", err.message));
});
