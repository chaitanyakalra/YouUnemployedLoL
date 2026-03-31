import { ApifyClient } from "apify-client";
import { Job } from "../db/schemas.js";
import { extractStr } from "../utils/extractStr.js";

const client = new ApifyClient({ token: process.env.APIFY_API_KEY });

// ─── curious_coder/linkedin-jobs-scraper output shape ─────────────────────────
// Confirmed field names from actor docs (2024-2025):
//   id, title, company, companyUrl, location, url, postedAt,
//   seniorityLevel, employmentType, description, skills[]
function normalizeLinkedInJob(raw) {
  const title    = extractStr(raw, "title", "jobTitle", "positionName", "name") || "Untitled";
  const company  = extractStr(raw, "company", "companyName", "companyTitle", "organizationName") || "Unknown";
  const location = extractStr(raw, "location", "jobLocation", "formattedLocation", "place");
  const workType = extractStr(raw, "workType", "workplaceType", "remoteAllowed");

  if (title === "Untitled" || company === "Unknown") {
    console.error("[LinkedIn Worker] ⚠️  normalization empty — raw keys:", Object.keys(raw));
    console.error("[LinkedIn Worker] raw sample:", JSON.stringify(raw, null, 2));
  }

  return {
    externalId:      raw.id || raw.url || raw.jobUrl || String(Math.random()),
    source:          "linkedin",
    title,
    company,
    companyLogo:     raw.companyLogo || raw.logo || null,
    companyWebsite:  null,
    location:        location || null,
    city:            null,
    country:         null,
    isRemote:        /remote/i.test(location) || /remote/i.test(workType),
    salaryMin:       raw.salaryMin || raw.salary?.min || null,
    salaryMax:       raw.salaryMax || raw.salary?.max || null,
    salaryCurrency:  "USD",
    salaryPeriod:    "yearly",
    employmentType:  extractStr(raw, "employmentType", "contractType", "jobType") || null,
    experienceLevel: (extractStr(raw, "seniorityLevel", "experienceLevel", "seniority") || null)?.toLowerCase() || null,
    department:      null,
    description:     extractStr(raw, "description", "descriptionText", "jobDescription") || null,
    skills:          Array.isArray(raw.skills) ? raw.skills : [],
    listingUrl:      extractStr(raw, "url", "jobUrl", "link", "applyUrl") || null,
    applyUrl:        extractStr(raw, "applyUrl", "url", "jobUrl", "link") || null,
    datePosted:      (raw.postedAt || raw.publishedAt || raw.datePosted || raw.listedAt)
                       ? new Date(raw.postedAt || raw.publishedAt || raw.datePosted || raw.listedAt)
                       : null,
    isActive:        true,
  };
}

export async function runLinkedInWorker(keywords = ["software engineer"]) {
  console.error(`[LinkedIn Worker] Starting — keywords: ${keywords.join(", ")}`);
  try {
    // Build LinkedIn search URLs for each keyword
    const urls = keywords.map(kw => ({
      url: `https://www.linkedin.com/jobs/search/?keywords=${encodeURIComponent(kw)}&f_TPR=r604800`
    }));

    const run = await client.actor("curious_coder/linkedin-jobs-scraper").call({
      urls,
      count: 50,
      scrapeCompany: false,
      timeout: 120,
      memory: 1024,
    });

    const { items } = await client.dataset(run.defaultDatasetId).listItems();
    console.error(`[LinkedIn Worker] Got ${items.length} jobs`);

    if (items?.length) {
      console.error("[LinkedIn Worker] raw item keys:", Object.keys(items[0]));
    }

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
    console.error(`[LinkedIn Worker] ⚠️ Failed: ${err.message}`);
    return { upserted: 0, error: err.message };
  }
}
