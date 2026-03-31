// test_clean.js — writes full find_jobs output to test_result.json
import { writeFileSync } from "fs";

const BASE = "https://youunemployedlol.onrender.com";

function parseSSE(raw) {
  for (const line of raw.split("\n")) {
    if (line.startsWith("data: ")) {
      try { return JSON.parse(line.slice(6)); } catch {}
    }
  }
  try { return JSON.parse(raw); } catch { return null; }
}

async function main() {
  const report = { health: null, session: null, tools: null, find_jobs: null };

  // 1. Health
  report.health = await (await fetch(`${BASE}/health`)).json();

  // 2. Init
  const initRes = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1.0" } }, id: 1 }),
  });
  report.session = initRes.headers.get("mcp-session-id");

  // 3. List tools
  const listRes = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json, text/event-stream", "mcp-session-id": report.session },
    body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", params: {}, id: 2 }),
  });
  const listData = parseSSE(await listRes.text());
  report.tools = (listData?.result?.tools || []).map(t => t.name);

  // 4. Call find_jobs
  const findRes = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json, text/event-stream", "mcp-session-id": report.session },
    body: JSON.stringify({
      jsonrpc: "2.0", method: "tools/call",
      params: {
        name: "find_jobs",
        arguments: {
          keywords: "React developer",
          location: "Remote",
          job_type: "full-time",
          posted_within: "this week",
          max_results_per_source: 5,
          user_role: "React developer",
          user_experience_level: "entry",
          user_skills: "React, JavaScript, TypeScript, Node.js",
        },
      },
      id: 3,
    }),
  });
  const findData = parseSSE(await findRes.text());
  report.find_jobs = {
    status: findRes.status,
    text: findData?.result?.content?.[0]?.text || null,
    error: findData?.error || null,
  };

  // Cleanup
  await fetch(`${BASE}/mcp`, { method: "DELETE", headers: { "mcp-session-id": report.session } });

  writeFileSync("test_result.json", JSON.stringify(report, null, 2), "utf-8");
  console.log("Done. Results written to test_result.json");
}

main().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
