// set_profile.js — captures user's resume and job requirements
// FIRST tool to call. Sets context for find_jobs.
// No DB needed — Claude holds the profile in conversation context.

import fs from "fs";
import https from "https";
import http from "http";

export const setProfileTool = {
  name: "set_profile",
  description:
    "FIRST STEP: Set up the user's job search profile before searching. User provides their resume text (or PDF URL), desired role, location, employment type, and experience level. Call this before find_jobs.",
  inputSchema: {
    type: "object",
    properties: {
      resume_text: {
        type: "string",
        description: "Paste the full resume text here. Alternatively provide resume_url.",
      },
      resume_url: {
        type: "string",
        description: "Public URL to a resume PDF. Google Drive: use export link. If provided, resume_text is not needed.",
      },
      role: {
        type: "string",
        description: "Target job role. e.g. 'Full Stack Developer', 'Backend Engineer', 'React Developer'",
      },
      location: {
        type: "string",
        description: "Preferred work location. e.g. 'Noida', 'Gurugram', 'Delhi NCR', 'Remote'",
      },
