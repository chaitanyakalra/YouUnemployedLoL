import { Job } from "../db/schemas.js";

export const searchJobsTool = {
  name: "search_jobs",
  description:
    "Search for jobs by role, location, remote preference, and salary range. Returns matching jobs from LinkedIn, Greenhouse, Lever, Workday, Ashby, Naukri, and more — all normalized into one format.",
  inputSchema: {
    type: "object",
    properties: {
      role: {
        type: "string",
        description: "Job title or keyword, e.g. 'backend engineer', 'product manager', 'data scientist'",
      },
      location: {
        type: "string",
        description: "City, country, or region e.g. 'London', 'India', 'New York'",
      },
      remote: {
        type: "boolean",
        description: "Set true to show remote jobs only",
      },
      salary_min: {
        type: "number",
        description: "Minimum salary in USD per year",
      },
      salary_max: {
        type: "number",
        description: "Maximum salary in USD per year",
      },
      experience_level: {
        type: "string",
        description: "One of: junior, mid, senior, lead",
      },
      source: {
        type: "string",
        description: "Filter by source: greenhouse, lever, linkedin, naukri, workday, ashby",
      },
      days_posted: {
        type: "number",
        description: "Only show jobs posted within the last N days (e.g. 7 for last week)",
      },
      limit: {
        type: "number",
        description: "Number of results to return (default 10, max 25)",
      },
    },
  },
};

export async function searchJobs(args) {
  const {
    role,
    location,
    remote,
    salary_min,
    salary_max,
    experience_level,
    source,
    days_posted,
    limit = 10,
  } = args;

  const query = { isActive: true };

  // Text search on title + company + description
  if (role) {
    query.$text = { $search: role };
  }

  // Location filter
  if (location) {
    query.$or = [
      { location: { $regex: location, $options: "i" } },
      { city:     { $regex: location, $options: "i" } },
      { country:  { $regex: location, $options: "i" } },
    ];
  }

  // Remote filter
  if (remote === true) query.isRemote = true;

  // Salary filters
  if (salary_min) query.salaryMax = { $gte: salary_min };
  if (salary_max) query.salaryMin = { $lte: salary_max };

  // Experience level
  if (experience_level) query.experienceLevel = experience_level;

  // Source filter
  if (source) query.source = source;

  // Date posted filter
  if (days_posted) {
    const since = new Date();
    since.setDate(since.getDate() - days_posted);
    query.datePosted = { $gte: since };
  }

  const cap = Math.min(limit, 25);

  const jobs = await Job.find(query)
    .sort({ datePosted: -1 })
    .limit(cap)
    .lean();

  if (!jobs.length) {
    return "No jobs found matching your criteria. Try broadening your search — remove location or salary filters and try again.";
  }

  const lines = [
    `Found ${jobs.length} job${jobs.length > 1 ? "s" : ""}:\n`,
    ...jobs.map((j, i) => {
      const salary =
        j.salaryMin && j.salaryMax
          ? ` | $${(j.salaryMin / 1000).toFixed(0)}k–$${(j.salaryMax / 1000).toFixed(0)}k`
          : "";
      const remote = j.isRemote ? " | 🌍 Remote" : j.location ? ` | 📍 ${j.location}` : "";
      const level  = j.experienceLevel ? ` | ${j.experienceLevel}` : "";
      const posted = j.datePosted
        ? ` | Posted ${Math.floor((Date.now() - new Date(j.datePosted)) / 86400000)}d ago`
        : "";

      return [
        `${i + 1}. **${j.title}** — ${j.company}`,
        `   ${j.source.toUpperCase()}${remote}${salary}${level}${posted}`,
        `   Apply: ${j.applyUrl || j.listingUrl || "N/A"}`,
        `   ID: ${j._id}`,
      ].join("\n");
    }),
  ];

  return lines.join("\n");
}
