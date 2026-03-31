// test_mcp.js — End-to-end test of the live MCP server
// Tests: health → initialize → list tools → find_jobs

const BASE = process.env.MCP_URL || "https://youunemployedlol.onrender.com";

function parseSSE(raw) {
  // SSE format: "event: message\ndata: {...}\n\n"
  const lines = raw.split("\n");
  for (const line of lines) {
    if (line.startsWith("data: ")) {
      try { return JSON.parse(line.slice(6)); } catch {}
    }
  }
  // Fallback: try parsing the entire body as JSON
  try { return JSON.parse(raw); } catch { return null; }
}

async function test() {
  console.log("=" .repeat(60));
  console.log("STEP 1 — Health Check");
  console.log("=" .repeat(60));
  const healthRes = await fetch(`${BASE}/health`);
  const health = await healthRes.json();
  console.log("Status:", health.status);
  console.log("Tools:", health.tools.join(", "));
  console.log("✅ Health check passed\n");

  // ── STEP 2: Initialize MCP session ──
  console.log("=" .repeat(60));
  console.log("STEP 2 — Initialize MCP Session");
  console.log("=" .repeat(60));
  const initRes = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test-script", version: "1.0" },
      },
      id: 1,
    }),
  });

  const sessionId = initRes.headers.get("mcp-session-id");
  const initBody = await initRes.text();
  const initData = parseSSE(initBody);

  console.log("HTTP Status:", initRes.status);
  console.log("Session ID:", sessionId || "NOT FOUND");
  console.log("Server Info:", JSON.stringify(initData?.result?.serverInfo || initData, null, 2));

  if (!sessionId) {
    console.error("❌ No session ID returned. Cannot continue.");
    process.exit(1);
  }
  console.log("✅ Session initialized\n");

  // ── STEP 3: List tools ──
  console.log("=" .repeat(60));
  console.log("STEP 3 — List Tools");
  console.log("=" .repeat(60));
  const listRes = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
      "mcp-session-id": sessionId,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "tools/list",
      params: {},
      id: 2,
    }),
  });

  const listBody = await listRes.text();
  const listData = parseSSE(listBody);
  const tools = listData?.result?.tools || [];

  console.log(`Found ${tools.length} tools:`);
  for (const t of tools) {
    const required = t.inputSchema?.required || [];
    console.log(`  - ${t.name} (required: ${required.join(", ") || "none"})`);
  }
  console.log("✅ Tools listed\n");

  // ── STEP 4: Call find_jobs with a test query ──
  console.log("=" .repeat(60));
  console.log("STEP 4 — Call find_jobs (LIVE SCRAPE TEST)");
  console.log("=" .repeat(60));
  console.log("⏳ This will trigger live Apify scrapers. May take 60-90 seconds...\n");

  const findRes = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
      "mcp-session-id": sessionId,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "tools/call",
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

  const findBody = await findRes.text();
  const findData = parseSSE(findBody);

  console.log("HTTP Status:", findRes.status);

  if (findData?.result?.content) {
    const text = findData.result.content[0]?.text || "";
    console.log("\n--- FIND_JOBS OUTPUT ---");
    console.log(text);
    console.log("--- END OUTPUT ---\n");

    // Check for sources
    const hasLinkedIn = text.toLowerCase().includes("linkedin");
    const hasInternshala = text.toLowerCase().includes("internshala");
    const hasJobs = text.includes("| Role |") || text.includes("Job Search Results");
    const hasNoJobs = text.includes("No jobs found");

    console.log("=== VERDICT ===");
    if (hasJobs) {
      console.log("✅ find_jobs returned scored results!");
    } else if (hasNoJobs) {
      console.log("⚠️  find_jobs returned no results (scrapers may have found nothing for this query).");
    } else {
      console.log("⚠️  Unexpected output format.");
    }
  } else if (findData?.error) {
    console.log("❌ Error:", JSON.stringify(findData.error, null, 2));
  } else {
    console.log("❌ Unexpected response:");
    console.log(findBody.slice(0, 500));
  }

  // ── Cleanup: close session ──
  await fetch(`${BASE}/mcp`, {
    method: "DELETE",
    headers: { "mcp-session-id": sessionId },
  });
  console.log("\n🧹 Session closed.");
}

test().catch((err) => {
  console.error("Fatal error:", err.message);
  process.exit(1);
});
