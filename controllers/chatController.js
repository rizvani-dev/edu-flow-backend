const pool = require('../config/db');
const { createNotification } = require('./notificationController');
const { mapMediaFields, mapMediaFieldsList } = require('../utils/media');
const { del } = require('../services/cacheService');
const { withCache } = require('../services/cacheService');

const detectMessageType = (file) => {
  const mime = String(file?.mimetype || '').toLowerCase();
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  
  // Fallback for .webm and common audio extensions if mimetype is generic or incorrectly reported
  const ext = String(file?.originalname || '').toLowerCase();
  if (ext.endsWith('.webm') || ext.endsWith('.ogg') || ext.endsWith('.wav') || ext.endsWith('.opus')) return 'audio';
  // Priority to mimetype for processed images
  if (mime.startsWith('image/') || /\.(jpg|jpeg|png|gif|webp|svg|heic|heif)$/i.test(ext)) return 'image';
  
  return file ? 'file' : 'text';
};

const MESSAGE_PAGE_LIMIT = 20;

// Teacher sends message (text + file) to specific student (renamed from sendMessage)
const sendTeacherMessage = async (req, res) => {
  const teacherId = parseInt(req.user.id, 10);
  const schoolId = req.user.school_id;
  const studentId = parseInt(req.params.studentId, 10);
  const { message } = req.body;
  const file = req.file;

  if (!studentId) {
    return res.status(400).json({ success: false, message: "Student ID is required" });
  }

  try {
    let fileUrl = null;
    let fileName = null;
    let fileMime = null;
    let fileSize = null;
    let messageType = 'text';

    if (file) {
      fileUrl = file.path;
      fileName = file.originalname;
      fileMime = file.mimetype || null;
      fileSize = file.size || null;
      messageType = detectMessageType(file);
    }

    const { rows } = await pool.query(
      `INSERT INTO messages (sender_id, receiver_id, message, file_url, file_name, file_mime, file_size, message_type, status, school_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) 
       RETURNING *`,
      [teacherId, studentId, message || '', fileUrl, fileName, fileMime, fileSize, messageType, 'sent', schoolId]
    );

    const chatMessage = mapMediaFields(rows[0], ['file_url']);

    // Notify the student
    await createNotification(
      studentId,
      "New Message from Teacher",
      message ? message.substring(0, 80) + (message.length > 80 ? "..." : "") : "Sent a file",
      'chat',
      teacherId,
      req.app.get('socketio')
    );

    res.status(201).json({
      success: true,
      message: "Message sent successfully",
      chat: chatMessage
    });
  } catch (error) {
    console.error("Teacher Send Message Error [500]:", error.message);
    res.status(500).json({ success: false, message: "Server error: " + error.message });
  }
};

// Get chat history between teacher and student
const getTeacherMessages = async (req, res) => { // Renamed from getMessages
  const teacherId = req.user.id;
  const { studentId } = req.params;
  const schoolId = req.user.school_id;
  const offset = parseInt(req.query.offset) || 0;

  if (!studentId) {
    return res.status(400).json({ success: false, message: "Student ID is required" });
  }

  try {
    const { rows, rowCount } = await pool.query(
      `SELECT m.*, u.name as sender_name 
       FROM messages m 
       LEFT JOIN users u ON m.sender_id = u.id
       WHERE (
          (m.sender_id = $1 AND m.receiver_id = $2) 
          OR (m.sender_id = $2 AND m.receiver_id = $1)
       )
       AND m.school_id = $3
       AND NOT ($1 = ANY(COALESCE(m.deleted_for, ARRAY[]::int[])))
       ORDER BY m.created_at DESC
       LIMIT $4 OFFSET $5`,
      [teacherId, studentId, schoolId, MESSAGE_PAGE_LIMIT, offset]
    );

    res.json({
      success: true,
      messages: mapMediaFieldsList(rows.reverse(), ['file_url']),
      hasMore: rows.length === MESSAGE_PAGE_LIMIT,
    });
  } catch (error) {
    console.error("Teacher Get Messages Error:", error);
    res.status(500).json({ success: false, message: "Failed to load messages" });
  }
};

const deleteMessagesBulk = async (req, res) => { // This function is used by both teacher and student
  const userId = req.user.id;
  const { messageIds, type } = req.body;

  if (!messageIds || !Array.isArray(messageIds)) {
    return res.status(400).json({ success: false, message: "Invalid message IDs" });
  }

  try {
    if (type === 'everyone') {
      // Update message to show it was deleted for everyone (WhatsApp style)
      await pool.query(
        `UPDATE messages 
         SET message = '🚫 This message was deleted', 
             file_url = NULL, 
             file_name = NULL,
             file_mime = NULL,
             file_size = NULL,
             reactions = '{}'::jsonb,
             deleted_for_everyone = true,
             message_type = 'text',
             status = 'deleted'
         WHERE id = ANY($1::int[]) AND sender_id = $2`,
        [messageIds, userId]
      );
    } else {
      // "Delete for me" - hide the message for current user only (no hard delete)
      await pool.query(
        `UPDATE messages
         SET deleted_for = ARRAY(
           SELECT DISTINCT x 
           FROM UNNEST(COALESCE(deleted_for, ARRAY[]::int[]) || $2::int) AS x
         )
         WHERE id = ANY($1::int[])
           AND ($2 IN (sender_id, receiver_id))`,
        [messageIds, userId]
      );
    }

    res.json({ success: true, message: "Messages deleted/updated successfully" });
  } catch (error) {
    console.error("Delete Messages Error:", error);
    res.status(500).json({ success: false, message: "Failed to delete messages" });
  }
};

// Admin sends direct message to any user (with file support)
const sendAdminMessage = async (req, res) => {
  const adminId = parseInt(req.user.id, 10);
  const schoolId = req.user.school_id;
  const receiverId = parseInt(req.params.userId, 10);
  const { message } = req.body;
  const file = req.file;

  try {
    if (!message?.trim() && !file) {
      return res.status(400).json({ success: false, message: 'Message or file is required' });
    }

    let fileUrl = null;
    let fileName = null;
    let fileMime = null;
    let fileSize = null;
    let messageType = 'text';

    if (file) {
      fileUrl = file.path;
      fileName = file.originalname;
      fileMime = file.mimetype || null;
      fileSize = file.size || null;
      messageType = detectMessageType(file);
    }

    const { rows } = await pool.query(
      `INSERT INTO messages (sender_id, receiver_id, message, file_url, file_name, file_mime, file_size, message_type, status, school_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [adminId, receiverId, message || '', fileUrl, fileName, fileMime, fileSize, messageType, 'sent', schoolId]
    );

    // Emit a specific event for real-time dashboard updates
    const io = req.app.get('socketio');
    if (io) {
      io.to('admins').emit('dashboardDataUpdate', { type: 'chat', senderId: adminId, receiverId });
    }

    await createNotification(
      receiverId,
      "Admin Message",
      message ? message.substring(0, 50) : "Sent a file",
      'chat',
      adminId,
      req.app.get('socketio')
    );

    res.status(201).json({ success: true, chat: mapMediaFields(rows[0], ['file_url']) });
  } catch (error) {
    console.error("Admin Send Message Error [500]:", error.message);
    res.status(500).json({ success: false, message: "Server error: " + error.message });
  }
};

// Get chat history between admin and any user
const getAdminMessages = async (req, res) => {
  const adminId = req.user.id;
  const { userId } = req.params;
  const schoolId = req.user.school_id;
  const rawLimit = Number(req.query.limit);
  const limit = Number.isFinite(rawLimit)
    ? Math.min(Math.max(rawLimit, 1), 100)
    : MESSAGE_PAGE_LIMIT;
  const beforeMessageId = Number(req.query.before);
  const offset = parseInt(req.query.offset) || 0;

  const cacheKey = `chat:admin:${adminId}:${userId}:${beforeMessageId || 'latest'}:${offset}`;

  try {
    const payload = await withCache(cacheKey, async () => {
      const params = [adminId, userId, schoolId];
      let paginationClause = '';

      if (Number.isFinite(beforeMessageId) && beforeMessageId > 0) {
        params.push(beforeMessageId);
        paginationClause = `AND m.id < $${params.length}`;
      }

      params.push(limit + 1);
      const limitPlaceholder = params.length;

      if (!paginationClause && offset > 0) {
        params.push(offset);
        paginationClause = `OFFSET $${params.length}`;
      }

      const { rows } = await pool.query(
        `SELECT m.*, u.name as sender_name 
         FROM messages m 
         LEFT JOIN users u ON m.sender_id = u.id
         JOIN users sender_user ON sender_user.id = m.sender_id
         JOIN users receiver_user ON receiver_user.id = m.receiver_id
         WHERE (
            (m.sender_id = $1 AND m.receiver_id = $2) 
            OR (m.sender_id = $2 AND m.receiver_id = $1)
         )
         AND sender_user.school_id = $3
         AND receiver_user.school_id = $3
         AND (m.school_id = $3 OR m.school_id IS NULL)
         AND NOT ($1 = ANY(COALESCE(m.deleted_for, ARRAY[]::int[])))
         ${paginationClause && !paginationClause.startsWith('OFFSET') ? paginationClause : ''}
         ORDER BY m.id DESC
         LIMIT $${limitPlaceholder}
         ${paginationClause.startsWith('OFFSET') ? paginationClause : ''}`,
        params
      );
      const hasMore = rows.length > limit;
      const pageRows = hasMore ? rows.slice(0, limit) : rows;
      
      return {
        success: true,
        messages: mapMediaFieldsList(pageRows.reverse(), ['file_url']),
        hasMore,
        pagination: {
          limit,
          hasMore,
          nextCursor: hasMore ? pageRows[pageRows.length - 1]?.id || null : null,
        },
      };
    }, 60); // Cache short history for 60 seconds

    return res.json(payload);
  } catch (error) {
    console.error("Admin Get Messages Error:", error);
    res.status(500).json({ success: false, message: "Failed to load messages" });
  }
};

// Admin broadcasts to entire class
const broadcastToClass = async (req, res) => {
  const adminId = parseInt(req.user.id, 10);
  const schoolId = req.user.school_id;
  const { class_id, message } = req.body;

  if (!class_id || !message) {
    return res.status(400).json({ success: false, message: "Class ID and message are required" });
  }

  const parsedClassId = parseInt(class_id, 10);
  if (isNaN(parsedClassId) || isNaN(adminId)) {
    return res.status(400).json({ success: false, message: "Invalid IDs provided" });
  }

  try {
    const classRes = await pool.query(
      'SELECT id, name FROM classes WHERE id = $1',
      [parsedClassId]
    );

    if (!classRes.rows.length) {
      return res.status(404).json({ success: false, message: 'Class not found' });
    }

    // Get all students and teachers in this class
    const usersRes = await pool.query(
      "SELECT id FROM users WHERE class_id = $1 AND id != $2",
      [parsedClassId, adminId]
    );

    const io = req.app.get('socketio');
    if (!io) {
      console.warn("Socket.io instance not found on app. Broadcast will not be real-time.");
    }

    // Truncate message for database insertion if it's excessively long
    // Adjust 5000 to a suitable maximum length based on your 'messages' table schema.
    // If your 'message' column is TEXT, this might not be strictly necessary but is a good safeguard.
    const messageToSave = message.substring(0, 5000);

    const targetUserIds = usersRes.rows.map(u => parseInt(u.id, 10));
    
    // Bulk insert using unnest for high performance
    const { rows: insertedMessages } = await pool.query(
      `INSERT INTO messages (sender_id, receiver_id, message, message_type, status, school_id)
       SELECT $1, unnest($2::int[]), $3, 'text', 'sent', $4
       RETURNING *`,
      [adminId, targetUserIds, messageToSave, schoolId]
    );

    // Emit real-time messages
    if (io) {
      insertedMessages.forEach((msg) => {
        io.to(`user_${msg.receiver_id}`).emit("receiveMessage", msg);
      });
      io.to('admins').emit('dashboardDataUpdate', { type: 'broadcast', classId: parsedClassId });
    }

    const preview = message.length > 80 ? message.substring(0, 80) + "..." : message;
    await Promise.all(targetUserIds.map(uid =>
      createNotification(uid, "Class Announcement", preview, 'chat', adminId, io)
    ));

    res.json({
      success: true,
      message: `Broadcast sent to ${usersRes.rowCount} users`,
      class: classRes.rows[0]
    });
  } catch (error) {
    console.error("Broadcast failed:", error); // Log the full error
    res.status(500).json({ success: false, message: "Broadcast failed: " + error.message }); // Send error message to client
  }
};

const updateMessageReaction = async (req, res) => {
  const userId = req.user.id;
  const { messageId, emoji } = req.body;

  if (!messageId || !emoji) {
    return res.status(400).json({ success: false, message: "Message ID and emoji are required" });
  }

  try {
    const { rows } = await pool.query(
      `SELECT reactions FROM messages WHERE id = $1`,
      [messageId]
    );

    if (!rows.length) {
      return res.status(404).json({ success: false, message: "Message not found" });
    }

    const currentReactions = rows[0].reactions || {};
    const emojiUsers = currentReactions[emoji] || [];

    let newEmojiUsers;
    if (emojiUsers.includes(userId)) {
      newEmojiUsers = emojiUsers.filter(id => id !== userId);
    } else {
      newEmojiUsers = [...emojiUsers, userId];
    }

    const updatedReactions = { ...currentReactions, [emoji]: newEmojiUsers };

    await pool.query(
      `UPDATE messages SET reactions = $1 WHERE id = $2`,
      [updatedReactions, messageId]
    );

    req.app.get('socketio').emit('messageReactionUpdated', { messageId, reactions: updatedReactions });

    res.json({ success: true, message: "Reaction updated", reactions: updatedReactions });
  } catch (error) {
    console.error("Update Message Reaction Error:", error);
    res.status(500).json({ success: false, message: "Failed to update reaction" });
  }
};

const updateAnnouncementReaction = async (req, res) => {
  const userId = req.user.id;
  const { announcementId, emoji } = req.body;

  if (!announcementId || !emoji) {
    return res.status(400).json({ success: false, message: "Announcement ID and emoji are required" });
  }

  try {
    const { rows } = await pool.query(
      `SELECT reactions FROM announcements WHERE id = $1`,
      [announcementId]
    );

    if (!rows.length) {
      return res.status(404).json({ success: false, message: "Announcement not found" });
    }

    const currentReactions = rows[0].reactions || {};
    const emojiUsers = currentReactions[emoji] || [];

    let newEmojiUsers;
    if (emojiUsers.includes(userId)) {
      newEmojiUsers = emojiUsers.filter(id => id !== userId);
    } else {
      newEmojiUsers = [...emojiUsers, userId];
    }

    const updatedReactions = { ...currentReactions, [emoji]: newEmojiUsers };

    await pool.query(
      `UPDATE announcements SET reactions = $1 WHERE id = $2`,
      [updatedReactions, announcementId]
    );

    req.app.get('socketio').emit('announcementReactionUpdated', { announcementId, reactions: updatedReactions });

    res.json({ success: true, message: "Reaction updated", reactions: updatedReactions });
  } catch (error) {
    console.error("Update Announcement Reaction Error:", error);
    res.status(500).json({ success: false, message: "Failed to update reaction" });
  }
};

module.exports = {
  sendTeacherMessage,
  getTeacherMessages,
  deleteMessagesBulk,
  sendAdminMessage,
  getAdminMessages, // Export the new admin message getter
  broadcastToClass,
  updateMessageReaction,
  updateAnnouncementReaction,
};
