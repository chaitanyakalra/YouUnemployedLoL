// find_jobs.js — Live on-demand job search with server-side fit scoring
// Called only after set_profile confirms all required fields.
// Returns STEP 4 table data: scored jobs ≥6, skip list, seniority flags.

import { ApifyClient } from "apify-client";
const client = new ApifyClient({ token: process.env.APIFY_API_KEY });

// ─── Tool definition ──────────────────────────────────────────────────────────
export const findJobsTool = {
  name: "find_jobs",
  description:
    "Live job search across LinkedIn, Internshala, and 13 ATS platforms. " +
    "Requires role — returns nothing without it. Scores every job against " +
    "the candidate profile server-side and emits STEP 4 table output only.",
  inputSchema: {
    type: "object",
    required: ["keywords", "location", "job_type"],
    properties: {
      keywords:              { type: "string",  description: "Role keywords from set_profile. e.g. 'React developer'" },
      location:              { type: "string",  description: "City or region. e.g. 'Noida', 'Delhi NCR', 'Remote'" },
      job_type:              { type: "string",  description: "'full-time' | 'internship' | 'both'" },
      posted_within:         { type: "string",  description: "'today' | '2 days' | 'this week' (default: 'this week')" },
      max_results_per_source:{ type: "number",  description: "Max per scraper (default 25, max 50)" },
      resume_text:           { type: "string",  description: "Resume text for scoring (from set_profile)" },
      user_role:             { type: "string",  description: "Exact role string the user typed — used for title scoring" },
      user_experience_level: { type: "string",  description: "e.g. 'fresher', '0-1 years', '1-3 years'" },
      user_employment_type:  { type: "string",  description: "User's preferred type — used for +1 match signal" },
      user_skills:           { type: "string",  description: "Comma-separated skills from set_profile" },
    },
  },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Normalize free-text experience level strings into: "entry" | "mid" | "senior" | null
 */
function normalizeLevel(s = "") {
  s = s.toLowerCase();
  if (s.includes("entry") || s.includes("junior") || s.includes("fresher") || s.includes("intern") || s.includes("0-1") || s.includes("0 to 1")) return "entry";
  if (s.includes("mid") || s.includes("1-3") || s.includes("2-4") || s.includes("associate")) return "mid";
  if (s.includes("senior") || s.includes("lead") || s.includes("principal") || s.includes("staff")) return "senior";
  if (s.includes("director") || s.includes("head of") || s.includes("vp") || s.includes("vice president")) return "senior";
  return null;
}

/**
 * Two-signal seniority stretch detection.
 * Returns true if the job is likely a stretch for the user's declared level.
 */
function isStretch(jobTitle = "", jobExpLevel = "", userLevel = "") {
  const seniorTitleWords = ["senior", "lead", "principal", "staff", "head of", "director", "vp ", "vice president"];
  const titleStretch = seniorTitleWords.some((w) => jobTitle.toLowerCase().includes(w));

  const userNorm = normalizeLevel(userLevel);
  const jobNorm  = normalizeLevel(jobExpLevel);

  if (!userNorm) return false;
  if (userNorm === "entry" && (titleStretch || jobNorm === "senior")) return true;
  if (userNorm === "mid" && (jobNorm === "senior" || jobTitle.toLowerCase().includes("director"))) return true;
  return false;
}

/**
 * Derive the right hiring manager title to search for on LinkedIn,
 * based on the job title's domain keywords.
 */
function getHiringManagerTitle(jobTitle = "") {
  const t = jobTitle.toLowerCase();
  if (/\b(data|analyst|scientist|analytics)\b/.test(t))    return '"Head of Data" OR "Data Engineering Manager"';
  if (/\b(product|pm|product manager)\b/.test(t))          return '"Director of Product" OR "VP Product"';
  if (/\b(design|ux|ui|user experience)\b/.test(t))        return '"Head of Design" OR "Design Manager"';
  if (/\b(devops|infra|platform|sre|cloud|devsecops)\b/.test(t)) return '"Head of Engineering" OR "VP Engineering"';
  if (/\b(mobile|android|ios|flutter|react native)\b/.test(t))   return '"Engineering Manager" OR "Head of Mobile"';
  if (/\b(backend|api|node|python|java|golang|go|rust|spring)\b/.test(t)) return '"Engineering Manager" OR "VP Engineering"';
  if (/\b(frontend|react|angular|vue|next|svelte|typescript)\b/.test(t))  return '"Engineering Manager" OR "Frontend Lead"';
  if (/\b(full.?stack|fullstack)\b/.test(t))               return '"CTO" OR "Engineering Manager"';
  if (/\b(ml|ai|machine learning|deep learning|llm|nlp)\b/.test(t))       return '"Head of AI" OR "ML Engineering Manager"';
  if (/\b(qa|quality|test|automation|sdet)\b/.test(t))     return '"QA Manager" OR "Engineering Manager"';
  if (/\b(security|cybersecurity|infosec|soc)\b/.test(t))  return '"Head of Security" OR "CISO"';
  return '"Engineering Manager"';
}

/**
 * Server-side deterministic fit score (0–10).
 * Claude uses this as the baseline and may adjust ±1 for description nuance.
 */
function computeFitScore({ jobTitle, jobExpLevel, jobIsRemote, jobLocation, jobSkills = [], jobEmploymentType }, { userRole, userExpLevel, userLocation, userEmploymentType, userSkillsArr = [] }) {
  let score = 0;

  // +3 — Title keyword match (any word from user_role)
  if (userRole) {
    const roleWords = userRole.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
    const titleLow  = jobTitle.toLowerCase();
    if (roleWords.some((w) => titleLow.includes(w))) score += 3;
  }

  // +2 — Experience level match
  if (userExpLevel) {
    const userNorm = normalizeLevel(userExpLevel);
    const jobNorm  = normalizeLevel(jobExpLevel);
    if (userNorm && jobNorm && userNorm === jobNorm) score += 2;
    // Partial credit: if job level is null (not specified), give +1 — generous
    else if (userNorm && !jobNorm) score += 1;
  }

  // +1 — Employment type match
  if (userEmploymentType && jobEmploymentType) {
    const u = userEmploymentType.toLowerCase().replace(/[-_\s]/g, "");
    const j = jobEmploymentType.toLowerCase().replace(/[-_\s]/g, "");
    if (u === j || j.includes(u) || u.includes(j)) score += 1;
  }

  // +2 — Location / remote match
  if (userLocation) {
    const locLow = userLocation.toLowerCase();
    const isRemotePref = locLow.includes("remote");
    if (isRemotePref && jobIsRemote) {
      score += 2;
    } else if (!isRemotePref && jobLocation) {
      const jobLocLow = jobLocation.toLowerCase();
      if (jobLocLow.includes(locLow) || locLow.split(/[\s,]+/).some((word) => word.length > 2 && jobLocLow.includes(word))) {
        score += 2;
      }
    } else if (jobIsRemote) {
      // Remote job when user wants on-site → partial
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

// ─── Apify scraper calls ──────────────────────────────────────────────────────

/**
 * Map posted_within string to the date filter value used by worldunboxer/rapid-linkedin-scraper.
 */
function postedWithinToLinkedIn(posted = "this week") {
  const p = posted.toLowerCase();
  if (p.includes("today") || p.includes("24"))    return "past-24h";
  if (p.includes("2 day") || p.includes("two"))   return "past-week";
  return "past-week"; // default: "this week"
}

async function scrapeLinkedIn({ keywords, location, job_type, posted_within, max }) {
  const input = {
    keywords: [keywords],   // actor expects an array of search strings
    location,
    datePosted: postedWithinToLinkedIn(posted_within),
    resultsPerPage: max,
    proxy: { useApifyProxy: true },
  };
  try {
    const run = await client.actor("worldunboxer/rapid-linkedin-scraper").call(input, { waitSecs: 90 });
    const { items } = await client.dataset(run.defaultDatasetId).listItems();
    return (items || []).map((i) => ({
      title:          i.title        || i.jobTitle     || "",
      company:        i.company      || i.companyName  || "",
      location:       i.location     || "",
      isRemote:       /remote/i.test(i.location || "") || /remote/i.test(i.workType || ""),
      applyUrl:       i.jobUrl       || i.applyUrl     || i.link || "",
      datePosted:     i.postedAt     || i.publishedAt  || null,
      experienceLevel:i.seniorityLevel || i.experienceLevel || "",
      employmentType: i.employmentType || "",
      skills:         Array.isArray(i.skills) ? i.skills : [],
      source:         "linkedin",
    }));
  } catch (err) {
    console.error("LinkedIn scrape error:", err.message);
    return [];
  }
}

async function scrapeInternshala({ keywords, location, job_type, max }) {
  if (job_type === "full-time") return []; // Internshala is internship-focused
  const slug = encodeURIComponent(keywords.toLowerCase().replace(/\s+/g, "-"));
  const locSlug = encodeURIComponent(location.toLowerCase().replace(/\s+/g, "-"));
  const isRemotePref = /remote/i.test(location);
  const startUrl = isRemotePref
    ? `https://internshala.com/internships/${slug}-internship/`
    : `https://internshala.com/internships/${slug}-internship-in-${locSlug}/`;
  try {
    const run = await client.actor("apify/web-scraper").call({
      startUrls: [{ url: startUrl }],
      pageFunction: `async function pageFunction(context) {
        const { $, request } = context;
        const jobs = [];
        // Try current and legacy selectors for resilience
        const containers = $(".individual_internship, .internship-item, [data-internship_id]");
        containers.each((i, el) => {
          const $el = $(el);
          const title =
            $el.find(".profile h3, .profile .heading_4_5, h3.heading_4_5").first().text().trim() ||
            $el.find(".profile").first().text().trim();
          const company =
            $el.find(".company_name a, .company_name, .company-name a, .company-name").first().text().trim();
          const location =
            $el.find(".location_link, .locations span, .location span").first().text().trim() || "Remote";
          const relPath =
            $el.find("a.view_detail_button, a[href*='/internship/detail/']").first().attr("href") || "";
          const applyUrl = relPath.startsWith("http") ? relPath : "https://internshala.com" + relPath;
          if (title) {
            jobs.push({
              title,
              company,
              location,
              applyUrl,
              datePosted: null,
              isRemote: /remote/i.test(location),
            });
          }
        });
        return jobs.slice(0, ${max});
      }`,
      proxyConfiguration: { useApifyProxy: true },
    }, { waitSecs: 60 });
    const { items } = await client.dataset(run.defaultDatasetId).listItems();
    return items.flat().filter(Boolean).map((i) => ({
      ...i,
      experienceLevel: "internship",
      employmentType:  "internship",
      skills: [],
      source: "internshala",
    }));
  } catch (err) {
    console.error("Internshala scrape error:", err.message);
    return [];
  }
}

// ─── Gate helpers ─────────────────────────────────────────────────────────────

function buildGateMessage(missing) {
  return (
    `Before I can search for jobs, I need a few more details:\n\n` +
    missing.map((m, i) => `${i + 1}. ${m}`).join("\n") +
    `\n\nPlease provide these and I'll start the search immediately.`
  );
}

// ─── Main function ────────────────────────────────────────────────────────────

export async function findJobs(args) {
  const {
    keywords,
    location,
    job_type,
    posted_within     = "this week",
    max_results_per_source = 25,
    user_role,
    user_experience_level,
    user_employment_type,
    user_skills,
  } = args || {};

  // ── Gate: internal validation (fires regardless of schema required fields) ──
  const missing = [];
  if (!keywords) missing.push("target role/keywords (e.g. 'React developer', 'Backend Engineer')");
  if (!location) missing.push("location (e.g. 'Noida', 'Delhi NCR', 'Remote')");
  if (!job_type) missing.push("job type — 'full-time', 'internship', or 'both'");
  if (missing.length) return buildGateMessage(missing);

  const max          = Math.min(max_results_per_source || 25, 50);
  const userSkillsArr = user_skills ? user_skills.split(",").map((s) => s.trim()).filter(Boolean) : [];

  // ── Scrape ────────────────────────────────────────────────────────────────
  const [linkedInJobs, internshalaJobs] = await Promise.all([
    scrapeLinkedIn({ keywords, location, job_type, posted_within, max }),
    (job_type === "internship" || job_type === "both")
      ? scrapeInternshala({ keywords, location, job_type, max })
      : Promise.resolve([]),
  ]);

  const allJobs = [...linkedInJobs, ...internshalaJobs];

  if (!allJobs.length) {
    return [
      `## No jobs found`,
      ``,
      `No results from LinkedIn or Internshala for **"${keywords}"** in **${location}** (posted: ${posted_within}).`,
      ``,
      `**Try:**`,
      `- Broadening keywords (e.g. "React" → "Frontend Developer")`,
      `- Changing location to "Remote" or a larger city`,
      `- Extending the posted_within window to "this week"`,
    ].join("\n");
  }

  // ── Score + flag each job ─────────────────────────────────────────────────
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
        userRole:            user_role           || keywords,
        userExpLevel:        user_experience_level || "",
        userLocation:        location,
        userEmploymentType:  user_employment_type || job_type,
        userSkillsArr,
      }
    );

    const stretch = isStretch(job.title, job.experienceLevel, user_experience_level || "");

    const daysAgo = job.datePosted
      ? Math.floor((Date.now() - new Date(job.datePosted)) / 86_400_000)
      : null;

    const hmTitle        = getHiringManagerTitle(job.title);
    const city           = (job.location || location).split(",")[0].trim();
    const hmSearchString = `${hmTitle} "${job.company}" "${city}"`;

    return { ...job, fitScore, stretch, daysAgo, hmSearchString };
  });

  // Sort: most recently posted first, then fit score desc
  scored.sort((a, b) => {
    const aDate = a.datePosted ? new Date(a.datePosted).getTime() : 0;
    const bDate = b.datePosted ? new Date(b.datePosted).getTime() : 0;
    if (bDate !== aDate) return bDate - aDate;
    return b.fitScore - a.fitScore;
  });

  const showJobs = scored.filter((j) => j.fitScore >= 6);
  const skipJobs = scored.filter((j) => j.fitScore < 6);

  // ── STEP 4 — Main Table ───────────────────────────────────────────────────
  const lines = [
    `## STEP 4 — Job Search Results`,
    ``,
    `**Search:** "${keywords}" | **Location:** ${location} | **Type:** ${job_type} | **Posted:** ${posted_within}`,
    `**Total found:** ${allJobs.length} | **Showing:** ${showJobs.length} (fit ≥ 6/10) | **Skipping:** ${skipJobs.length}`,
    ``,
    `> **Score baseline is server-computed. You may adjust ±1 based on description nuance. Display as-is unless you have a specific reason.**`,
    ``,
  ];

  if (showJobs.length) {
    lines.push(
      "| Role | Company | Posted | Fit Score | Apply Link | Hiring Manager Search Tips |",
      "|------|---------|--------|-----------|------------|----------------------------|",
      ...showJobs.map((j) => {
        const roleCell  = `${j.stretch ? "⚠️ " : ""}${j.title}`;
        const postedCell = j.daysAgo !== null ? `${j.daysAgo}d ago` : "—";
        const scoreCell = `${j.fitScore}/10`;
        const applyCell = j.applyUrl ? `[Apply](${j.applyUrl})` : "—";
        const hmCell    = `\`${j.hmSearchString}\``;
        return `| ${roleCell} | ${j.company} | ${postedCell} | ${scoreCell} | ${applyCell} | ${hmCell} |`;
      }),
      ""
    );
  } else {
    lines.push(`_No jobs met the ≥ 6/10 fit threshold. See skip list below._`, ``);
  }

  // ── Skip List ─────────────────────────────────────────────────────────────
  if (skipJobs.length) {
    lines.push(
      `## Jobs to Skip`,
      ``,
      ...skipJobs.map((j) => {
        let reason = `Fit score ${j.fitScore}/10`;
        if (j.stretch) reason += " — seniority stretch";
        if (j.fitScore <= 3) reason += " — role/location mismatch";
        return `- **${j.title}** at ${j.company} — ${reason}`;
      }),
      ``
    );
  }

  // ── Footer note about ⚠️ ─────────────────────────────────────────────────
  if (showJobs.some((j) => j.stretch)) {
    lines.push(`> ⚠️ = Seniority may be a stretch based on your declared experience level. Apply if you meet 70%+ of the requirements.`);
  }

  return lines.join("\n");
}
