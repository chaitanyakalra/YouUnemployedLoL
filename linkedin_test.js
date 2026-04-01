import { ApifyClient } from "apify-client";

console.log("ΓöÇ∩╕Å Starting LinkedIn Test Script...");

const API_KEY = process.env.APIFY_API_KEY;

// Verify API Key
if (!API_KEY || API_KEY.includes("xxxx")) {
    console.warn("ΓÜá APIFY_API_KEY is missing or a placeholder.");
    console.log("Please run: $env:APIFY_API_KEY='your_key'; node linkedin_test.js");
    process.exit(1);
}

async function fetchJobs(keywords, location = "India") {
    const client = new ApifyClient({ token: API_KEY });
    try {
        console.log(`≡ƒÜÇ Searching LinkedIn for: "${keywords}" in ${location}...`);
        const run = await client.actor("worldunboxer/rapid-linkedin-scraper").call({
            keywords: [keywords],
            location: location,
            datePosted: "past-24h",
            resultsPerPage: 3,
            proxy: { useApifyProxy: true },
        }, { waitSecs: 90 });

        const { items } = await client.dataset(run.defaultDatasetId).listItems();
        return items.map(i => ({
            Title: i.title || i.jobTitle || "N/A",
            Company: i.company || i.companyName || "N/A",
            Location: i.location || "N/A",
            Source: "linkedin-live"
        }));
    } catch (err) {
        console.error("Γ¥î Error during scrape:", err.message);
        return [];
    }
}

(async () => {
    const results = await fetchJobs("React Developer", "Bangalore");
    if (results.length > 0) {
        console.log("\n=== TEST RESULTS ===");
        console.table(results);
    } else {
        console.log("No jobs found or error occurred.");
    }
})();
