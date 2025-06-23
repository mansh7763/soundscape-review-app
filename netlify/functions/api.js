const { Pool } = require("pg");

// PostgreSQL connection with Session Pooler
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
});

// Helper function to handle CORS
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

// Main handler function
exports.handler = async (event, context) => {
  // Handle preflight OPTIONS request
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: "",
    };
  }

  try {
    const path = event.path.replace("/.netlify/functions/api", "");
    const method = event.httpMethod;

    // Route handling
    if (path === "/reviews" && method === "GET") {
      return await getReviews(event);
    } else if (path === "/reviews" && method === "POST") {
      return await submitReview(event);
    } else if (path === "/admin/reviews" && method === "GET") {
      return await getAllReviews(event);
    } else if (path === "/admin/analytics" && method === "GET") {
      return await getAnalytics(event);
    }

    // 404 for unknown routes
    return {
      statusCode: 404,
      headers: corsHeaders,
      body: JSON.stringify({ error: "Not found" }),
    };
  } catch (error) {
    console.error("Handler error:", error);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: "Internal server error" }),
    };
  }
};

// Get reviews for a specific session
async function getReviews(event) {
  try {
    const { sessionId } = event.queryStringParameters || {};

    if (!sessionId) {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({ error: "Session ID is required" }),
      };
    }

    const result = await pool.query(
      "SELECT * FROM reviews WHERE session_id = $1 ORDER BY created_at DESC",
      [sessionId]
    );

    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({
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
      }),
    };
  } catch (error) {
    console.error("Error fetching reviews:", error);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: "Internal server error" }),
    };
  }
}

// Submit a new review
async function submitReview(event) {
  try {
    const body = JSON.parse(event.body);
    const {
      audioId,
      title,
      rating,
      timestamp,
      date,
      time,
      userAgent,
      sessionId,
    } = body;

    // Validate required fields
    if (!audioId || !title || rating === undefined || !sessionId) {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({
          error: "Missing required fields: audioId, title, rating, sessionId",
        }),
      };
    }

    // Validate rating range
    if (rating < 0 || rating > 5) {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({
          error: "Rating must be between 0 and 5",
        }),
      };
    }

    // Get client IP from Netlify headers
    const clientIp =
      event.headers["x-forwarded-for"] ||
      event.headers["x-real-ip"] ||
      "unknown";

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

    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({
        success: true,
        id: result.rows[0].id,
        message: "Review submitted successfully",
      }),
    };
  } catch (error) {
    console.error("Error submitting review:", error);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: "Internal server error" }),
    };
  }
}

// Admin endpoint to get all reviews
async function getAllReviews(event) {
  try {
    const {
      limit = 1000,
      offset = 0,
      format = "json",
    } = event.queryStringParameters || {};

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

      return {
        statusCode: 200,
        headers: {
          ...corsHeaders,
          "Content-Type": "text/csv",
          "Content-Disposition": `attachment; filename="reviews-${
            new Date().toISOString().split("T")[0]
          }.csv"`,
        },
        body: csvContent,
      };
    } else {
      return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify({
          success: true,
          reviews,
          totalCount:
            result.rows.length > 0 ? parseInt(result.rows[0].total_count) : 0,
          pagination: {
            limit: parseInt(limit),
            offset: parseInt(offset),
          },
        }),
      };
    }
  } catch (error) {
    console.error("Error fetching all reviews:", error);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: "Internal server error" }),
    };
  }
}

// Get analytics/statistics
async function getAnalytics(event) {
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

    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({
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
      }),
    };
  } catch (error) {
    console.error("Error fetching analytics:", error);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: "Internal server error" }),
    };
  }
}
