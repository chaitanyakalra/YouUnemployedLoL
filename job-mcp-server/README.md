# Job MCP Server

An MCP server that gives Claude real-time job search across 13+ platforms (Greenhouse, Lever, LinkedIn, Workday, Ashby, Naukri, and more), resume matching, salary filtering, and application tracking — all free.

## Tools Available

| Tool | What it does |
|---|---|
| `search_jobs` | Search by role, location, remote, salary, experience level |
| `match_resume` | Upload a PDF resume — Claude scores every job against it |
| `get_job_details` | Get full job description + apply link by ID |
| `track_application` | Save, update, and list your job applications |

## Quick Start (5 minutes)

### 1. Clone the repo
```bash
git clone https://github.com/YOUR_USERNAME/job-mcp-server.git
cd job-mcp-server
npm install
```

### 2. Add environment variables
```bash
cp .env.example .env
# Edit .env with your MongoDB URI and Apify key
```

### 3. Connect to Claude Desktop

Open your Claude Desktop config file:
- **Mac**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

Add this block:
```json
{
  "mcpServers": {
    "job-search": {
      "command": "node",
      "args": ["/absolute/path/to/job-mcp-server/src/index.js"],
      "env": {
        "MONGODB_URI": "your_mongodb_uri_here",
        "APIFY_API_KEY": "your_apify_key_here"
      }
    }
  }
}
```

Restart Claude Desktop. Done.

### 4. Seed the database (first time)
```bash
node src/scheduler.js
```
This runs all scrapers and fills MongoDB. Takes ~5 minutes. After that it auto-runs every 6 hours.

---

## Deploy to Render (free, always-on)

1. Push this repo to GitHub
2. Go to [render.com](https://render.com) → New → Blueprint
3. Connect your GitHub repo — Render reads `render.yaml` automatically
4. In the Render dashboard, set these environment variables for both services:
   - `MONGODB_URI` → your MongoDB Atlas connection string
   - `APIFY_API_KEY` → your Apify API key
5. Deploy

Your MCP server will be live at `https://job-mcp-server-xxxx.onrender.com`

Then update Claude Desktop config to use the hosted URL instead of local path.

---

## Example Prompts

```
Find remote backend developer jobs posted this week paying at least $120k
```
```
Match my resume to senior product manager roles — here's my resume text: [paste]
```
```
Show me full details for job ID 665abc123def456
```
```
Save job 665abc123def456 to my tracker with status applied
```
```
List all my job applications
```

---

## Architecture

```
Claude Desktop
    ↓ MCP protocol
Job MCP Server (Render free tier)
    ↓ queries
MongoDB Atlas (free tier — jobs, applications)
    ↑ populated by
Scheduler (every 6 hrs)
    ├── jobo.world/ats-jobs-search  → 13 ATS platforms (stable base)
    ├── worldunboxer/rapid-linkedin-scraper → LinkedIn (extra coverage)
    └── stealth_mode/naukri-jobs-search → Naukri India
```

## Data Sources

| Source | Platforms | Stability | Cost |
|---|---|---|---|
| `jobo.world/ats-jobs-search` | Greenhouse, Lever, Workday, Ashby, SmartRecruiters, Workable, BambooHR, Rippling, Personio, JazzHR, Breezy, Recruitee, Polymer | ★★★★★ | $0.10/1k jobs |
| `worldunboxer/rapid-linkedin-scraper` | LinkedIn | ★★★ | Free |
| `stealth_mode/naukri` | Naukri.com | ★★★★ | $0.003/job |

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `MONGODB_URI` | Yes | MongoDB Atlas connection string |
| `APIFY_API_KEY` | Yes | Apify API key for scrapers |
| `NODE_ENV` | No | Set to `production` on Render |
