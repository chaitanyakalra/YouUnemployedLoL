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
import { Session } from "./db/schemas.js";
import crypto from "crypto";

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
  // If no sessionId, generate a new one
  const id = sessionId || crypto.randomUUID();
  
  // Try to find or create the session in DB first (Persistence)
  await Session.findOneAndUpdate(
    { sessionId: id },
    { lastActive: new Date() },
    { upsert: true, new: true }
  );

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => id,
    onsessioninitialized: (initializedId) => {
      console.error(`[Session] ✓ ${initializedId} (initialized)`);
      streamableSessions.set(initializedId, transport);
    },
  });

  transport.onclose = async () => {
    console.error(`[Session] ✗ closed ${id}`);
    streamableSessions.delete(id);
    // Update lastActive so TTL cleanup can work properly
    try {
      await Session.findOneAndUpdate(
        { sessionId: id },
        { lastActive: new Date() }
      );
    } catch (err) {
      console.error(`[Session] Failed to update lastActive on close: ${err.message}`);
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
    // Update session activity in DB (fire-and-forget)
    Session.findOneAndUpdate(
      { sessionId },
      { lastActive: new Date() }
    ).catch(err => console.error(`[Session] Failed to update lastActive: ${err.message}`));
    
    try {
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error(`[MCP] request error: ${err.message}`);
      if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: err.message }, id: null });
    }
    return;
  }

  // Case 3 — STALE SESSION (server restarted, mcp-remote still has old ID)
  // Tell client to re-initialize with proper MCP error response
  if (sessionId) {
    const knownSession = await Session.findOne({ sessionId });
    if (knownSession) {
      console.error(`[Session] ↺ Stale session ${sessionId} detected — instructing client to re-initialize`);
      // Update last active so it's not GC'd immediately
      knownSession.lastActive = new Date();
      await knownSession.save();
    } else {
      console.error(`[Session] ⚠️ Unknown session ID: ${sessionId}. Client must re-initialize.`);
    }
  }

  // Case 4 — Session expired/unknown - send proper error that triggers client reconnect
  // Use MCP error code -32000 (Server Error) which mcp-remote recognizes and handles by re-initializing
  if (!res.headersSent) {
    res.status(400).json({ 
      jsonrpc: "2.0", 
      error: { 
        code: -32000, 
        message: sessionId 
          ? "Session expired or server restarted. Please re-initialize connection." 
          : "Missing mcp-session-id. Send initialize request first." 
      }, 
      id: req.body?.id || null 
    });
  }
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
app.get("/health", async (_req, res) => {
  let dbSessionCount = 0;
  try {
    dbSessionCount = await Session.countDocuments();
  } catch (err) {
    console.error("[Health] Failed to count DB sessions:", err.message);
  }
  
  res.json({
    status: "ok", 
    version: "2.3.1",
    tools: TOOL_NAMES,
    sessions: {
      active: streamableSessions.size,
      inDatabase: dbSessionCount,
    },
    transports: ["POST /mcp (streamable-http)", "GET /sse (legacy)"],
    note: "Stale sessions trigger client re-initialization automatically.",
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.error(`🚀 YouUnemployedLol v2.3.1 on :${PORT}`);
  console.error(`   Tools: ${TOOL_NAMES.join(", ")}`);
  
  // Start background worker scheduler
  startScheduler().catch(err => console.error("⚠️ [Scheduler] Failed to start:", err.message));
  
  // Periodic session cleanup and logging (every 1 hour)
  setInterval(async () => {
    try {
      const dbCount = await Session.countDocuments();
      const activeCount = streamableSessions.size;
      console.error(`[Session] Status: ${activeCount} active, ${dbCount} in DB`);
      
      // Clean up any sessions that somehow weren't cleaned by TTL
      const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const deleted = await Session.deleteMany({ lastActive: { $lt: oneDayAgo } });
      if (deleted.deletedCount > 0) {
        console.error(`[Session] Cleaned up ${deleted.deletedCount} stale DB sessions`);
      }
    } catch (err) {
      console.error(`[Session] Cleanup error: ${err.message}`);
    }
  }, 60 * 60 * 1000); // 1 hour
});
