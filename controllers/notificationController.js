const pool = require('../config/db');

// Get Notifications
const getNotifications = async (req, res) => {
  const userId = req.user.id;

  try {
    const { rows } = await pool.query(
      `SELECT id, title, message, type, is_read, created_at, related_user_id 
       FROM notifications 
       WHERE user_id = $1 
       ORDER BY created_at DESC 
       LIMIT 30`,
      [userId]
    );

    res.json({ 
      success: true, 
      notifications: rows 
    });
  } catch (error) {
    console.error("Get Notifications Error:", error);
    res.status(500).json({ success: false, message: "Failed to load notifications" });
  }
};

// Mark as Read
const markAsRead = async (req, res) => {
  const { id } = req.params;
  const userId = req.user.id;

  try {
    const { rowCount } = await pool.query(
      `UPDATE notifications 
       SET is_read = TRUE 
       WHERE id = $1 AND user_id = $2`,
      [id, userId]
    );

    if (rowCount === 0) {
      return res.status(404).json({ success: false, message: "Notification not found" });
    }

    res.json({ success: true, message: "Marked as read" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: "Failed to update" });
  }
};

// Mark notifications of a specific type and related user as read
const markTypeRead = async (req, res) => {
  const { type, relatedUserId } = req.params;
  const userId = req.user.id;

  try {
    await pool.query(
      `UPDATE notifications 
       SET is_read = TRUE 
       WHERE user_id = $1 AND type = $2 AND related_user_id = $3`,
      [userId, type, relatedUserId]
    );

    res.json({ success: true, message: `Notifications for ${type} marked as read` });
  } catch (error) {
    console.error("Mark Type Read Error:", error);
    res.status(500).json({ success: false, message: "Failed to update notifications" });
  }
};

// Helper to create notification (call from other controllers)
const createNotification = async (userId, title, message, type = 'info', relatedUserId = null, io = null) => {
  try {
    const schoolRes = await pool.query('SELECT school_id FROM users WHERE id = $1', [userId]);
    const schoolId = schoolRes.rows[0]?.school_id || null;

    // Deduplication logic: Overwrite existing unread notification of the same type/user
    const { rows: existing } = await pool.query(
      `SELECT id FROM notifications 
       WHERE user_id = $1 AND type = $2 AND related_user_id = $3 AND is_read = FALSE`,
      [userId, type, relatedUserId]
    );

    let rows;
    if (existing.length > 0) {
      rows = (await pool.query(
        `UPDATE notifications SET title = $1, message = $2, created_at = CURRENT_TIMESTAMP WHERE id = $3 RETURNING *`,
        [title, message, existing[0].id]
      )).rows;
    } else {
      rows = (await pool.query(
        `INSERT INTO notifications (school_id, user_id, title, message, type, related_user_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [schoolId, userId, title, message, type, relatedUserId]
      )).rows;
    }

    // Emit real-time notification via Socket.io
    if (io) {
      io.to(`user_${userId}`).emit('newNotification', rows[0]);
    }
  } catch (error) {
    console.error("Create Notification Error:", error);
  }
};

module.exports = {
  getNotifications,
  markAsRead,
  createNotification,
  markTypeRead
};
