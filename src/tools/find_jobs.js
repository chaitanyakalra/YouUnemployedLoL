// find_jobs.js — Live on-demand job search with server-side fit scoring
// Sources: LinkedIn (curious_coder/linkedin-jobs-scraper)
//          Internshala (apify/web-scraper)
//          Naukri     (stealth_mode/naukri-jobs-search-scraper)
//          ATS x13    (jobo.world/ats-jobs-search)
// Returns STEP 4 table: scored jobs ≥6, skip list, seniority flags.

import { ApifyClient } from "apify-client";
import { extractStr } from "../utils/extractStr.js";

const client = new ApifyClient({ token: process.env.APIFY_API_KEY });

// ─── Timeout wrapper — ensures no single scraper blocks beyond the limit ──────
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
      keywords:               { type: "string",  description: "Role keywords. e.g. 'React developer', 'Full Stack Developer'" },
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
  if (!s) return "";
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
  if (/\b(data|analyst|scientist|analytics)\b/.test(t))    return '"Head of Data" OR "Data Engineering Manager"';
  if (/\b(product|pm|product manager)\b/.test(t))          return '"Director of Product" OR "VP Product"';
  if (/\b(design|ux|ui)\b/.test(t))                        return '"Head of Design" OR "Design Manager"';
  if (/\b(devops|infra|platform|sre|cloud)\b/.test(t))     return '"Head of Engineering" OR "VP Engineering"';
  if (/\b(mobile|android|ios|flutter)\b/.test(t))          return '"Engineering Manager" OR "Head of Mobile"';
  if (/\b(backend|api|node|python|golang)\b/.test(t))      return '"Engineering Manager" OR "VP Engineering"';
  if (/\b(frontend|react|angular|vue|next)\b/.test(t))     return '"Engineering Manager" OR "Frontend Lead"';
  if (/\b(full.?stack|fullstack|mern)\b/.test(t))          return '"CTO" OR "Engineering Manager"';
  if (/\b(ml|ai|machine learning|llm|nlp|genai)\b/.test(t)) return '"Head of AI" OR "ML Engineering Manager"';
  if (/\b(intern|trainee|junior)\b/.test(t))               return '"Engineering Manager" OR "HR Manager"';
  return '"Engineering Manager"';
}

function computeFitScore(
  { jobTitle, jobExpLevel, jobIsRemote, jobLocation, jobSkills = [], jobEmploymentType },
  { userRole, userExpLevel, userLocation, userEmploymentType, userSkillsArr = [] }
) {
  let score = 0;

  // +3 — Title keyword match
  if (userRole) {
    const roleWords = userRole.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
    const titleLow  = (jobTitle || "Untitled").toLowerCase();
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
    const isRemotePref = locLow.includes("remote");
    if (isRemotePref && jobIsRemote) {
      score += 2;
    } else if (!isRemotePref && jobLocation) {
      const jobLocLow = String(jobLocation).toLowerCase();
      if (jobLocLow.includes(locLow) || locLow.split(/[\s,]+/).some((w) => w.length > 2 && jobLocLow.includes(w))) {
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
  if (p.includes("today") || p.includes("24h")) return "r86400";    // 24h
  if (p.includes("2 day") || p.includes("two")) return "r172800";   // 48h
  return "r604800";                                                  // 1 week (default)
}

// ─── Scrapers ─────────────────────────────────────────────────────────────────

async function scrapeLinkedIn({ keywords, location, job_type, posted_within, max }) {
  // Build one URL per keyword×location combo using the f_TPR filter
  // curious_coder/linkedin-jobs-scraper accepts { urls: [{url}], count, scrapeCompany }
  const tpr = postedWithinToTPR(posted_within);

  const keywordList = keywords.split(",").map(k => k.trim()).filter(Boolean);
  const locationList = location.split(",").map(l => l.trim()).filter(Boolean);

  const urls = keywordList.flatMap(kw =>
    locationList.map(loc => ({
      url: `https://www.linkedin.com/jobs/search/?keywords=${encodeURIComponent(kw)}&location=${encodeURIComponent(loc)}&f_TPR=${tpr}&position=1&pageNum=0`
    }))
  );

  try {
    const run = await client.actor("curious_coder/linkedin-jobs-scraper").call(
      { urls, count: max, scrapeCompany: false, timeout: 60, memory: 1024 },
      { waitSecs: 60 }
    );
    const { items } = await client.dataset(run.defaultDatasetId).listItems();

    // Log raw keys of first item to Render logs — helps detect future schema changes
    if (items?.length) {
      console.error("[LinkedIn] raw item keys:", Object.keys(items[0]));
      const sample = items[0];
      if (!extractStr(sample, "title", "jobTitle", "positionName")) {
        console.error("[LinkedIn] ⚠️ title empty — full first item:", JSON.stringify(sample, null, 2));
      }
    }

    return (items || []).map((i) => {
      const title    = extractStr(i, "title", "jobTitle", "job_title", "positionName", "name");
      const company  = extractStr(i, "company", "companyName", "company_name", "companyTitle", "organizationName");
      const loc      = extractStr(i, "location", "formattedLocation", "jobLocation", "place");
      const workType = extractStr(i, "workType", "workplaceType", "remoteAllowed");

      return {
        title:           title || "Untitled",
        company:         company || "Unknown",
        location:        loc || location,
        isRemote:        /remote/i.test(loc) || /remote/i.test(workType),
        applyUrl:        extractStr(i, "url", "jobUrl", "job_url", "applyUrl", "apply_url", "link"),
        datePosted:      i.postedAt || i.publishedAt || i.datePosted || i.listedAt || i.time_posted || null,
        experienceLevel: extractStr(i, "seniorityLevel", "seniority_level", "experienceLevel", "seniority"),
        employmentType:  extractStr(i, "employmentType", "employment_type", "contractType", "jobType"),
        skills:          Array.isArray(i.skills) ? i.skills : [],
        source:          "LinkedIn",
      };
    });
  } catch (err) {
    console.error("[LinkedIn] scrape error:", err.message);
    return [];
  }
}

async function scrapeNaukri({ keywords, location, job_type, max }) {
  // stealth_mode/naukri-jobs-search-scraper
  try {
    const run = await client.actor("stealth_mode/naukri-jobs-search-scraper").call(
      { keywords: [keywords], location, maxResults: max },
      { waitSecs: 60 }
    );
    const { items } = await client.dataset(run.defaultDatasetId).listItems();

    if (items?.length) {
      console.error("[Naukri] raw item keys:", Object.keys(items[0]));
    }

    return (items || []).map((i) => ({
      title:           i.title || i.jobTitle || "Untitled",
      company:         i.company || i.companyName || "Unknown",
      location:        Array.isArray(i.locations) ? i.locations.join(", ") : i.location || location,
      isRemote:        (i.workMode || "").toLowerCase().includes("remote"),
      applyUrl:        i.applyUrl || i.url || null,
      datePosted:      i.postedDate || null,
      experienceLevel: i.experience || null,
      employmentType:  i.jobType || job_type || null,
      skills:          Array.isArray(i.skills) ? i.skills : [],
      source:          "Naukri",
    }));
  } catch (err) {
    console.error("[Naukri] scrape error:", err.message);
    return [];
  }
}

async function scrapeATS({ keywords, location, job_type, max }) {
  // jobo.world/ats-jobs-search — covers Greenhouse, Lever, Workday, Ashby, etc.
  const isRemotePref = /remote/i.test(location);
  try {
    const run = await client.actor("jobo.world/ats-jobs-search").call(
      { queries: [keywords], is_remote: isRemotePref, page_size: max },
      { waitSecs: 60 }
    );
    const { items } = await client.dataset(run.defaultDatasetId).listItems();

    if (items?.length) {
      console.error("[ATS] raw item keys:", Object.keys(items[0]));
    }

    return (items || []).map((i) => ({
      title:           i.title || "Untitled",
      company:         i.company?.name || i.company || "Unknown",
      location:        i.locations?.[0]
                         ? [i.locations[0].city, i.locations[0].country].filter(Boolean).join(", ")
                         : location,
      isRemote:        i.locations?.[0]?.is_remote || i.is_remote || isRemotePref,
      applyUrl:        i.apply_url || i.listing_url || null,
      datePosted:      i.date_posted || null,
      experienceLevel: i.experience_level || null,
      employmentType:  i.employment_type || job_type || null,
      skills:          Array.isArray(i.skills) ? i.skills : [],
      source:          i.source || "ATS",
    }));
  } catch (err) {
    console.error("[ATS] scrape error:", err.message);
    return [];
  }
}

async function scrapeInternshala({ keywords, location, max }) {
  const slug    = encodeURIComponent(keywords.toLowerCase().replace(/\s+/g, "-"));
  const locSlug = encodeURIComponent(location.toLowerCase().replace(/\s+/g, "-"));
  const isRemote = /remote/i.test(location);
  const startUrl = isRemote
    ? `https://internshala.com/internships/${slug}-internship/`
    : `https://internshala.com/internships/${slug}-internship-in-${locSlug}/`;

  try {
    const run = await client.actor("apify/web-scraper").call({
      startUrls: [{ url: startUrl }],
      pageFunction: `async function pageFunction(context) {
        const { $ } = context;
        const jobs = [];
        $(".individual_internship, .internship-item, [data-internship_id]").each((i, el) => {
          const $el = $(el);
          const title   = $el.find(".profile h3, h3.heading_4_5, .profile .heading_4_5").first().text().trim();
          const company = $el.find(".company_name a, .company_name").first().text().trim();
          const location= $el.find(".location_link, .locations span").first().text().trim() || "Remote";
          const relPath = $el.find("a.view_detail_button, a[href*='/internship/detail/']").first().attr("href") || "";
          const applyUrl= relPath.startsWith("http") ? relPath : "https://internshala.com" + relPath;
          if (title) jobs.push({ title, company, location, applyUrl, isRemote: /remote/i.test(location) });
        });
        return jobs.slice(0, ${max});
      }`,
      proxyConfiguration: { useApifyProxy: true },
    }, { waitSecs: 60 });
    const { items } = await client.dataset(run.defaultDatasetId).listItems();

    return items.flat().filter(Boolean).map((i) => ({
      ...i,
      datePosted:      null,
      experienceLevel: "internship",
      employmentType:  "internship",
      skills:          [],
      source:          "Internshala",
    }));
  } catch (err) {
    console.error("[Internshala] scrape error:", err.message);
    return [];
  }
}

// ─── Mock data (used when _mock: true or APIFY_API_KEY not set) ───────────────

function getMockJobs(keywords, location) {
  const kw = keywords.toLowerCase();
  return [
    {
      title: "Full Stack Developer Intern",
      company: "TechCorp India",
      location: location || "Noida",
      isRemote: false,
      applyUrl: "https://linkedin.com/jobs/view/mock-1",
      datePosted: new Date(Date.now() - 1 * 86400000).toISOString(),
      experienceLevel: "entry",
      employmentType: "internship",
      skills: ["React", "Node.js", "MongoDB"],
      source: "LinkedIn (mock)",
    },
    {
      title: "MERN Stack Developer",
      company: "StartupXYZ",
      location: location || "Gurugram",
      isRemote: false,
      applyUrl: "https://linkedin.com/jobs/view/mock-2",
      datePosted: new Date(Date.now() - 0 * 86400000).toISOString(),
      experienceLevel: "entry",
      employmentType: "full-time",
      skills: ["React", "Express.js", "Node.js", "MongoDB"],
      source: "LinkedIn (mock)",
    },
    {
      title: "Backend Developer Trainee",
      company: "Infosys",
      location: "Noida",
      isRemote: false,
      applyUrl: "https://naukri.com/jobs/mock-3",
      datePosted: new Date(Date.now() - 2 * 86400000).toISOString(),
      experienceLevel: "entry",
      employmentType: "full-time",
      skills: ["Node.js", "Python", "REST API"],
      source: "Naukri (mock)",
    },
    {
      title: "Junior Software Developer",
      company: "Wipro Digital",
      location: "Gurugram",
      isRemote: false,
      applyUrl: "https://lever.co/jobs/mock-4",
      datePosted: new Date(Date.now() - 1 * 86400000).toISOString(),
      experienceLevel: "entry",
      employmentType: "full-time",
      skills: ["JavaScript", "TypeScript", "React"],
      source: "ATS (mock)",
    },
    {
      title: "Senior Software Architect",
      company: "BigCorp",
      location: "Delhi",
      isRemote: false,
      applyUrl: "https://greenhouse.io/jobs/mock-5",
      datePosted: new Date(Date.now() - 3 * 86400000).toISOString(),
      experienceLevel: "senior",
      employmentType: "full-time",
      skills: ["Java", "Microservices", "Kubernetes"],
      source: "ATS (mock)",
    },
    {
      title: "React Developer Intern",
      company: "FinTech Startup",
      location: location || "Remote",
      isRemote: true,
      applyUrl: "https://internshala.com/jobs/mock-6",
      datePosted: new Date(Date.now() - 0 * 86400000).toISOString(),
      experienceLevel: "internship",
      employmentType: "internship",
      skills: ["React", "JavaScript", "Tailwind CSS"],
      source: "Internshala (mock)",
    },
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

export async function findJobs(args) {
  const {
    keywords,
    location,
    job_type,
    posted_within          = "this week",
    max_results_per_source = 25,
    user_role,
    user_experience_level,
    user_employment_type,
    user_skills,
    _mock                  = false,
  } = args || {};

  // Gate: require all three core params
  const missing = [];
  if (!keywords) missing.push("target role/keywords (e.g. 'React developer', 'Full Stack Developer')");
  if (!location) missing.push("location (e.g. 'Noida', 'Delhi NCR', 'Remote')");
  if (!job_type) missing.push("job type — 'full-time', 'internship', or 'both'");
  if (missing.length) return buildGateMessage(missing);

  const max          = Math.min(max_results_per_source || 25, 50);
  const userSkillsArr = user_skills ? user_skills.split(",").map((s) => s.trim()).filter(Boolean) : [];
  const useMock      = _mock || !process.env.APIFY_API_KEY;

  // ── Scrape all sources in parallel ────────────────────────────────────────
  let allJobs = [];

  if (useMock) {
    console.error("[find_jobs] ⚠️  Using mock data (APIFY_API_KEY not set or _mock=true)");
    allJobs = getMockJobs(keywords, location);
  } else {
    const sources = [];

    // LinkedIn — always (hard cap: 60s)
    sources.push(withTimeout(scrapeLinkedIn({ keywords, location, job_type, posted_within, max }), 60_000, "LinkedIn"));

    // Naukri — always, India-focused (hard cap: 60s)
    sources.push(withTimeout(scrapeNaukri({ keywords, location, job_type, max }), 60_000, "Naukri"));

    // Internshala — only for internship or both (hard cap: 45s)
    if (job_type === "internship" || job_type === "both") {
      sources.push(withTimeout(scrapeInternshala({ keywords, location, max }), 45_000, "Internshala"));
    } else {
      sources.push(Promise.resolve([]));
    }

    // ATS — only for full-time or both (hard cap: 60s)
    if (job_type === "full-time" || job_type === "both") {
      sources.push(withTimeout(scrapeATS({ keywords, location, job_type, max }), 60_000, "ATS"));
    } else {
      sources.push(Promise.resolve([]));
    }

    const results = await Promise.allSettled(sources);
    for (const r of results) {
      if (r.status === "fulfilled") allJobs.push(...(r.value || []));
    }
  }

  // ── Handle no results ─────────────────────────────────────────────────────
  if (!allJobs.length) {
    return [
      `## No jobs found`,
      ``,
      `No results from any source for **"${keywords}"** in **${location}** (posted: ${posted_within}).`,
      ``,
      `**Try:**`,
      `- Broadening keywords (e.g. "React" → "Frontend Developer")`,
      `- Changing location to "Remote" or a larger city`,
      `- Extending the posted_within window to "this week"`,
    ].join("\n");
  }

  // ── Score + flag ──────────────────────────────────────────────────────────
  const scored = allJobs.map((job) => {
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
        userRole:           user_role           || keywords,
        userExpLevel:       user_experience_level || "",
        userLocation:       location,
        userEmploymentType: user_employment_type  || job_type,
        userSkillsArr,
      }
    );

    const stretch  = isStretch(job.title, job.experienceLevel, user_experience_level || "");
    const daysAgo  = job.datePosted
      ? Math.floor((Date.now() - new Date(job.datePosted)) / 86_400_000)
      : null;
    const hmTitle        = getHiringManagerTitle(job.title);
    const city           = (job.location || location).split(",")[0].trim();
    const hmSearchString = `${hmTitle} "${job.company}" "${city}"`;

    return { ...job, fitScore, stretch, daysAgo, hmSearchString };
  });

  // Sort: newest first, then fit score desc
  scored.sort((a, b) => {
    const aDate = a.datePosted ? new Date(a.datePosted).getTime() : 0;
    const bDate = b.datePosted ? new Date(b.datePosted).getTime() : 0;
    if (bDate !== aDate) return bDate - aDate;
    return b.fitScore - a.fitScore;
  });

  const showJobs = scored.filter((j) => j.fitScore >= 6);
  const skipJobs = scored.filter((j) => j.fitScore < 6);

  // ── STEP 4 Output ─────────────────────────────────────────────────────────
  const sourceCount = [...new Set(allJobs.map(j => j.source))].join(", ");
  const lines = [
    `## STEP 4 — Job Search Results`,
    ``,
    `**Search:** "${keywords}" | **Location:** ${location} | **Type:** ${job_type} | **Posted:** ${posted_within}`,
    `**Sources:** ${sourceCount}`,
    `**Total found:** ${allJobs.length} | **Showing:** ${showJobs.length} (fit ≥ 6/10) | **Skipping:** ${skipJobs.length}`,
    useMock ? `\n> ⚠️ **MOCK MODE** — using test data, not live Apify results.\n` : ``,
    `> **Score baseline is server-computed. You may adjust ±1 based on description nuance.**`,
    ``,
  ];

  if (showJobs.length) {
    lines.push(
      "| Role | Company | Source | Posted | Fit Score | Apply Link | Hiring Manager Search Tips |",
      "|------|---------|--------|--------|-----------|------------|----------------------------|",
      ...showJobs.map((j) => {
        const roleCell   = `${j.stretch ? "⚠️ " : ""}${j.title}`;
        const postedCell = j.daysAgo !== null ? `${j.daysAgo}d ago` : "—";
        const applyCell  = j.applyUrl ? `[Apply](${j.applyUrl})` : "—";
        const hmCell     = `\`${j.hmSearchString}\``;
        return `| ${roleCell} | ${j.company} | ${j.source} | ${postedCell} | ${j.fitScore}/10 | ${applyCell} | ${hmCell} |`;
      }),
      ""
    );
  } else {
    lines.push(`_No jobs met the ≥ 6/10 fit threshold. See skip list below._`, ``);
  }

  if (skipJobs.length) {
    lines.push(
      `## Jobs to Skip`,
      ``,
      ...skipJobs.map((j) => {
        let reason = `Fit score ${j.fitScore}/10`;
        if (j.stretch) reason += " — seniority stretch";
        else if (j.fitScore <= 3) reason += " — role/location mismatch";
        return `- **${j.title}** at ${j.company} (${j.source}) — ${reason}`;
      }),
      ``
    );
  }

  if (showJobs.some((j) => j.stretch)) {
    lines.push(`> ⚠️ = Seniority may be a stretch. Apply if you meet 70%+ of the requirements.`);
  }

  return lines.join("\n");
}
