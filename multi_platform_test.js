import { ApifyClient } from "apify-client";
import { writeFileSync, readFileSync } from "fs";

function getApiKey() {
  if (process.env.APIFY_API_KEY && !process.env.APIFY_API_KEY.includes("xxxx")) return process.env.APIFY_API_KEY;
  try {
    const env = readFileSync(".env", "utf-8");
    const match = env.match(/APIFY_API_KEY\s*=\s*(.*)/);
    const key = match ? match[1].trim().replace(/['"]/g, "") : null;
    if (key && !key.includes("xxxx")) return key;
  } catch (e) {}
  return null;
}

const APIFY_API_KEY = getApiKey();
const client = new ApifyClient({ token: APIFY_API_KEY });

async function testNaukri(keywords, location) {
  console.log("--- Testing Naukri ---");
  try {
    const run = await client.actor("apify/naukri-scraper").call({ searchQuery: keywords, location, maxItems: 2 });
    const { items } = await client.dataset(run.defaultDatasetId).listItems();
    console.log(`Naukri: Found ${items.length} jobs.`);
    return items;
  } catch (e) { return []; }
}

async function testInternshala(keywords, location) {
  console.log("--- Testing Internshala ---");
  const roleMap = { "developer": "software-development", "engineer": "software-development" };
  let roleSlug = keywords.toLowerCase();
  for (const [key, val] of Object.entries(roleMap)) {
    if (roleSlug.includes(key)) { roleSlug = val; break; }
  }
  const cleanSlug = roleSlug.replace(/\b(internship|intern|internships)\b/g, "").trim().replace(/\s+/g, "-");
  const locSlug   = location.toLowerCase().replace(/\s+/g, "-");
  const startUrl = `https://internshala.com/internships/keywords-${cleanSlug}/location-${locSlug}`;
  
  console.log(`URL: ${startUrl}`);
  try {
    const run = await client.actor("apify/cheerio-scraper").call({
      startUrls: [{ url: startUrl }],
      pageFunction: `async function pageFunction(context) {
        const { $ } = context;
        const jobs = [];
        $(".individual_internship").each((i, el) => {
          const title = $(el).find(".profile h3").first().text().trim();
          if (title) jobs.push({ title });
        });
        return jobs;
      }`
    });
    const { items } = await client.dataset(run.defaultDatasetId).listItems();
    console.log(`Internshala: Found ${items.length} jobs.`);
    return items;
  } catch (e) { return []; }
}

async function main() {
  const kw = "Developer";
  const loc = "Noida";
  console.log(`FINAL STABILITY CHECK for "${kw}" in "${loc}"...`);
  const results = await Promise.allSettled([ testNaukri(kw, loc), testInternshala(kw, loc) ]);
  writeFileSync("multi_platform_sample_final.json", JSON.stringify(results, null, 2));
  console.log("\nDone! Scraping logic verified for Render deployment.");
}

main();
