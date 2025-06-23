const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const path = require("path");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static("public")); // Serve static files

// PostgreSQL connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl:
    process.env.NODE_ENV === "production"
      ? { rejectUnauthorized: false }
      : false,
});

// Initialize database table
async function initDatabase() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS reviews (
        id SERIAL PRIMARY KEY,
        audio_id INTEGER NOT NULL,
        title VARCHAR(500) NOT NULL,
        rating DECIMAL(3,2) NOT NULL CHECK (rating >= 0 AND rating <= 5),
        timestamp TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        date VARCHAR(20) NOT NULL,
        time VARCHAR(20) NOT NULL,
        user_agent TEXT,
        session_id VARCHAR(100) NOT NULL,
        ip_address INET,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create index for better performance
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_reviews_session_id ON reviews(session_id);
      CREATE INDEX IF NOT EXISTS idx_reviews_audio_id ON reviews(audio_id);
      CREATE INDEX IF NOT EXISTS idx_reviews_created_at ON reviews(created_at);
    `);

    console.log("Database initialized successfully");
  } catch (error) {
    console.error("Error initializing database:", error);
  }
}

// API Routes

// Get reviews for a specific session
app.get("/api/reviews", async (req, res) => {
  try {
    const { sessionId } = req.query;

    if (!sessionId) {
      return res.status(400).json({ error: "Session ID is required" });
    }

    const result = await pool.query(
      "SELECT * FROM reviews WHERE session_id = $1 ORDER BY created_at DESC",
      [sessionId]
    );

    res.json({
      success: true,
      reviews: result.rows.map((row) => ({
        id: row.id,
        audioId: row.audio_id,
        title: row.title,
        rating: parseFloat(row.rating),
        timestamp: row.timestamp,
        date: row.date,
        time: row.time,
        sessionId: row.session_id,
        createdAt: row.created_at,
      })),
    });
  } catch (error) {
    console.error("Error fetching reviews:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Submit a new review
app.post("/api/reviews", async (req, res) => {
  try {
    const {
      audioId,
      title,
      rating,
      timestamp,
      date,
      time,
      userAgent,
      sessionId,
    } = req.body;

    // Validate required fields
    if (!audioId || !title || rating === undefined || !sessionId) {
      return res.status(400).json({
        error: "Missing required fields: audioId, title, rating, sessionId",
      });
    }

    // Validate rating range
    if (rating < 0 || rating > 5) {
      return res.status(400).json({
        error: "Rating must be between 0 and 5",
      });
    }

    const clientIp = req.ip || req.connection.remoteAddress;

    // Check if review already exists for this session and audio
    const existingReview = await pool.query(
      "SELECT id FROM reviews WHERE session_id = $1 AND audio_id = $2",
      [sessionId, audioId]
    );

    let result;
    if (existingReview.rows.length > 0) {
      // Update existing review
      result = await pool.query(
        `UPDATE reviews 
         SET title = $1, rating = $2, timestamp = $3, date = $4, time = $5, 
             user_agent = $6, ip_address = $7, updated_at = CURRENT_TIMESTAMP
         WHERE session_id = $8 AND audio_id = $9
         RETURNING id`,
        [
          title,
          rating,
          timestamp,
          date,
          time,
          userAgent,
          clientIp,
          sessionId,
          audioId,
        ]
      );
    } else {
      // Insert new review
      result = await pool.query(
        `INSERT INTO reviews (audio_id, title, rating, timestamp, date, time, user_agent, session_id, ip_address)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING id`,
        [
          audioId,
          title,
          rating,
          timestamp,
          date,
          time,
          userAgent,
          sessionId,
          clientIp,
        ]
      );
    }

    res.json({
      success: true,
      id: result.rows[0].id,
      message: "Review submitted successfully",
    });
  } catch (error) {
    console.error("Error submitting review:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Admin endpoint to get all reviews (for data export)
app.get("/api/admin/reviews", async (req, res) => {
  try {
    const { limit = 1000, offset = 0, format = "json" } = req.query;

    const result = await pool.query(
      `SELECT r.*, 
        COUNT(*) OVER() as total_count
       FROM reviews r 
       ORDER BY r.created_at DESC 
       LIMIT $1 OFFSET $2`,
      [parseInt(limit), parseInt(offset)]
    );

    const reviews = result.rows.map((row) => ({
      id: row.id,
      audioId: row.audio_id,
      title: row.title,
      rating: parseFloat(row.rating),
      timestamp: row.timestamp,
      date: row.date,
      time: row.time,
      userAgent: row.user_agent,
      sessionId: row.session_id,
      ipAddress: row.ip_address,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));

    if (format === "csv") {
      // Return CSV format
      const headers = [
        "ID",
        "Audio ID",
        "Title",
        "Rating",
        "Date",
        "Time",
        "Session ID",
        "IP Address",
        "Created At",
      ];
      const csvContent = [
        headers.join(","),
        ...reviews.map((review) =>
          [
            review.id,
            review.audioId,
            `"${review.title.replace(/"/g, '""')}"`,
            review.rating,
            review.date,
            review.time,
            review.sessionId,
            review.ipAddress,
            review.createdAt,
          ].join(",")
        ),
      ].join("\n");

      res.setHeader("Content-Type", "text/csv");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="reviews-${
          new Date().toISOString().split("T")[0]
        }.csv"`
      );
      res.send(csvContent);
    } else {
      res.json({
        success: true,
        reviews,
        totalCount:
          result.rows.length > 0 ? parseInt(result.rows[0].total_count) : 0,
        pagination: {
          limit: parseInt(limit),
          offset: parseInt(offset),
        },
      });
    }
  } catch (error) {
    console.error("Error fetching all reviews:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Get analytics/statistics
app.get("/api/admin/analytics", async (req, res) => {
  try {
    const analytics = await pool.query(`
      SELECT 
        COUNT(*) as total_reviews,
        AVG(rating) as average_rating,
        COUNT(DISTINCT session_id) as unique_sessions,
        COUNT(DISTINCT audio_id) as reviewed_audios,
        MIN(created_at) as first_review,
        MAX(created_at) as latest_review
      FROM reviews
    `);

    const ratingDistribution = await pool.query(`
      SELECT 
        FLOOR(rating) as rating_floor,
        COUNT(*) as count
      FROM reviews
      GROUP BY FLOOR(rating)
      ORDER BY rating_floor
    `);

    const audioStats = await pool.query(`
      SELECT 
        audio_id,
        title,
        COUNT(*) as review_count,
        AVG(rating) as average_rating
      FROM reviews
      GROUP BY audio_id, title
      ORDER BY review_count DESC
    `);

    res.json({
      success: true,
      analytics: {
        totalReviews: parseInt(analytics.rows[0].total_reviews),
        averageRating: parseFloat(
          analytics.rows[0].average_rating || 0
        ).toFixed(2),
        uniqueSessions: parseInt(analytics.rows[0].unique_sessions),
        reviewedAudios: parseInt(analytics.rows[0].reviewed_audios),
        firstReview: analytics.rows[0].first_review,
        latestReview: analytics.rows[0].latest_review,
        ratingDistribution: ratingDistribution.rows,
        audioStats: audioStats.rows.map((row) => ({
          audioId: row.audio_id,
          title: row.title,
          reviewCount: parseInt(row.review_count),
          averageRating: parseFloat(row.average_rating).toFixed(2),
        })),
      },
    });
  } catch (error) {
    console.error("Error fetching analytics:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Serve the main application
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({ status: "OK", timestamp: new Date().toISOString() });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "Internal server error" });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: "Not found" });
});

// Initialize database and start server
async function startServer() {
  await initDatabase();
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Environment: ${process.env.NODE_ENV || "development"}`);
  });
}

startServer().catch(console.error);
