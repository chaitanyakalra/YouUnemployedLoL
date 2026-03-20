import express from "express";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { connectDB } from "./db/connect.js";

import { searchJobsTool,      searchJobs      } from "./tools/search_jobs.js";
import { matchResumeTool,     matchResume     } from "./tools/match_resume.js";
import { getJobDetailsTool,   getJobDetails   } from "./tools/get_job_details.js";
import { trackApplicationTool, trackApplication } from "./tools/track_application.js";

// ── Connect to MongoDB ────────────────────────────────────────────────────────
await connectDB();

// ── Helper: create a fresh MCP Server instance per SSE connection ─────────────
function createMcpServer() {
  const server = new Server(
    { name: "job-mcp-server", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  // Register tools
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      searchJobsTool,
      matchResumeTool,
      getJobDetailsTool,
      trackApplicationTool,
    ],
  }));

  // Handle tool calls
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    let text;
    try {
      switch (name) {
        case "search_jobs":        text = await searchJobs(args);        break;
        case "match_resume":       text = await matchResume(args);       break;
        case "get_job_details":    text = await getJobDetails(args);     break;
        case "track_application":  text = await trackApplication(args);  break;
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

// ── Express + SSE Transport ───────────────────────────────────────────────────
const app = express();

// Store active transports by sessionId
const transports = {};

// SSE endpoint — clients connect here to establish the MCP session
app.get("/sse", async (req, res) => {
  const transport = new SSEServerTransport("/messages", res);
  transports[transport.sessionId] = transport;

  // Clean up when the client disconnects
  res.on("close", () => {
    delete transports[transport.sessionId];
  });

  // Each SSE connection gets its own MCP server instance
  const server = createMcpServer();
  await server.connect(transport);
});

// Message endpoint — clients POST JSON-RPC messages here
app.post("/messages", async (req, res) => {
  const { sessionId } = req.query;
  const transport = transports[sessionId];

  if (!transport) {
    return res.status(400).json({ error: "Invalid or expired sessionId" });
  }

  await transport.handlePostMessage(req, res);
});

// Health check for Render
app.get("/health", (_req, res) => {
  res.json({ status: "ok", tools: 4 });
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.error(`🚀 Job MCP Server running on port ${PORT} — 4 tools active: search_jobs, match_resume, get_job_details, track_application`);
});
