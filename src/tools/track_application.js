import { Application, Job } from "../db/schemas.js";
import mongoose from "mongoose";

export const trackApplicationTool = {
  name: "track_application",
  description:
    "Save, update, or view your job applications. Track which jobs you've applied to, their status, and add notes. Statuses: saved, applied, interviewing, offered, rejected, withdrawn.",
  inputSchema: {
    type: "object",
    required: ["action"],
    properties: {
      action: {
        type: "string",
        description: "One of: save, update, list, delete",
      },
      job_id: {
        type: "string",
        description: "Job ID (required for save, update, delete)",
      },
      user_id: {
        type: "string",
        description: "Your identifier — use any consistent string like your name or email",
      },
      status: {
        type: "string",
        description: "Application status: saved, applied, interviewing, offered, rejected, withdrawn",
      },
      notes: {
        type: "string",
        description: "Your notes about this application",
      },
    },
  },
};

export async function trackApplication(args) {
  const { action, job_id, user_id = "default_user", status, notes } = args;

  switch (action) {

    // ── SAVE ────────────────────────────────────────────────────────────────────
    case "save": {
      if (!job_id) return "Please provide a job_id to save.";
      if (!mongoose.Types.ObjectId.isValid(job_id)) return `Invalid job_id: "${job_id}"`;

      const job = await Job.findById(job_id).lean();
      if (!job) return `Job not found with ID: ${job_id}`;

      const existing = await Application.findOne({ userId: user_id, jobId: job_id });
      if (existing) {
        return `You already have this job saved (status: ${existing.status}). Use action: "update" to change its status.`;
      }

      const app = await Application.create({
        userId:    user_id,
        jobId:     job_id,
        status:    status || "saved",
        notes:     notes || "",
        appliedAt: status === "applied" ? new Date() : undefined,
      });

      return [
        `✅ Saved: **${job.title}** at **${job.company}**`,
        `Status: ${app.status}`,
        `Apply here: ${job.applyUrl || job.listingUrl || "N/A"}`,
        notes ? `Notes: ${notes}` : "",
      ].filter(Boolean).join("\n");
    }

    // ── UPDATE ──────────────────────────────────────────────────────────────────
    case "update": {
      if (!job_id) return "Please provide a job_id to update.";

      const app = await Application.findOne({ userId: user_id, jobId: job_id });
      if (!app) return `No saved application found for job ID: ${job_id}. Save it first using action: "save".`;

      const oldStatus = app.status;
      if (status) app.status = status;
      if (notes) app.notes = notes;
      if (status === "applied" && !app.appliedAt) app.appliedAt = new Date();
      await app.save();

      return `✅ Updated application status: ${oldStatus} → ${app.status}${notes ? `\nNotes: ${notes}` : ""}`;
    }

    // ── LIST ────────────────────────────────────────────────────────────────────
    case "list": {
      const filter = { userId: user_id };
      if (status) filter.status = status;

      const apps = await Application.find(filter)
        .populate("jobId", "title company applyUrl listingUrl salaryMin salaryMax")
        .sort({ updatedAt: -1 })
        .lean();

      if (!apps.length) {
        return status
          ? `No applications with status "${status}". Try action: "list" without a status filter.`
          : "No saved applications yet. Use action: \"save\" with a job_id to start tracking.";
      }

      const grouped = {};
      for (const app of apps) {
        if (!grouped[app.status]) grouped[app.status] = [];
        grouped[app.status].push(app);
      }

      const statusEmoji = {
        saved: "🔖", applied: "📤", interviewing: "🎤",
        offered: "🎉", rejected: "❌", withdrawn: "↩️",
      };

      const lines = [`**Your Applications (${apps.length} total)**\n`];
      for (const [st, list] of Object.entries(grouped)) {
        lines.push(`${statusEmoji[st] || "•"} **${st.toUpperCase()}** (${list.length})`);
        for (const app of list) {
          const job = app.jobId;
          const salary = job?.salaryMin && job?.salaryMax
            ? ` | $${(job.salaryMin / 1000).toFixed(0)}k–$${(job.salaryMax / 1000).toFixed(0)}k`
            : "";
          lines.push(`  • ${job?.title || "Unknown"} at ${job?.company || "Unknown"}${salary}`);
          if (app.notes) lines.push(`    Note: ${app.notes}`);
        }
      }

      return lines.join("\n");
    }

    // ── DELETE ──────────────────────────────────────────────────────────────────
    case "delete": {
      if (!job_id) return "Please provide a job_id to delete.";
      const result = await Application.deleteOne({ userId: user_id, jobId: job_id });
      return result.deletedCount
        ? `✅ Removed application from your tracker.`
        : `No application found to delete for job ID: ${job_id}`;
    }

    default:
      return `Unknown action: "${action}". Use one of: save, update, list, delete`;
  }
}
