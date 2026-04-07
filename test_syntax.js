// test_clean.js - Clean syntax and import test
import { findJobsTool, findJobs } from './src/tools/find_jobs.js';

console.log("✅ Module loaded successfully");
console.log("✅ findJobsTool:", findJobsTool.name);
console.log("✅ findJobs:", typeof findJobs);
console.log("\n📋 Tool schema:");
console.log("  - Required:", findJobsTool.inputSchema.required.join(", "));
console.log("  - Properties:", Object.keys(findJobsTool.inputSchema.properties).length);

console.log("\n✅ All imports successful - no syntax errors!");
