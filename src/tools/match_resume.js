import fs from "fs";
import path from "path";
import https from "https";
import http from "http";
import { Job } from "../db/schemas.js";

// Download file from URL to temp path
async function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith("https") ? https : http;
    const file = fs.createWriteStream(destPath);
    protocol.get(url, (res) => {
      res.pipe(file);
      file.on("finish", () => { file.close(); resolve(); });
    }).on("error", (err) => {
      fs.unlink(destPath, () => {});
      reject(err);
    });
  });
}

// Extract text from PDF buffer using pdf-parse
async function extractPdfText(filePath) {
  const { default: pdfParse } = await import("pdf-parse/lib/pdf-parse.js");
  const buffer = fs.readFileSync(filePath);
  const data = await pdfParse(buffer);
  return data.text;
}

export const matchResumeTool = {
  name: "match_resume",
  description:
    "Match a resume against current job listings. Provide either a PDF URL or paste resume text directly. Returns resume content + top matching jobs so Claude can score and rank them for you.",
  inputSchema: {
    type: "object",
    properties: {
      resume_url: {
        type: "string",
        description: "Public URL to a resume PDF file (Google Drive share link, Dropbox, etc.)",
      },
      resume_text: {
        type: "string",
        description: "Or paste resume text directly if you don't have a URL",
      },
      role: {
        type: "string",
        description: "Target job role to match against, e.g. 'backend engineer'",
      },
      remote_only: {
        type: "boolean",
        description: "Only match against remote jobs",
      },
      top_n: {
        type: "number",
        description: "Number of jobs to match against (default 15)",
      },
    },
  },
};

export async function matchResume(args) {
  const { resume_url, resume_text, role, remote_only, top_n = 15 } = args;

  let resumeContent = "";

  // ── Get resume text ──────────────────────────────────────────────────────────
  if (resume_text) {
    resumeContent = resume_text;
  } else if (resume_url) {
    const tmpPath = `/tmp/resume_${Date.now()}.pdf`;
    try {
      await downloadFile(resume_url, tmpPath);
      resumeContent = await extractPdfText(tmpPath);
    } catch (err) {
      return `Could not download or read the PDF: ${err.message}\n\nTip: Make sure the URL is publicly accessible. Google Drive: use "Anyone with link can view".`;
    } finally {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    }
  } else {
    return "Please provide either a resume_url (PDF link) or resume_text.";
  }

  if (!resumeContent || resumeContent.trim().length < 50) {
    return "Could not extract enough text from the resume. Try pasting the resume text directly using resume_text parameter.";
  }

  // ── Fetch candidate jobs from DB ─────────────────────────────────────────────
  const jobQuery = { isActive: true };
  if (remote_only) jobQuery.isRemote = true;
  if (role) jobQuery.$text = { $search: role };

  const jobs = await Job.find(jobQuery)
    .sort({ datePosted: -1 })
    .limit(Math.min(top_n, 25))
    .lean();

  if (!jobs.length) {
    return "No jobs found in the database yet. Run the job scraper first or broaden your search.";
  }

  // ── Format for Claude to do the matching ─────────────────────────────────────
  // Claude (running in the user's session) will read this and score each job
  const jobList = jobs.map((j, i) => {
    const salary =
      j.salaryMin && j.salaryMax
        ? `Salary: $${(j.salaryMin / 1000).toFixed(0)}k–$${(j.salaryMax / 1000).toFixed(0)}k/yr`
        : "Salary: not specified";
    return [
      `--- JOB ${i + 1} ---`,
      `ID: ${j._id}`,
      `Title: ${j.title}`,
      `Company: ${j.company}`,
      `${salary}`,
      `Location: ${j.isRemote ? "Remote" : j.location || "N/A"}`,
      `Level: ${j.experienceLevel || "not specified"}`,
      `Skills required: ${(j.skills || []).join(", ") || "not listed"}`,
      `Description snippet: ${(j.description || "").slice(0, 400)}`,
      `Apply: ${j.applyUrl || j.listingUrl || "N/A"}`,
    ].join("\n");
  }).join("\n\n");

  return [
    "=== RESUME CONTENT ===",
    resumeContent.slice(0, 3000), // keep within context limits
    "",
    `=== ${jobs.length} CANDIDATE JOBS TO MATCH AGAINST ===`,
    jobList,
    "",
    "=== INSTRUCTIONS FOR CLAUDE ===",
    "Please analyze the resume above and score each job on a 0-100 match scale.",
    "Consider: skills overlap, experience level, job requirements vs candidate background.",
    "Return the top matches ranked by score with a 1-line reason for each.",
    "Format: [Score]% match — Job Title at Company — Reason",
  ].join("\n");
}
