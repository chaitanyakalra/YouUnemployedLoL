// test_mock.js — Tests find_jobs with mock data (no Apify calls needed)
// Run: node test_mock.js
// Should show a proper STEP 4 table with scored jobs

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
  console.log("============================================================");
  console.log("MOCK TEST — YouUnemployedLol find_jobs");
  console.log("============================================================\n");

  // 1. Health
  const health = await (await fetch(`${BASE}/health`)).json();
  console.log("✅ Health:", health.status, "| Tools:", health.tools.join(", "));

  // 2. Init session
  const initRes = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0", method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "mock-test", version: "1.0" } },
      id: 1,
    }),
  });
  const sessionId = initRes.headers.get("mcp-session-id");
  console.log("✅ Session:", sessionId);

  // 3. Call find_jobs with _mock: true
  console.log("\n⏳ Calling find_jobs with _mock: true (no Apify, instant response)...\n");
  const findRes = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
      "mcp-session-id": sessionId,
    },
    body: JSON.stringify({
      jsonrpc: "2.0", method: "tools/call",
      params: {
        name: "find_jobs",
        arguments: {
          keywords: "Full Stack Developer",
          location: "Noida",
          job_type: "both",
          posted_within: "this week",
          user_role: "Full Stack Developer",
          user_experience_level: "fresher",
          user_employment_type: "full-time",
          user_skills: "React, Node.js, MongoDB, TypeScript, AWS",
          _mock: true,
        },
      },
      id: 3,
    }),
  });

  const findData = parseSSE(await findRes.text());
  const output = findData?.result?.content?.[0]?.text || findData?.error || "NO OUTPUT";

  console.log("=== FIND_JOBS OUTPUT ===");
  console.log(output);
  console.log("=== END ===\n");

  // 4. Validate output
  const hasTitles   = output.includes("Full Stack") || output.includes("MERN") || output.includes("React") || output.includes("Backend");
  const hasScores   = output.includes("/10");
  const hasApply    = output.includes("Apply");
  const hasSources  = output.includes("LinkedIn") || output.includes("Naukri") || output.includes("mock");
  const noBlankRows = !output.includes("**** at ");

  console.log("=== VALIDATION ===");
  console.log(hasTitles   ? "✅ Job titles present"      : "❌ Job titles MISSING");
  console.log(hasScores   ? "✅ Fit scores present"      : "❌ Fit scores MISSING");
  console.log(hasApply    ? "✅ Apply links present"     : "❌ Apply links MISSING");
  console.log(hasSources  ? "✅ Source column present"   : "❌ Source column MISSING");
  console.log(noBlankRows ? "✅ No blank title/company"  : "❌ BLANK ROWS FOUND — bug still present");

  if (hasTitles && hasScores && hasApply && noBlankRows) {
    console.log("\n🎉 ALL CHECKS PASSED — mock test successful!\n");
  } else {
    console.log("\n⚠️  Some checks failed — review output above.\n");
    process.exit(1);
  }

  // Cleanup
  await fetch(`${BASE}/mcp`, { method: "DELETE", headers: { "mcp-session-id": sessionId } });
}

main().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
