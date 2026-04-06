import crypto from "crypto";
import { Job } from "../db/schemas.js";
import { extractStr } from "../utils/extractStr.js";
import { callApifyActor } from "../utils/apify_utils.js";

// ─── curious_coder/linkedin-jobs-scraper output shape ─────────────────────────
// Confirmed field names from actor docs (2024-2025):
//   id, title, company, companyUrl, location, url, postedAt,
//   seniorityLevel, employmentType, description, skills[]
function normalizeLinkedInJob(raw) {
  const title    = extractStr(raw, "title", "jobTitle", "job_title", "positionName", "name") || "Untitled";
  const company  = extractStr(raw, "company", "companyName", "company_name", "companyTitle", "organizationName") || "Unknown";
  const location = extractStr(raw, "location", "jobLocation", "formattedLocation", "place");
  const workType = extractStr(raw, "workType", "workplaceType", "remoteAllowed");

  if (title === "Untitled" || company === "Unknown") {
    console.error("[LinkedIn Worker] ⚠️  normalization empty — raw keys:", Object.keys(raw));
    console.error("[LinkedIn Worker] raw sample:", JSON.stringify(raw, null, 2));
  }

  return {
    externalId:      raw.id || raw.job_id || raw.url || raw.jobUrl || raw.job_url 
                     || crypto.createHash("md5").update(`${title}:${company}:${location}`).digest("hex"),
    source:          "linkedin",
    title,
    company,
    companyLogo:     raw.companyLogo || raw.company_logo_url || raw.logo || null,
    companyWebsite:  null,
    location:        location || null,
    city:            null,
    country:         null,
    isRemote:        /remote/i.test(location) || /remote/i.test(workType),
    salaryMin:       raw.salaryMin || raw.salary?.min || null,
    salaryMax:       raw.salaryMax || raw.salary?.max || null,
    salaryCurrency:  "USD",
    salaryPeriod:    "yearly",
    employmentType:  extractStr(raw, "employmentType", "employment_type", "contractType", "jobType") || null,
    experienceLevel: (extractStr(raw, "seniorityLevel", "seniority_level", "experienceLevel", "seniority") || null)?.toLowerCase() || null,
    department:      null,
    description:     extractStr(raw, "description", "descriptionText", "jobDescription") || null,
    skills:          Array.isArray(raw.skills) ? raw.skills : [],
    listingUrl:      extractStr(raw, "url", "jobUrl", "job_url", "link", "applyUrl", "apply_url") || null,
    applyUrl:        extractStr(raw, "applyUrl", "apply_url", "url", "jobUrl", "job_url", "link") || null,
    datePosted:      (raw.postedAt || raw.publishedAt || raw.datePosted || raw.listedAt || raw.time_posted)
                       ? new Date(raw.postedAt || raw.publishedAt || raw.datePosted || raw.listedAt || raw.time_posted)
                       : null,
    isActive:        true,
  };
}

export async function runLinkedInWorker(keywords = ["software engineer"]) {
  console.error(`[LinkedIn Worker] Starting — keywords: ${keywords.join(", ")}`);
  try {
    // Build LinkedIn search URLs for each keyword (plain string array as expected by actor)
    const urls = keywords.map(kw => 
      `https://www.linkedin.com/jobs/search/?keywords=${encodeURIComponent(kw)}&f_TPR=r604800`
    );

    const { items, error } = await callApifyActor("curious_coder/linkedin-jobs-scraper", {
      urls,
      count: 50,
      scrapeCompany: false,
    }, { waitSecs: 120 });

    if (error) {
      console.error(`[LinkedIn Worker] Actor error: ${error}`);
      return { upserted: 0, error };
    }

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
