import { ApifyClient } from "apify-client";
import { Job } from "../db/schemas.js";
import { extractStr } from "../utils/extractStr.js";

const client = new ApifyClient({ token: process.env.APIFY_API_KEY });

function normalizeLinkedInJob(raw) {
  // worldunboxer/rapid-linkedin-scraper output shape — covers current and historical field names
  const title    = extractStr(raw, "title", "jobTitle", "positionName", "name") || "Untitled";
  const company  = extractStr(raw, "company", "companyName", "organizationName", "hiringOrganization") || "Unknown";
  const location = extractStr(raw, "location", "jobLocation", "place", "workLocation", "formattedLocation");
  const workType = extractStr(raw, "workType", "workplaceType", "remoteType", "workplaceTypes");

  return {
    externalId:      raw.id || raw.jobUrl || raw.url || String(Math.random()),
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
    experienceLevel: (extractStr(raw, "seniorityLevel", "experienceLevel", "seniority", "seniorityLevelText") || null)?.toLowerCase() || null,
    department:      null,
    description:     extractStr(raw, "description", "jobDescription", "descriptionHtml") || null,
    skills:          Array.isArray(raw.skills) ? raw.skills
                       : Array.isArray(raw.requiredSkills) ? raw.requiredSkills
                       : Array.isArray(raw.jobSkills) ? raw.jobSkills
                       : [],
    listingUrl:      extractStr(raw, "jobUrl", "url", "link") || null,
    applyUrl:        extractStr(raw, "applyUrl", "externalApplyUrl", "jobUrl", "url", "link") || null,
    datePosted:      (raw.postedAt || raw.publishedAt || raw.datePosted || raw.postedDate || raw.postedTime || raw.listedAt)
                       ? new Date(raw.postedAt || raw.publishedAt || raw.datePosted || raw.postedDate || raw.postedTime || raw.listedAt)
                       : null,
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

    // Diagnostic: log raw field names of first item so schema changes are caught immediately
    if (items?.length) {
      console.error("[LinkedIn Worker] raw item keys:", Object.keys(items[0]));
      const sample = normalizeLinkedInJob(items[0]);
      if (sample.title === "Untitled" || sample.company === "Unknown") {
        console.error("[LinkedIn Worker] ⚠️  title/company still empty after normalization — actor schema may have changed. First raw item:", JSON.stringify(items[0], null, 2));
      }
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
    // LinkedIn scraper can fail — log but don't crash
    console.error(`[LinkedIn Worker] ⚠️ Failed (non-critical): ${err.message}`);
    return { upserted: 0, error: err.message };
  }
}
