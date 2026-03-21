// set_profile.js — captures user's resume and job requirements
// FIRST tool to call. Sets context for find_jobs.
// No DB needed — Claude holds the profile in conversation context.

export const setProfileTool = {
  name: "set_profile",
  description:
    "FIRST STEP: Set up the user's job search profile before searching. User provides their resume text (or PDF URL), desired role, location, employment type, and experience level. Call this before find_jobs.",
  inputSchema: {
    type: "object",
    properties: {
      resume_text: {
        type: "string",
        description:
          "Paste the full resume text here. Alternatively provide resume_url.",
      },
      resume_url: {
        type: "string",
        description:
          "Public URL to a resume PDF. Google Drive: use export link. If provided, resume_text is not needed.",
      },
      role: {
        type: "string",
        description:
          "Target job role. e.g. 'Full Stack Developer', 'Backend Engineer', 'React Developer'",
      },
      location: {
        type: "string",
        description:
          "Preferred work location. e.g. 'Noida', 'Gurugram', 'Delhi NCR', 'Remote'",
      },
      employment_type: {
        type: "string",
        description:
          "Employment type: 'full-time', 'part-time', 'internship', 'contract'",
      },
      experience_level: {
        type: "string",
        description:
          "Experience level: 'entry', 'mid', 'senior', 'lead', 'internship'",
      },
    },
  },
};

export async function setProfile(args) {
  const {
    resume_text,
    resume_url,
    role,
    location,
    employment_type,
    experience_level,
  } = args || {};

  // Detect missing required fields and ask the user
  const missing = [];
  if (!resume_text && !resume_url) missing.push("resume (paste text or provide a URL)");
  if (!role) missing.push("desired role (e.g. 'Backend Engineer', 'React Developer')");
  if (!location) missing.push("preferred location (e.g. 'Noida', 'Remote')");
  if (!experience_level) missing.push("experience level (entry / mid / senior / internship)");

  if (missing.length > 0) {
    return (
      `Before I can search for jobs, I need a few more details:\n\n` +
      missing.map((m, i) => `${i + 1}. ${m}`).join("\n") +
      `\n\nPlease provide these and I'll set up your profile and start searching.`
    );
  }

  // Build a summary card to confirm back to the user
  const lines = [
    `✅ **Profile set! Here's what I have:**`,
    ``,
    `- **Role:** ${role}`,
    `- **Location:** ${location}`,
    `- **Employment type:** ${employment_type || "not specified (will search all)"}`,
    `- **Experience level:** ${experience_level}`,
    `- **Resume:** ${resume_url ? `URL provided (${resume_url})` : `${resume_text.slice(0, 80).trim()}…`}`,
    ``,
    `Now call **find_jobs** to search for matching roles.`,
  ];

  return lines.join("\n");
}
