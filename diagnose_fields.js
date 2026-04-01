// diagnose_fields.js — Inspect the ACTUAL field names returned by the LinkedIn scraper
import { ApifyClient } from "apify-client";

const API_KEY = process.env.APIFY_API_KEY;
if (!API_KEY) { console.log("Set APIFY_API_KEY first"); process.exit(1); }

const client = new ApifyClient({ token: API_KEY });

async function main() {
  console.log("Starting diagnostic scrape (3 results only)...\n");

  const run = await client.actor("worldunboxer/rapid-linkedin-scraper").call({
    keywords: ["React Developer"],
    location: "Bangalore",
    datePosted: "past-week",
    resultsPerPage: 3,
    proxy: { useApifyProxy: true },
  }, { waitSecs: 90 });

  const { items } = await client.dataset(run.defaultDatasetId).listItems();

  console.log(`Got ${items.length} items.\n`);

  // Print ALL field names from the first item
  if (items.length > 0) {
    console.log("=== ALL FIELD NAMES IN FIRST ITEM ===");
    const keys = Object.keys(items[0]);
    for (const key of keys) {
      const val = items[0][key];
      const preview = typeof val === "object" ? JSON.stringify(val)?.slice(0, 100) : String(val).slice(0, 100);
      console.log(`  ${key}: ${preview}`);
    }

    console.log("\n=== RAW FIRST 2 ITEMS (FULL JSON) ===");
    for (let i = 0; i < Math.min(2, items.length); i++) {
      console.log(`\n--- Item ${i + 1} ---`);
      console.log(JSON.stringify(items[i], null, 2));
    }
  }
}

main().catch(e => console.error("Error:", e.message));
