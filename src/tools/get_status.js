import { JobSearch } from "../db/schemas.js";

export const getJobStatusTool = {
  name: "get_job_status",
  description: "Poll for the status and results of a job search started with find_jobs.",
  inputSchema: {
    type: "object",
    required: ["search_id"],
    properties: {
      search_id: {
        type: "string",
        description: "The search ID returned from find_jobs",
      },
    },
  },
};

export async function getJobStatus(args) {
  const { search_id } = args;

  if (!search_id) return "Missing search_id.";

  const search = await JobSearch.findOne({ searchId: search_id }).lean();

  if (!search) {
    return `Search ID "${search_id}" not found. It may have expired (they are deleted after 1 hour).`;
  }

  if (search.status === "pending") {
    return [
      `## ⏳ Search in Progress`,
      ``,
      `Your search Choice for **"${search.query?.keywords}"** is still running.`,
      `Estimated time: 30-90s (LinkedIn and Internshala can be slow).`,
      ``,
      `Please check back in 15 seconds using:`,
      `\`get_job_status(search_id: "${search_id}")\``
    ].join("\n");
  }

  if (search.status === "failed") {
    return [
      `## ❌ Search Failed`,
      ``,
      `Reason: ${search.error || "Unknown error during scraping."}`,
      ``,
      `You can try simplifying your keywords or location and running find_jobs again.`
    ].join("\n");
  }

  // Success path
  return search.results || "No results found for this search.";
}
