import crypto from "crypto";
import { Job } from "../db/schemas.js";
import { extractStr } from "../utils/extractStr.js";
import { callApifyActor } from "../utils/apify_utils.js";

function normalizeNaukriJob(raw) {
  const title    = extractStr(raw, "title", "job_title", "jobTitle", "designation") || "Untitled";
  const company  = extractStr(raw, "company", "company_name", "companyName", "companyId") || "Unknown";
  const location = Array.isArray(raw.locations) ? raw.locations.join(", ") : extractStr(raw, "location", "city", "jobLocation") || "India";

  return {
    externalId:      raw.jobId || raw.job_id || raw.url || crypto.createHash("md5").update(`${title}:${company}:${location}`).digest("hex"),
    source:          "naukri",
    title,
    company,
    companyLogo:     raw.companyLogo || null,
    companyWebsite:  null,
    location,
    city:            null,
    country:         "India",
    isRemote:        /remote/i.test(String(raw.workMode || raw.workplace_type || raw.is_remote || "")),
    salaryMin:       raw.salaryMin || null,
    salaryMax:       raw.salaryMax || null,
    salaryCurrency:  "INR",
    salaryPeriod:    "yearly",
    employmentType:  raw.jobType || raw.employment_type || null,
    experienceLevel: raw.experience || raw.seniority_level || null,
    department:      raw.department || null,
    description:     raw.description || raw.jobDescription || null,
    skills:          Array.isArray(raw.skills) ? raw.skills : Array.isArray(raw.keySkills) ? raw.keySkills : [],
    listingUrl:      raw.url || raw.jobUrl || raw.job_url || null,
    applyUrl:        raw.applyUrl || raw.url || null,
    datePosted:      raw.postedDate ? new Date(raw.postedDate) : null,
    isActive:        true,
  };
}

export async function runNaukriWorker(keywords = ["software developer", "data engineer", "product manager"]) {
  console.error(`[Naukri Worker] Starting — keywords: ${keywords.join(", ")}`);

  try {
    // Broad background search for Naukri (since it is the best India-specific direct source)
    const { items, error } = await callApifyActor("bebity/naukri-jobs-scraper", {
      keyword:  keywords.join(" "), 
      location: "India",
      maxItems: 100,
    }, { waitSecs: 90 });

    if (error) {
       console.error(`[Naukri Worker] Actor error: ${error}`);
       return { upserted: 0, error };
    }

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
