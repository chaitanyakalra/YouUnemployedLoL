import { Job } from "../db/schemas.js";
import mongoose from "mongoose";

export const getJobDetailsTool = {
  name: "get_job_details",
  description:
    "Get the full details of a specific job listing by its ID. Returns complete job description, salary, requirements, and direct apply link.",
  inputSchema: {
    type: "object",
    required: ["job_id"],
    properties: {
      job_id: {
        type: "string",
        description: "The job ID returned from search_jobs",
      },
    },
  },
};

export async function getJobDetails(args) {
  const { job_id } = args;

  if (!mongoose.Types.ObjectId.isValid(job_id)) {
    return `Invalid job ID: "${job_id}". Use the ID returned from search_jobs.`;
  }

  const job = await Job.findById(job_id).lean();

  if (!job) {
    return `Job not found. It may have been removed or expired. Try search_jobs to find current listings.`;
  }

  const salary =
    job.salaryMin && job.salaryMax
      ? `$${(job.salaryMin / 1000).toFixed(0)}k – $${(job.salaryMax / 1000).toFixed(0)}k per year (${job.salaryCurrency || "USD"})`
      : "Not specified";

  const lines = [
    `# ${job.title}`,
    `**Company:** ${job.company}${job.companyWebsite ? ` (${job.companyWebsite})` : ""}`,
    `**Source:** ${job.source.toUpperCase()}`,
    `**Location:** ${job.isRemote ? "🌍 Remote" : job.location || "Not specified"}`,
    `**Employment Type:** ${job.employmentType || "Not specified"}`,
    `**Experience Level:** ${job.experienceLevel || "Not specified"}`,
    `**Department:** ${job.department || "Not specified"}`,
    `**Salary:** ${salary}`,
    `**Posted:** ${job.datePosted ? new Date(job.datePosted).toDateString() : "Unknown"}`,
    `**Apply URL:** ${job.applyUrl || job.listingUrl || "Not available"}`,
    `**Skills:** ${job.skills?.length ? job.skills.join(", ") : "Not listed"}`,
    "",
    "## Job Description",
    job.description || "No description available.",
  ];

  return lines.join("\n");
}
