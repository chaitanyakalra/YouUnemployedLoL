import mongoose from "mongoose";

// ─── Job Schema ────────────────────────────────────────────────────────────────
const jobSchema = new mongoose.Schema(
  {
    // Core fields
    externalId:      { type: String, required: true },
    source:          { type: String, required: true }, // "greenhouse","lever","linkedin","naukri"
    title:           { type: String, required: true },
    company:         { type: String, required: true },
    companyLogo:     { type: String },
    companyWebsite:  { type: String },

    // Location
    location:        { type: String },
    city:            { type: String },
    country:         { type: String },
    isRemote:        { type: Boolean, default: false },

    // Compensation
    salaryMin:       { type: Number },
    salaryMax:       { type: Number },
    salaryCurrency:  { type: String, default: "USD" },
    salaryPeriod:    { type: String, default: "yearly" },

    // Role details
    employmentType:  { type: String }, // full_time, part_time, contract
    experienceLevel: { type: String }, // junior, mid, senior, lead
    department:      { type: String },
    description:     { type: String },
    skills:          [{ type: String }],

    // URLs
    listingUrl:      { type: String },
    applyUrl:        { type: String },

    // Metadata
    datePosted:      { type: Date },
    dateScraped:     { type: Date, default: Date.now },
    isActive:        { type: Boolean, default: true },
  },
  { timestamps: true }
);

// Indexes for fast querying
jobSchema.index({ title: "text", description: "text", company: "text" });
jobSchema.index({ source: 1, externalId: 1 }, { unique: true });
jobSchema.index({ isRemote: 1, isActive: 1 });
jobSchema.index({ salaryMin: 1, salaryMax: 1 });
jobSchema.index({ datePosted: -1 });
jobSchema.index({ skills: 1 });

// ─── Application Schema ────────────────────────────────────────────────────────
const applicationSchema = new mongoose.Schema(
  {
    userId:      { type: String, required: true }, // session-based user identifier
    jobId:       { type: mongoose.Schema.Types.ObjectId, ref: "Job", required: true },
    status:      {
      type: String,
      enum: ["saved", "applied", "interviewing", "offered", "rejected", "withdrawn"],
      default: "saved",
    },
    appliedAt:   { type: Date },
    notes:       { type: String },
    resumeUsed:  { type: String }, // which resume version was used
  },
  { timestamps: true }
);

applicationSchema.index({ userId: 1, status: 1 });
applicationSchema.index({ userId: 1, jobId: 1 }, { unique: true });

// ─── Job Search Schema (Async Polling) ────────────────────────────────────────
const jobSearchSchema = new mongoose.Schema(
  {
    searchId:   { type: String, required: true, unique: true },
    status:     { type: String, enum: ["pending", "completed", "failed"], default: "pending" },
    query:      { type: Object }, // Store original request params
    results:    { type: String }, // Final Markdown table
    jobCount:   { type: Number, default: 0 },
    error:      { type: String },
    expiresAt:  { type: Date, required: true, index: { expires: 0 } }, // Auto-delete
  },
  { timestamps: true }
);

// ─── Session Schema (Persistence across restarts) ──────────────────────────────
const sessionSchema = new mongoose.Schema(
  {
    sessionId: { type: String, required: true, unique: true },
    lastActive: { type: Date, default: Date.now },
    // We don't store the transport (binary/circular), just the metadata
    metadata: { type: Object, default: {} }, 
  },
  { timestamps: true }
);

sessionSchema.index({ lastActive: 1 }, { expireAfterSeconds: 86400 }); // 24h cleanup

// ─── Models ───────────────────────────────────────────────────────────────────
export const Job         = mongoose.models.Job         || mongoose.model("Job", jobSchema);
export const Application = mongoose.models.Application || mongoose.model("Application", applicationSchema);
export const JobSearch   = mongoose.models.JobSearch   || mongoose.model("JobSearch", jobSearchSchema);
export const Session     = mongoose.models.Session     || mongoose.model("Session", sessionSchema);
