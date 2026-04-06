import crypto from "crypto";
import { ApifyClient } from "apify-client";
import { Job } from "../db/schemas.js";

const client = new ApifyClient({ token: process.env.APIFY_API_KEY });

// Normalize a job from jobo.world/ats-jobs-search into our schema
function normalizeAtsJob(raw) {
  const title = raw.title || "Untitled";
  const company = raw.company?.name || raw.company || "Unknown";
  return {
    externalId:      raw.id || raw.listing_url || crypto.createHash("md5").update(`${title}:${company}`).digest("hex"),
    source:          raw.source || "ats",
    title:           raw.title || "Untitled",
    company:         raw.company?.name || raw.company || "Unknown",
    companyLogo:     raw.company?.logo_url || null,
    companyWebsite:  raw.company?.website || null,
    location:        raw.locations?.[0]
                       ? [raw.locations[0].city, raw.locations[0].state, raw.locations[0].country]
                           .filter(Boolean).join(", ")
                       : null,
    city:            raw.locations?.[0]?.city || null,
    country:         raw.locations?.[0]?.country || null,
    isRemote:        raw.locations?.[0]?.is_remote || raw.is_remote || false,
    salaryMin:       raw.compensation?.min || null,
    salaryMax:       raw.compensation?.max || null,
    salaryCurrency:  raw.compensation?.currency || "USD",
    salaryPeriod:    raw.compensation?.period || "yearly",
    employmentType:  raw.employment_type || null,
    experienceLevel: raw.experience_level || null,
    department:      raw.department || null,
    description:     raw.description || null,
    skills:          raw.skills || [],
    listingUrl:      raw.listing_url || null,
    applyUrl:        raw.apply_url || raw.listing_url || null,
    datePosted:      raw.date_posted ? new Date(raw.date_posted) : null,
    isActive:        true,
  };
}

export async function runAtsWorker(queries = ["software engineer", "product manager", "data scientist"]) {
  console.error(`[ATS Worker] Starting — queries: ${queries.join(", ")}`);

  try {
    const run = await client.actor("jobo.world/ats-jobs-search").call({
      queries,
      is_remote: false,  // fetch all, we'll store remote flag per job
      page_size: 100,
      // sources: all 13 by default
    });

    const { items } = await client.dataset(run.defaultDatasetId).listItems();
    console.error(`[ATS Worker] Got ${items.length} jobs from 13 ATS platforms`);

    let upserted = 0;
    for (const raw of items) {
      const job = normalizeAtsJob(raw);
      await Job.findOneAndUpdate(
        { source: job.source, externalId: job.externalId },
        { $set: job },
        { upsert: true, new: true }
      );
      upserted++;
    }

    // Mark jobs not seen in this run as inactive (older than 2 days)
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    const deactivated = await Job.updateMany(
      { source: { $in: ["greenhouse","lever","workday","ashby","smartrecruiters","workable","bamboohr"] }, dateScraped: { $lt: twoDaysAgo } },
      { $set: { isActive: false } }
    );

    console.error(`[ATS Worker] ✅ Upserted ${upserted} jobs. Deactivated ${deactivated.modifiedCount} stale jobs.`);
    return { upserted, deactivated: deactivated.modifiedCount };
  } catch (err) {
    console.error(`[ATS Worker] ❌ Error: ${err.message}`);
    throw err;
  }
}
