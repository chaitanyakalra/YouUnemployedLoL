import { JobSearch } from "../db/schemas.js";

export const getStatusTool = {
  name: "get_job_status",
  description: "Polls the status of a background job search and returns the Markdown table when ready.",
  inputSchema: {
    type: "object",
    properties: {
      search_id: {
        type: "string",
        description: "The unique ID returned by find_jobs",
      },
    },
    required: ["search_id"],
  },
};

export async function getStatus(args) {
  const { search_id } = args;
  if (!search_id) return "search_id is required.";

  const search = await JobSearch.findOne({ searchId: search_id });
  if (!search) return `Search ID "${search_id}" not found. It may have expired (TTL is 1 hour).`;

  if (search.status === "pending") {
    return [
      `## ⏳ Search in Progress`,
      ``,
      `I'm still scraping sources for this search.`,
      `Please wait another **20-30 seconds** and try again.`,
      ``,
      `> **Status:** \`${search.status}\``
    ].join("\n");
  }

  if (search.status === "failed") {
    return [
      `## ❌ Search Failed`,
      ``,
      `Error: ${search.error || "Unknown error"}`,
      ``,
      `You may want to try the search again with different keywords or location.`,
    ].join("\n");
  }

  // Completed
  return search.results || "No results found for this search.";
}
