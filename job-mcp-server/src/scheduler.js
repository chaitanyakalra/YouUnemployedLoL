import cron from "node-cron";
import { connectDB } from "./db/connect.js";
import { runAtsWorker } from "./workers/ats_worker.js";
import { runLinkedInWorker } from "./workers/linkedin_worker.js";
import { runNaukriWorker } from "./workers/naukri_worker.js";

const DEFAULT_QUERIES = [
  "software engineer",
  "backend developer",
  "frontend developer",
  "full stack developer",
  "data scientist",
  "data engineer",
  "product manager",
  "devops engineer",
  "machine learning engineer",
  "mobile developer",
];

async function runAllWorkers() {
  console.error(`\n🔄 [Scheduler] Starting worker run at ${new Date().toISOString()}`);

  await connectDB();

  const results = { ats: null, linkedin: null, naukri: null };

  // 1. ATS (stable base — runs first, most reliable)
  try {
    results.ats = await runAtsWorker(DEFAULT_QUERIES);
  } catch (err) {
    console.error("[Scheduler] ATS worker failed:", err.message);
  }

  // 2. LinkedIn (extra coverage — may fail, non-critical)
  try {
    results.linkedin = await runLinkedInWorker(DEFAULT_QUERIES.slice(0, 5));
  } catch (err) {
    console.error("[Scheduler] LinkedIn worker failed (non-critical):", err.message);
  }

  // 3. Naukri (India coverage)
  try {
    results.naukri = await runNaukriWorker(DEFAULT_QUERIES.slice(0, 5));
  } catch (err) {
    console.error("[Scheduler] Naukri worker failed (non-critical):", err.message);
  }

  console.error(`✅ [Scheduler] Run complete:`, JSON.stringify(results, null, 2));
}

// Run immediately on startup, then every 6 hours
async function start() {
  console.error("🚀 [Scheduler] Starting job scraper scheduler");

  // First run immediately
  await runAllWorkers();

  // Then every 6 hours: "0 */6 * * *"
  cron.schedule("0 */6 * * *", async () => {
    await runAllWorkers();
  });

  console.error("📅 [Scheduler] Scheduled to run every 6 hours");
}

start().catch((err) => {
  console.error("Fatal scheduler error:", err);
  process.exit(1);
});
