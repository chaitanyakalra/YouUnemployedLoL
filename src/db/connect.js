import mongoose from "mongoose";

let isConnected = false;

export async function connectDB() {
  if (isConnected) return;

  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error("⚠️  MONGODB_URI not set — DB features will be unavailable");
    return;
  }

  try {
    await mongoose.connect(uri);
    isConnected = true;
    console.error("✅ MongoDB connected");
  } catch (err) {
    console.error("⚠️  MongoDB connection failed:", err.message);
    console.error("    DB-dependent tools will return errors until connection is restored.");
    // Retry every 30 seconds
    setTimeout(connectDB, 30_000);
  }
}
