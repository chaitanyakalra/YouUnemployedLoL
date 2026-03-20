import { ApifyClient } from "apify-client";
import { Job } from "../db/schemas.js";

const client = new ApifyClient({ token: process.env.APIFY_API_KEY });

function normalizeNaukriJob(raw) {
  return {
    externalId:      raw.jobId || raw.url || String(Math.random()),
    source:          "naukri",
    title:           raw.title || raw.jobTitle || "Untitled",
    company:         raw.company || raw.companyName || "Unknown",
    companyLogo:     raw.companyLogo || null,
    companyWebsite:  null,
    location:        Array.isArray(raw.locations) ? raw.locations.join(", ") : raw.location || null,
    city:            null,
    country:         "India",
    isRemote:        (raw.workMode || "").toLowerCase().includes("remote"),
    salaryMin:       raw.salaryMin || null,
    salaryMax:       raw.salaryMax || null,
    salaryCurrency:  "INR",
    salaryPeriod:    "yearly",
    employmentType:  raw.jobType || null,
    experienceLevel: raw.experience || null,
    department:      raw.department || null,
    description:     raw.description || raw.jobDescription || null,
    skills:          Array.isArray(raw.skills) ? raw.skills : [],
    listingUrl:      raw.url || raw.jobUrl || null,
    applyUrl:        raw.applyUrl || raw.url || null,
    datePosted:      raw.postedDate ? new Date(raw.postedDate) : null,
    isActive:        true,
  };
}

export async function runNaukriWorker(keywords = ["software developer", "data engineer", "product manager"]) {
  console.error(`[Naukri Worker] Starting — keywords: ${keywords.join(", ")}`);

  try {
    const run = await client.actor("stealth_mode/naukri-jobs-search-scraper").call({
      keywords,
      location: "",
      maxResults: 100,
    });

    const { items } = await client.dataset(run.defaultDatasetId).listItems();
    console.error(`[Naukri Worker] Got ${items.length} jobs`);

    let upserted = 0;
    for (const raw of items) {
      const job = normalizeNaukriJob(raw);
      await Job.findOneAndUpdate(
        { source: "naukri", externalId: job.externalId },
        { $set: job },
        { upsert: true, new: true }
      );
      upserted++;
    }

    console.error(`[Naukri Worker] ✅ Upserted ${upserted} jobs`);
    return { upserted };
  } catch (err) {
    console.error(`[Naukri Worker] ⚠️ Failed (non-critical): ${err.message}`);
    return { upserted: 0, error: err.message };
  }
}
