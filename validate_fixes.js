// validate_fixes.js - Quick validation script for find_jobs fixes
// Run: node validate_fixes.js

import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

console.log("🔍 Validating find_jobs.js fixes...\n");

// Test 1: Import the module
console.log("✓ Test 1: Module import");
try {
  const module = await import('./src/tools/find_jobs.js');
  console.log("  ✅ Module imported successfully");
  console.log("  ✅ Exports:", Object.keys(module).join(", "));
} catch (err) {
  console.log("  ❌ Import failed:", err.message);
  process.exit(1);
}

// Test 2: Check mock data generation
console.log("\n✓ Test 2: Mock data validation");
try {
  const { findJobs } = await import('./src/tools/find_jobs.js');
  
  // Test with _mock flag to avoid Apify calls
  const result = await findJobs({
    keywords: "React developer",
    location: "Noida",
    job_type: "full-time",
    posted_within: "this week",
    max_results_per_source: 5,
    _mock: true,
    user_role: "React developer",
    user_experience_level: "entry",
    user_skills: "React, JavaScript, Node.js"
  });
  
  console.log("  ✅ find_jobs executed without errors");
  console.log("  ✅ Output type:", typeof result);
  
  // Check if it's async search (returns search ID) or immediate results
  if (result.includes("Search ID") || result.includes("search_id")) {
    console.log("  ✅ Returns background search ID (async mode)");
  } else if (result.includes("STEP 4")) {
    console.log("  ✅ Returns immediate results (sync mode)");
  }
  
  console.log("\n📄 Sample output preview:");
  console.log("─".repeat(60));
  console.log(result.substring(0, 500) + "...");
  console.log("─".repeat(60));
  
} catch (err) {
  console.log("  ❌ Execution failed:", err.message);
  console.error(err.stack);
  process.exit(1);
}

console.log("\n✅ All validation tests passed!");
console.log("\n📝 Next steps:");
console.log("  1. Ensure APIFY_API_KEY is set in .env");
console.log("  2. Test with real scrapers: node linkedin_test.js");
console.log("  3. Run full integration test: node test_mcp.js");
