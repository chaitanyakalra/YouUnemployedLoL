import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
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

// ── MCP Server ────────────────────────────────────────────────────────────────
const server = new Server(
  { name: "job-mcp-server", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

// ── Register tools ────────────────────────────────────────────────────────────
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    searchJobsTool,
    matchResumeTool,
    getJobDetailsTool,
    trackApplicationTool,
  ],
}));

// ── Handle tool calls ─────────────────────────────────────────────────────────
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

// ── Start ─────────────────────────────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);
console.error("🚀 Job MCP Server running — 4 tools active: search_jobs, match_resume, get_job_details, track_application");
