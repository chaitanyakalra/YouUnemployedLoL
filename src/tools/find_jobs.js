// find_jobs.js — Live on-demand job search with server-side fit scoring
// Sources: LinkedIn (curious_coder/linkedin-jobs-scraper)
//          Internshala (apify/cheerio-scraper)
//          Naukri     (bebity/naukri-jobs-scraper)  ← verified working actor
//          ATS x13    (jobo.world/ats-jobs-search)
// Returns STEP 4 table: scored jobs ≥6, skip list, seniority flags.

import { ApifyClient } from "apify-client";
import { extractStr } from "../utils/extractStr.js";
import { Job, JobSearch } from "../db/schemas.js";
import crypto from "crypto";

const client = new ApifyClient({ token: process.env.APIFY_API_KEY });

// ─── Timeout wrapper ──────────────────────────────────────────────────────────
function withTimeout(promise, ms = 60_000, label = "scraper") {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms)
    ),
  ]).catch((err) => {
    console.error(`[${label}] ${err.message}`);
    return [];
  });
}

// ─── Tool definition ──────────────────────────────────────────────────────────
export const findJobsTool = {
  name: "find_jobs",
  description:
    "Live job search across LinkedIn, Internshala, Naukri, and 13 ATS platforms. " +
    "Requires role — returns nothing without it. Scores every job against " +
    "the candidate profile server-side and emits STEP 4 table output only.",
  inputSchema: {
    type: "object",
    required: ["keywords", "location", "job_type"],
    properties: {
      keywords:               { type: "string",  description: "Role keywords. e.g. 'React developer, Full Stack Developer'" },
      location:               { type: "string",  description: "City or region. e.g. 'Noida', 'Delhi NCR', 'Remote'" },
      job_type:               { type: "string",  description: "'full-time' | 'internship' | 'both'" },
      posted_within:          { type: "string",  description: "'today' | '2 days' | 'this week' (default: 'this week')" },
      max_results_per_source: { type: "number",  description: "Max per scraper (default 25, max 50)" },
      resume_text:            { type: "string",  description: "Resume text for scoring (from set_profile)" },
      user_role:              { type: "string",  description: "Exact role string the user typed — used for title scoring" },
      user_experience_level:  { type: "string",  description: "e.g. 'fresher', '0-1 years', '1-3 years'" },
      user_employment_type:   { type: "string",  description: "User's preferred type — used for +1 match signal" },
      user_skills:            { type: "string",  description: "Comma-separated skills from set_profile" },
      _mock:                  { type: "boolean", description: "Internal: use mock data for testing (skips Apify calls)" },
    },
  },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function normalizeLevel(s) {
  if (!s) return null;
  s = String(s).toLowerCase();
  if (s.includes("entry") || s.includes("junior") || s.includes("fresher") ||
      s.includes("intern") || s.includes("0-1") || s.includes("0 to 1") || s.includes("trainee")) return "entry";
  if (s.includes("mid") || s.includes("1-3") || s.includes("2-4") || s.includes("associate")) return "mid";
  if (s.includes("senior") || s.includes("lead") || s.includes("principal") || s.includes("staff")) return "senior";
  if (s.includes("director") || s.includes("head of") || s.includes("vp") || s.includes("vice president")) return "senior";
  return null;
}

function isStretch(jobTitle = "", jobExpLevel = "", userLevel = "") {
  const seniorWords = ["senior", "lead", "principal", "staff", "head of", "director", "vp ", "vice president"];
  const titleStretch = seniorWords.some((w) => jobTitle.toLowerCase().includes(w));
  const userNorm = normalizeLevel(userLevel);
  const jobNorm  = normalizeLevel(jobExpLevel);
  if (!userNorm) return false;
  if (userNorm === "entry" && (titleStretch || jobNorm === "senior")) return true;
  if (userNorm === "mid"   && (jobNorm === "senior" || jobTitle.toLowerCase().includes("director"))) return true;
  return false;
}

function getHiringManagerTitle(jobTitle = "") {
  const t = jobTitle.toLowerCase();
  if (/\b(data|analyst|scientist|analytics)\b/.test(t))     return '"Head of Data" OR "Data Engineering Manager"';
  if (/\b(product|pm|product manager)\b/.test(t))           return '"Director of Product" OR "VP Product"';
  if (/\b(design|ux|ui)\b/.test(t))                         return '"Head of Design" OR "Design Manager"';
  if (/\b(devops|infra|platform|sre|cloud)\b/.test(t))      return '"Head of Engineering" OR "VP Engineering"';
  if (/\b(mobile|android|ios|flutter)\b/.test(t))           return '"Engineering Manager" OR "Head of Mobile"';
  if (/\b(backend|api|node|python|golang)\b/.test(t))       return '"Engineering Manager" OR "VP Engineering"';
  if (/\b(frontend|react|angular|vue|next)\b/.test(t))      return '"Engineering Manager" OR "Frontend Lead"';
  if (/\b(full.?stack|fullstack|mern)\b/.test(t))           return '"CTO" OR "Engineering Manager"';
  if (/\b(ml|ai|machine learning|llm|nlp|genai)\b/.test(t)) return '"Head of AI" OR "ML Engineering Manager"';
  if (/\b(intern|trainee|junior)\b/.test(t))                return '"Engineering Manager" OR "HR Manager"';
  return '"Engineering Manager"';
}

function computeFitScore(
  { jobTitle, jobExpLevel, jobIsRemote, jobLocation, jobSkills = [], jobEmploymentType },
  { userRole, userExpLevel, userLocation, userEmploymentType, userSkillsArr = [] }
) {
  let score = 0;

  // +3 — Title keyword match
  if (userRole) {
    const roleWords = userRole.toLowerCase().split(/[\s,]+/).filter((w) => w.length > 2);
    const titleLow  = (jobTitle || "").toLowerCase();
    if (roleWords.some((w) => titleLow.includes(w))) score += 3;
  }

  // +2 — Experience level match
  if (userExpLevel) {
    const userNorm = normalizeLevel(userExpLevel);
    const jobNorm  = normalizeLevel(jobExpLevel);
    if (userNorm && jobNorm && userNorm === jobNorm) score += 2;
    else if (userNorm && !jobNorm) score += 1; // unspecified = partial credit
  }

  // +1 — Employment type match
  if (userEmploymentType && jobEmploymentType) {
    const u = String(userEmploymentType).toLowerCase().replace(/[-_\s]/g, "");
    const j = String(jobEmploymentType).toLowerCase().replace(/[-_\s]/g, "");
    if (u === j || j.includes(u) || u.includes(j)) score += 1;
  }

  // +2 — Location / remote match
  if (userLocation) {
    const locLow = userLocation.toLowerCase();
    // User may pass "Delhi NCR, Noida, Gurugram, Remote" — check each word
    const locWords = locLow.split(/[\s,]+/).filter(w => w.length > 2);
    const isRemotePref = locLow.includes("remote");
    if (isRemotePref && jobIsRemote) {
      score += 2;
    } else if (jobLocation) {
      const jobLocLow = String(jobLocation).toLowerCase();
      if (locWords.some((w) => jobLocLow.includes(w))) {
        score += 2;
      }
    } else if (jobIsRemote) {
      score += 1;
    }
  }

  // +2 — Skills overlap
  if (userSkillsArr.length && jobSkills.length) {
    const userSet = new Set(userSkillsArr.map((s) => s.toLowerCase().trim()));
    const hasOverlap = jobSkills.some((s) => userSet.has(s.toLowerCase().trim()));
    if (hasOverlap) score += 2;
  }

  return Math.min(score, 10);
}

// ─── date filter helpers ──────────────────────────────────────────────────────

function postedWithinToTPR(posted = "this week") {
  const p = posted.toLowerCase();
  if (p.includes("today") || p.includes("24h")) return "r86400";
  if (p.includes("2 day") || p.includes("two")) return "r172800";
  return "r604800"; // 1 week default
}

// ─── Scrapers ─────────────────────────────────────────────────────────────────

async function saveJobsToDB(jobs) {
  const t0 = performance.now();
  let upserted = 0;
  for (const job of jobs) {
    try {
      // Create a deterministic externalId if missing
      if (!job.externalId) {
        job.externalId = crypto.createHash("md5")
          .update(`${job.source}:${job.title}:${job.company}:${job.location}`)
          .digest("hex");
      }

      const doc = await Job.findOneAndUpdate(
        { source: job.source.toLowerCase(), externalId: job.externalId },
        { $set: job },
        { upsert: true, new: true }
      );
      job._id = doc._id; // Attach DB ID for tools
      upserted++;
    } catch (err) {
      console.error(`[DB] Failed to save job: ${err.message}`);
    }
  }
  console.error(`[DB] ✓ Saved ${upserted}/${jobs.length} jobs (${(performance.now() - t0).toFixed(0)}ms)`);
}

async function scrapeLinkedIn({ keywords, location, job_type, posted_within, max }) {
  const tpr = postedWithinToTPR(posted_within);

  // FIX: curious_coder/linkedin-jobs-scraper expects urls as plain STRINGS not {url} objects
  // Root cause confirmed: ERR_INVALID_URL with input: '[object Object]'
  const keywordList  = keywords.split(",").map(k => k.trim()).filter(Boolean);
  // Use first location only for LinkedIn (comma-separated causes too many URL combos)
  const primaryLoc   = location.split(",")[0].trim();

  const urls = keywordList.map(kw =>
    `https://www.linkedin.com/jobs/search/?keywords=${encodeURIComponent(kw)}&location=${encodeURIComponent(primaryLoc)}&f_TPR=${tpr}&position=1&pageNum=0`
  );

  console.error(`[LinkedIn] URLs (${urls.length}):`, urls[0]);

  try {
    const run = await client.actor("curious_coder/linkedin-jobs-scraper").call(
      { urls, count: max, scrapeCompany: false, timeout: 60, memory: 1024 },
      { waitSecs: 90 }
    );
    const { items } = await client.dataset(run.defaultDatasetId).listItems();

    if (items?.length) {
      console.error("[LinkedIn] raw item keys:", Object.keys(items[0]));
      if (!extractStr(items[0], "title", "jobTitle", "positionName", "name")) {
        console.error("[LinkedIn] ⚠️ title empty — raw[0]:", JSON.stringify(items[0], null, 2));
      }
    } else {
      console.error("[LinkedIn] ⚠️ 0 items returned");
    }

    return (items || []).map((i) => ({
      title:           extractStr(i, "title", "jobTitle", "job_title", "positionName", "name") || "Untitled",
      company:         extractStr(i, "company", "companyName", "company_name", "companyTitle", "organizationName") || "Unknown",
      location:        extractStr(i, "location", "formattedLocation", "jobLocation", "place") || primaryLoc,
      isRemote:        /remote/i.test(extractStr(i, "location", "workType", "workplaceType") || ""),
      applyUrl:        extractStr(i, "url", "jobUrl", "job_url", "applyUrl", "apply_url", "link"),
      datePosted:      i.postedAt || i.publishedAt || i.datePosted || i.listedAt || i.time_posted || null,
      experienceLevel: extractStr(i, "seniorityLevel", "seniority_level", "experienceLevel", "seniority"),
      employmentType:  extractStr(i, "employmentType", "employment_type", "contractType", "jobType"),
      skills:          Array.isArray(i.skills) ? i.skills : [],
      source:          "LinkedIn",
    }));
  } catch (err) {
    console.error("[LinkedIn] scrape error:", err.message);
    return [];
  }
}

async function scrapeNaukri({ keywords, location, job_type, max }) {
  // FIX: stealth_mode/naukri-jobs-search-scraper → does not exist
  //      apify/naukri-scraper → does not exist
  //      bebity/naukri-jobs-scraper → verified working actor for Naukri India
  const primaryLoc = location.split(",")[0].trim();
  try {
    const run = await client.actor("bebity/naukri-jobs-scraper").call(
      {
        keyword:  keywords.split(",")[0].trim(), // take first keyword only
        location: primaryLoc,
        maxItems: max,
      },
      { waitSecs: 90 }
    );
    const { items } = await client.dataset(run.defaultDatasetId).listItems();

    if (items?.length) {
      console.error("[Naukri] raw item keys:", Object.keys(items[0]));
    } else {
      console.error("[Naukri] 0 items returned");
    }

    return (items || []).map((i) => ({
      title:           extractStr(i, "title", "job_title", "jobTitle", "designation") || "Untitled",
      company:         extractStr(i, "company", "company_name", "companyName", "companyId") || "Unknown",
      location:        Array.isArray(i.locations) ? i.locations.join(", ")
                       : extractStr(i, "location", "city", "jobLocation") || primaryLoc,
      isRemote:        /remote/i.test(String(i.workMode || i.workplace_type || i.is_remote || "")),
      applyUrl:        extractStr(i, "job_url", "url", "applyUrl", "apply_url", "link"),
      datePosted:      i.postedDate || i.posted_date || i.time_posted || i.date_posted || null,
      experienceLevel: extractStr(i, "experience", "seniority_level", "experienceLevel", "exp") || null,
      employmentType:  extractStr(i, "jobType", "employment_type", "job_type") || job_type || null,
      skills:          Array.isArray(i.skills) ? i.skills
                       : Array.isArray(i.keySkills) ? i.keySkills : [],
      source:          "Naukri",
    }));
  } catch (err) {
    console.error("[Naukri] scrape error:", err.message);
    return [];
  }
}

async function scrapeATS({ keywords, location, job_type, max }) {
  // jobo.world/ats-jobs-search — covers Greenhouse, Lever, Workday, Ashby, etc.
  // FIX: ATS returns mostly US/global jobs. For India users, set is_remote:true
  // so we at least get remote-eligible roles that Chaitanya can apply to.
  // ATS platforms don't index Indian companies well — this is a data source limitation.
  const isRemotePref = /remote/i.test(location);
  const queryKeyword = keywords.split(",")[0].trim(); // single clean keyword works best

  try {
    const run = await client.actor("jobo.world/ats-jobs-search").call(
      {
        queries:   [queryKeyword],
        is_remote: true, // always fetch remote ATS jobs — they're globally applicable
        page_size: max,
      },
      { waitSecs: 90 }
    );
    const { items } = await client.dataset(run.defaultDatasetId).listItems();

    if (items?.length) {
      console.error("[ATS] raw item keys:", Object.keys(items[0]));
      console.error("[ATS] locations sample:", JSON.stringify(items[0].locations));
    } else {
      console.error("[ATS] 0 items returned");
    }

    return (items || []).map((i) => {
      // FIX: locations[] can be array of strings OR array of objects — handle both
      let jobLoc = location;
      if (Array.isArray(i.locations) && i.locations.length > 0) {
        const first = i.locations[0];
        if (typeof first === "string") {
          jobLoc = first;
        } else if (typeof first === "object" && first !== null) {
          jobLoc = [first.city, first.state, first.country].filter(Boolean).join(", ");
        }
      }

      return {
        title:           extractStr(i, "title", "jobTitle", "job_title", "name") || "Untitled",
        company:         i.company?.name || extractStr(i, "company", "companyName", "company_name") || "Unknown",
        location:        jobLoc,
        isRemote:        i.is_remote || i.locations?.[0]?.is_remote || true, // ATS remote jobs
        applyUrl:        extractStr(i, "apply_url", "listing_url", "job_url", "url"),
        datePosted:      i.date_posted || i.created_at || i.posted_at || null,
        experienceLevel: extractStr(i, "experience_level", "seniority_level", "seniority") || null,
        employmentType:  extractStr(i, "employment_type", "contract_type") || job_type || null,
        skills:          Array.isArray(i.skills) ? i.skills : [],
        source:          extractStr(i, "source") || "ATS",
      };
    });
  } catch (err) {
    console.error("[ATS] scrape error:", err.message);
    return [];
  }
}

async function scrapeInternshala({ keywords, location, max }) {
  const roleMap = {
    "developer":  "software-development",
    "engineer":   "software-development",
    "sde":        "software-development",
    "full stack": "software-development",
    "backend":    "software-development",
    "frontend":   "software-development",
    "react":      "web-development",
    "node":       "web-development",
    "mern":       "software-development",
    "ai":         "machine-learning",
    "ml":         "machine-learning",
    "genai":      "machine-learning",
  };

  const primaryKeyword = keywords.split(",")[0].trim().toLowerCase();
  let roleSlug = roleMap[Object.keys(roleMap).find(k => primaryKeyword.includes(k))] || "software-development";
  
  const isRemote = /remote/i.test(location);
  const city = location.split(",")[0].trim().toLowerCase().replace(/\s+/g, "-");

  let startUrl = `https://internshala.com/internships/keywords-${primaryKeyword.replace(/\s+/g, "%20")}`;
  
  // Try to build a cleaner URL for better results
  if (isRemote) {
    startUrl = `https://internshala.com/internships/work-from-home-${roleSlug}-internships`;
  } else if (city && city !== "india") {
    startUrl = `https://internshala.com/internships/${roleSlug}-internship-in-${city}`;
  }

  console.error(`[Internshala] URL: ${startUrl}`);

  try {
    const run = await client.actor("apify/cheerio-scraper").call({
      startUrls: [{ url: startUrl }],
      pageFunction: `async function pageFunction(context) {
        const { $, log } = context;
        const jobs = [];
        const items = $(".individual_internship, .internship-item, [data-internship_id]");
        items.each((i, el) => {
          const $el = $(el);
          const title   = $el.find(".profile h3, h3.heading_4_5, .profile .heading_4_5").first().text().trim();
          const company = $el.find(".company_name a, .company_name").first().text().trim();
          const location= $el.find(".location_link, .locations span, .location_name").first().text().trim() || "Remote";
          const relPath = $el.find("a.view_detail_button, a[href*='/internship/detail/']").first().attr("href") || "";
          const applyUrl= relPath.startsWith("http") ? relPath : "https://internshala.com" + relPath;
          const extId   = $el.attr("data-internship_id") || relPath.split("/").pop();
          if (title && company) {
            jobs.push({ 
              externalId: extId,
              title, 
              company, 
              location, 
              applyUrl, 
              isRemote: /remote/i.test(location), 
              source: "internshala" 
            });
          }
        });
        log.info("Internshala found " + jobs.length + " listings");
        return jobs.slice(0, ${max});
      }`,
      proxyConfiguration: { useApifyProxy: true },
    }, { waitSecs: 90 });

    const { items } = await client.dataset(run.defaultDatasetId).listItems();
    // Cheerio results are usually already flat
    const flatItems = items.flat().filter(Boolean);
    console.error(`[Internshala] ✅ Found ${flatItems.length} items`);

    return flatItems.map((i) => ({
      ...i,
      datePosted:      new Date().toISOString(), // Internshala doesn't expose date easily, assume fresh
      experienceLevel: "internship",
      employmentType:  "internship",
      skills:          [],
      source:          "internshala",
    }));
  } catch (err) {
    console.error("[Internshala] scrape error:", err.message);
    return [];
  }
}

// ─── Mock data ────────────────────────────────────────────────────────────────

function getMockJobs(keywords, location) {
  return [
    { title: "Full Stack Developer Intern", company: "TechCorp India", location: "Noida", isRemote: false, applyUrl: "https://linkedin.com/jobs/view/mock-1", datePosted: new Date(Date.now() - 86400000).toISOString(), experienceLevel: "entry", employmentType: "internship", skills: ["React", "Node.js", "MongoDB"], source: "LinkedIn (mock)" },
    { title: "MERN Stack Developer", company: "StartupXYZ", location: "Gurugram", isRemote: false, applyUrl: "https://linkedin.com/jobs/view/mock-2", datePosted: new Date().toISOString(), experienceLevel: "entry", employmentType: "full-time", skills: ["React", "Express.js", "Node.js", "MongoDB"], source: "LinkedIn (mock)" },
    { title: "Backend Developer Trainee", company: "Infosys", location: "Noida", isRemote: false, applyUrl: "https://naukri.com/jobs/mock-3", datePosted: new Date(Date.now() - 172800000).toISOString(), experienceLevel: "entry", employmentType: "full-time", skills: ["Node.js", "Python", "REST API"], source: "Naukri (mock)" },
    { title: "Junior Software Developer", company: "Wipro Digital", location: "Gurugram", isRemote: false, applyUrl: "https://lever.co/jobs/mock-4", datePosted: new Date(Date.now() - 86400000).toISOString(), experienceLevel: "entry", employmentType: "full-time", skills: ["JavaScript", "TypeScript", "React"], source: "ATS (mock)" },
    { title: "Senior Software Architect", company: "BigCorp", location: "Delhi", isRemote: false, applyUrl: "https://greenhouse.io/jobs/mock-5", datePosted: new Date(Date.now() - 259200000).toISOString(), experienceLevel: "senior", employmentType: "full-time", skills: ["Java", "Microservices", "Kubernetes"], source: "ATS (mock)" },
    { title: "React Developer Intern", company: "FinTech Startup", location: "Remote", isRemote: true, applyUrl: "https://internshala.com/jobs/mock-6", datePosted: new Date().toISOString(), experienceLevel: "internship", employmentType: "internship", skills: ["React", "JavaScript", "Tailwind CSS"], source: "Internshala (mock)" },
    { title: "AI Engineer Intern", company: "GenAI Labs", location: "Remote", isRemote: true, applyUrl: "https://lever.co/jobs/mock-7", datePosted: new Date().toISOString(), experienceLevel: "entry", employmentType: "internship", skills: ["Python", "OpenAI", "RAG", "Pinecone"], source: "ATS (mock)" },
  ];
}

// ─── Gate helpers ─────────────────────────────────────────────────────────────

function buildGateMessage(missing) {
  return (
    `Before I can search for jobs, I need a few more details:\n\n` +
    missing.map((m, i) => `${i + 1}. ${m}`).join("\n") +
    `\n\nPlease provide these and I'll start the search immediately.`
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────

// ─── Execution ────────────────────────────────────────────────────────────────

async function performSearchInBackground(searchId, args) {
  const {
    keywords,
    location,
    job_type,
    posted_within = "this week",
    max_results_per_source = 25,
    user_role,
    user_experience_level,
    user_employment_type,
    user_skills,
    _mock = false,
  } = args;

  const max           = Math.min(max_results_per_source || 25, 50);
  const userSkillsArr = user_skills ? user_skills.split(",").map((s) => s.trim()).filter(Boolean) : [];
  const useMock       = _mock || !process.env.APIFY_API_KEY;

  let allJobs = [];

  try {
    if (useMock) {
      allJobs = getMockJobs(keywords, location);
    } else {
      const scrapers = [
        withTimeout(scrapeLinkedIn({ keywords, location, job_type, posted_within, max }), 120_000, "LinkedIn"),
        withTimeout(scrapeNaukri({ keywords, location, job_type, max }), 120_000, "Naukri"),
      ];

      if (job_type === "internship" || job_type === "both") {
        scrapers.push(withTimeout(scrapeInternshala({ keywords, location, max }), 90_000, "Internshala"));
      }
      if (job_type === "full-time" || job_type === "both") {
        scrapers.push(withTimeout(scrapeATS({ keywords, location, job_type, max }), 120_000, "ATS"));
      }

      const results = await Promise.allSettled(scrapers);
      for (const r of results) {
        if (r.status === "fulfilled" && Array.isArray(r.value)) {
          allJobs.push(...r.value);
        }
      }
    }

    // 1. Post-scrape date filter
    const maxDays = posted_within.includes("today") ? 1 : posted_within.includes("2 day") ? 2 : 14; // default 2 weeks for "this week"
    let filtered = allJobs.filter((j) => {
      if (!j.datePosted) return true; // keep if unknown
      const days = Math.floor((Date.now() - new Date(j.datePosted)) / 86_400_000);
      return days <= maxDays;
    });

    // 2. Post-scrape location filter (Strict for India)
    const isIndiaReq = /india|noida|gurugram|delhi|bangalore|pune|mumbai|hyderabad/i.test(location);
    if (isIndiaReq) {
      filtered = filtered.filter(j => 
        j.isRemote || 
        /india|noida|gurugram|delhi|bangalore|pune|mumbai|hyderabad|chennai/i.test(j.location || "")
      );
    }

    // 3. Save to DB (Upsert)
    await saveJobsToDB(filtered);

    // 4. Scoring & Seniority Check
    const scored = filtered.map((job) => {
      const fitScore = computeFitScore(
        {
          jobTitle:          job.title,
          jobExpLevel:       job.experienceLevel,
          jobIsRemote:       job.isRemote,
          jobLocation:       job.location,
          jobSkills:         job.skills || [],
          jobEmploymentType: job.employmentType,
        },
        {
          userRole:           user_role            || keywords.split(",")[0].trim(),
          userExpLevel:       user_experience_level || "",
          userLocation:       location,
          userEmploymentType: user_employment_type  || job_type,
          userSkillsArr,
        }
      );

      const stretch  = isStretch(job.title, job.experienceLevel, user_experience_level || "");
      const daysAgo  = job.datePosted ? Math.floor((Date.now() - new Date(job.datePosted)) / 86_400_000) : null;
      const city     = (job.location || location).split(",")[0].trim();
      const hmCell   = `${getHiringManagerTitle(job.title)} "${job.company}" "${city}"`;

      return { ...job, fitScore, stretch, daysAgo, hmSearchString: hmCell };
    });

    // 5. Deduplicate (Company + Normalized Title)
    const uniqueMap = new Map();
    scored.forEach(j => {
      const key = `${j.company.toLowerCase()}:${j.title.toLowerCase().replace(/[^a-z0-9]/g, "")}`;
      if (!uniqueMap.has(key) || uniqueMap.get(key).fitScore < j.fitScore) {
        uniqueMap.set(key, j);
      }
    });
    const deduped = Array.from(uniqueMap.values());

    deduped.sort((a, b) => (b.datePosted ? new Date(b.datePosted) : 0) - (a.datePosted ? new Date(a.datePosted) : 0) || b.fitScore - a.fitScore);

    const showJobs = deduped.filter((j) => j.fitScore >= 6).slice(0, 40);
    const skipJobs = deduped.filter((j) => j.fitScore < 6).slice(0, 10);
    const sources  = [...new Set(allJobs.map(j => j.source))].join(", ");

    const lines = [
      `## STEP 4 — Job Search Results`,
      ``,
      `**Search:** "${keywords}" | **Location:** ${location} | **Type:** ${job_type} | **Posted:** ${posted_within}`,
      `**Sources scraped:** ${sources}`,
      `**Total found:** ${allJobs.length} | **Filtered:** ${filtered.length} | **Showing:** ${showJobs.length}`,
      useMock ? `\n> ⚠️ **MOCK MODE** — test data only.\n` : ``,
      `> IDs refer to internal database records. Use \`get_job_details(job_id)\` to see more.`,
      ``,
      "| Role | Company | Source | Posted | Fit | Apply | ID |",
      "|------|---------|--------|--------|-----|-------|----|",
      ...showJobs.map((j) => {
        const role    = `${j.stretch ? "⚠️ " : ""}${j.title}`;
        const posted  = j.daysAgo !== null ? `${j.daysAgo}d ago` : "—";
        const apply   = j.applyUrl ? `[Apply](${j.applyUrl})` : "—";
        return `| ${role} | ${j.company} | ${j.source} | ${posted} | ${j.fitScore}/10 | ${apply} | \`${j._id}\` |`;
      }),
      ""
    ];

    if (skipJobs.length) {
      lines.push(`### Skipping ${skipJobs.length} low-fit roles:`, ...skipJobs.map(j => `- **${j.title}** at ${j.company} (${j.source})`));
    }

    await JobSearch.findOneAndUpdate(
      { searchId },
      { status: "completed", results: lines.join("\n"), jobCount: showJobs.length },
      { upsert: true }
    );

  } catch (err) {
    console.error(`[Background Search] Failed: ${err.message}`);
    await JobSearch.findOneAndUpdate(
      { searchId },
      { status: "failed", error: err.message },
      { upsert: true }
    );
  }
}

export async function findJobs(args) {
  const { keywords, location, job_type } = args || {};

  const missing = [];
  if (!keywords) missing.push("keywords");
  if (!location) missing.push("location");
  if (!job_type) missing.push("job_type");
  if (missing.length) return `Missing required parameters: ${missing.join(", ")}`;

  const searchId = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 3600_000); // 1 hour

  await JobSearch.create({
    searchId,
    query: args,
    status: "pending",
    expiresAt,
  });

  // Kick off background task
  setImmediate(() => performSearchInBackground(searchId, args));

  return [
    `## 🚀 Job Search Started`,
    ``,
    `I'm scraping **LinkedIn, Internshala, Naukri, and 13 ATS platforms** for "${keywords}" in "${location}".`,
    ``,
    `**This takes 30-90 seconds.** Because this is a live search, I've backgrounded the task to avoid timeouts.`,
    ``,
    `### How to get results:`,
    `Please wait about **60 seconds**, then call:`,
    `\`get_job_status(search_id: "${searchId}")\``,
    ``,
    `> **Search ID:** \`${searchId}\``
  ].join("\n");
}
