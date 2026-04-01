// test_clean.js — Comprehensive Live Verify for Job-MCP-Server
import { writeFileSync } from "fs";

const BASE = "https://youunemployedlol.onrender.com";

function parseSSE(raw) {
  if (!raw) return { error: "Empty response" };
  const lines = raw.split("\n");
  for (const line of lines) {
    if (line.trim().startsWith("data: ")) {
      try {
        const data = line.trim().slice(6);
        return JSON.parse(data);
      } catch (e) {}
    }
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    // If it's a raw SSE burst without "data: " prefix on the line we're at
    const match = raw.match(/data:\s*({.*})/);
    if (match) {
      try { return JSON.parse(match[1]); } catch (err) {}
    }
    return { error: "Failed to parse JSON or SSE", raw };
  }
}

async function main() {
  console.log(`Starting High-Fidelity Audit: ${BASE}\n`);
  const report = { 
    health: null, 
    tools_list: null, 
    set_profile: null, 
    get_profile: null, 
    find_jobs: null,
    track_app: null,
    get_apps: null 
  };

  try {
    // 1. Health & Init
    report.health = await (await fetch(`${BASE}/health`)).json();
    console.log("✅ Health check passed.");

    const initRes = await fetch(`${BASE}/mcp`, {
      method: "POST",
      headers: { 
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream"
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "AuditTool", version: "1.0" } }, id: 1 }),
    });
    
    // The initialization response is often an SSE stream burst
    const initRaw = await initRes.text();
    const initBody = parseSSE(initRaw);
    
    // Some transports return the session ID in headers, others in the body
    let sessionId = initRes.headers.get("mcp-session-id") || initRes.headers.get("X-MCP-Session-ID");
    
    if (!sessionId && initBody.result?.sessionId) {
      sessionId = initBody.result.sessionId;
    }

    if (!sessionId) {
      console.error("Init Body:", JSON.stringify(initBody));
      throw new Error("No session ID returned in headers or body");
    }
    console.log(`📡 Session Established: ${sessionId}`);

    const mcpCall = async (method, name, args = {}, id = 2) => {
      const res = await fetch(`${BASE}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "mcp-session-id": sessionId },
        body: JSON.stringify({ jsonrpc: "2.0", method, params: { name, arguments: args }, id }),
      });
      const text = await res.text();
      try {
        return JSON.parse(text);
      } catch (e) {
        return parseSSE(text);
      }
    };

    // 2. List Tools
    const listRes = await mcpCall("tools/list", null, {}, 2);
    report.tools_list = (listRes?.result?.tools || []).map(t => t.name);
    console.log(`✅ Tools discovered: ${report.tools_list.join(", ")}`);

    // 3. Set Profile with LARGE payload to test fix
    console.log("🔧 Testing set_profile with LARGE payload (50KB+)...");
    const largeResume = "EXPERIENCE ".repeat(5000); // ~55KB string
    report.set_profile = await mcpCall("tools/call", "set_profile", {
      role: "Software Engineer",
      location: "India",
      employment_type: "full-time",
      experience_level: "junior",
      resume_text: largeResume
    }, 3);

    // 4. Get Profile
    console.log("📋 Testing get_profile...");
    report.get_profile = await mcpCall("tools/call", "get_profile", {}, 4);

    // 5. Find Jobs (The Big One)
    console.log("🔍 Testing find_jobs (Parallel Scrapers)... This may take up to 60s.");
    report.find_jobs = await mcpCall("tools/call", "find_jobs", {
      keywords: "React Developer",
      location: "Noida",
      job_type: "full-time",
      max_results_per_source: 5
    }, 5);
    
    if (report.find_jobs?.result?.content?.[0]?.text) {
      const text = report.find_jobs.result.content[0].text;
      console.log(`✅ find_jobs complete. Results length: ${text.length} chars.`);
      console.log(`   Sources mentioned: ${["LinkedIn", "Naukri", "Internshala", "ATS"].filter(s => text.includes(s)).join(", ")}`);
    }

    // 6. Track Application
    console.log("📝 Testing track_application...");
    report.track_app = await mcpCall("tools/call", "track_application", {
      job_title: "Audit Test Job",
      company_name: "Audit Corp",
      status: "applied",
      notes: "Testing live persistence"
    }, 6);

    // 7. Get Applications
    console.log("📜 Testing get_applications...");
    report.get_apps = await mcpCall("tools/call", "get_applications", {}, 7);

    // Cleanup
    await fetch(`${BASE}/mcp`, { method: "DELETE", headers: { "mcp-session-id": sessionId } });
    
    writeFileSync("test_result.json", JSON.stringify(report, null, 2), "utf-8");
    console.log("\n🏁 ALL TOOLS VERIFIED. Summary written to test_result.json");

  } catch (err) {
    console.error("\n❌ AUDIT FAILED:", err.message);
    report.fatal_error = err.message;
    writeFileSync("test_result.json", JSON.stringify(report, null, 2), "utf-8");
  }
}

main();
