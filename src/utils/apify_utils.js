import { ApifyClient } from "apify-client";

const client = new ApifyClient({ token: process.env.APIFY_API_KEY });

/**
 * Hardened wrapper for calling Apify actors with strict input validation.
 * @param {string} actorId - The actor ID (e.g. "curious_coder/linkedin-jobs-scraper")
 * @param {object} input - The input payload
 * @param {object} options - call options (waitSecs, etc.)
 */
export async function callApifyActor(actorId, input, options = { waitSecs: 90 }) {
  if (!process.env.APIFY_API_KEY) {
    console.warn(`[Apify] ⚠️ APIFY_API_KEY missing. Skipping actor: ${actorId}`);
    return { items: [] };
  }

  // 1. Strict Input Normalization (Root Cause Fix for ERR_INVALID_URL)
  const cleanInput = JSON.parse(JSON.stringify(input)); // deep clone
  
  // LinkedIn/Naukri specific: urls must be string[] NOT {url}[]
  if (Array.isArray(cleanInput.urls)) {
    cleanInput.urls = cleanInput.urls.map(u => (typeof u === "object" ? u.url : u)).filter(Boolean);
  }

  console.error(`[Apify] → ${actorId} | Input: ${JSON.stringify(cleanInput)}`);

  try {
    const run = await client.actor(actorId).call(cleanInput, options);
    const { items } = await client.dataset(run.defaultDatasetId).listItems();
    
    const count = Array.isArray(items) ? items.length : 0;
    console.error(`[Apify] ✓ ${actorId} | Returned ${count} items`);
    return { items: Array.isArray(items) ? items : [], runId: run.id };
  } catch (err) {
    console.error(`[Apify] ✗ ${actorId} failed: ${err.message}`);
    // Check for specific Apify errors
    if (err.message.includes("Invalid URL")) {
       console.error(`[Apify] 🛑 FATAL: Input was still rejected as invalid URL. Payload: ${JSON.stringify(cleanInput)}`);
    }
    return { items: [], error: err.message };
  }
}
