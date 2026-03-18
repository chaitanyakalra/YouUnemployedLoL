import { ApifyClient } from "apify-client";
import { Job } from "../db/schemas.js";

const client = new ApifyClient({ token: process.env.APIFY_API_KEY });

function normalizeLinkedInJob(raw) {
  // worldunboxer/rapid-linkedin-scraper output shape
  return {
    externalId:      raw.id || raw.jobUrl || String(Math.random()),
    source:          "linkedin",
    title:           raw.title || raw.jobTitle || "Untitled",
    company:         raw.company || raw.companyName || "Unknown",
    companyLogo:     raw.companyLogo || null,
    companyWebsite:  null,
    location:        raw.location || null,
    city:            null,
    country:         null,
    isRemote:        (raw.workType || "").toLowerCase().includes("remote") ||
                     (raw.location || "").toLowerCase().includes("remote"),
    salaryMin:       raw.salaryMin || null,
    salaryMax:       raw.salaryMax || null,
    salaryCurrency:  "USD",
    salaryPeriod:    "yearly",
    employmentType:  raw.employmentType || null,
    experienceLevel: raw.seniorityLevel?.toLowerCase() || null,
    department:      null,
    description:     raw.description || raw.jobDescription || null,
    skills:          Array.isArray(raw.skills) ? raw.skills : [],
    listingUrl:      raw.jobUrl || null,
    applyUrl:        raw.applyUrl || raw.jobUrl || null,
    datePosted:      raw.postedAt ? new Date(raw.postedAt) : null,
    isActive:        true,
  };
}

export async function runLinkedInWorker(keywords = ["software engineer", "product manager"]) {
  console.error(`[LinkedIn Worker] Starting — keywords: ${keywords.join(", ")}`);

  try {
    const run = await client.actor("worldunboxer/rapid-linkedin-scraper").call({
      keywords,
      location: "",        // global
      datePosted: "past-week",
      resultsPerPage: 50,
    });

    const { items } = await client.dataset(run.defaultDatasetId).listItems();
    console.error(`[LinkedIn Worker] Got ${items.length} jobs`);

    let upserted = 0;
    for (const raw of items) {
      const job = normalizeLinkedInJob(raw);
      await Job.findOneAndUpdate(
        { source: "linkedin", externalId: job.externalId },
        { $set: job },
        { upsert: true, new: true }
      );
      upserted++;
    }

    console.error(`[LinkedIn Worker] ✅ Upserted ${upserted} jobs`);
    return { upserted };
  } catch (err) {
    // LinkedIn scraper can fail — log but don't crash
    console.error(`[LinkedIn Worker] ⚠️ Failed (non-critical): ${err.message}`);
    return { upserted: 0, error: err.message };
  }
}
