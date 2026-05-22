const pool = require('../config/db');
const { createNotification } = require('./notificationController');
const { mapMediaFields, mapMediaFieldsList, normalizeStoredMediaPath } = require('../utils/media');

const detectMessageType = (file) => {
  const mime = String(file?.mimetype || '').toLowerCase();
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  
  // Handle voice recordings and common audio extensions
  const ext = String(file?.originalname || '').toLowerCase();
  if (ext.endsWith('.webm') || ext.endsWith('.ogg') || ext.endsWith('.wav') || ext.endsWith('.m4a')) return 'audio';
  
  return file ? 'file' : 'text';
};

const getNotificationTitleForRole = (role) => {
  if (role === 'admin') return 'Admin Message';
  if (role === 'teacher') return 'New Message from Teacher';
  if (role === 'student') return 'New Message from Student';
  return 'New Message';
};

const buildNotificationPreview = (message, file) => {
  if (message?.trim()) {
    return message.trim().length > 80 ? `${message.trim().slice(0, 80)}...` : message.trim();
  }

  return file ? 'Sent a file' : 'New message';
};

const getChatPermission = async (currentUserId, targetUserId) => {
  const { rows } = await pool.query(
    `SELECT
        u_curr.id AS current_user_id,
        u_curr.role AS current_user_role,
        u_curr.school_id AS current_user_school_id,
        u_curr.class_id AS current_user_class_id,
        u_curr.teacher_id AS current_user_teacher_id,
        COALESCE(u_curr.teacher_id, current_class.teacher_id) AS assigned_teacher_id,
        target_user.id AS target_user_id,
        target_user.name AS target_user_name,
        target_user.role AS target_user_role,
        target_user.class_id AS target_user_class_id,
        target_user.profile_image AS target_user_profile_image,
        target_user.school_id AS target_user_school_id
      FROM users u_curr
      LEFT JOIN classes current_class ON current_class.id = u_curr.class_id
      JOIN users target_user ON target_user.id = $2
      WHERE u_curr.id = $1`,
    [currentUserId, targetUserId]
  );

  if (!rows.length) {
    return { allowed: false, reason: 'Conversation user not found' };
  }

  const details = rows[0];
  const currentRole = details.current_user_role;
  const targetRole = details.target_user_role;
  const currentSchoolId = Number(details.current_user_school_id || 0);
  const targetSchoolId = Number(details.target_user_school_id || 0);
  const assignedTeacherId = Number(details.assigned_teacher_id || 0);
  const currentClassId = Number(details.current_user_class_id || 0);
  const targetClassId = Number(details.target_user_class_id || 0);
  const targetId = Number(details.target_user_id);

  let allowed = false;

  if (currentSchoolId && targetSchoolId && currentSchoolId !== targetSchoolId) {
    allowed = false;
  } else if (currentRole === 'student') {
    allowed = targetRole === 'admin' || (targetRole === 'teacher' && targetId === assignedTeacherId);
  } else if (currentRole === 'teacher') {
    allowed = targetRole === 'admin' || (targetRole === 'student' && currentClassId && currentClassId === targetClassId);
  }

  return {
    allowed,
    reason: allowed ? null : 'You are not allowed to chat with this user',
    targetUser: {
      id: targetId,
      name: details.target_user_name,
      role: targetRole,
      class_id: details.target_user_class_id,
      profile_image: normalizeStoredMediaPath(details.target_user_profile_image),
    },
  };
};

const getConversationMessages = async (req, res) => {
  const currentUserId = req.user.id;
  const targetUserId = Number(req.params.userId);
  const schoolId = req.user.school_id;
  const rawLimit = Number(req.query.limit);
  const limit = Number.isFinite(rawLimit)
    ? Math.min(Math.max(rawLimit, 1), 100)
    : 50;
  const beforeMessageId = Number(req.query.before);
  const offset = Number(req.query.offset);

  if (!targetUserId) {
    return res.status(400).json({ success: false, message: 'User ID is required' });
  }

  try {
    const permission = await getChatPermission(currentUserId, targetUserId);

    if (!permission.allowed) {
      return res.status(403).json({ success: false, message: permission.reason });
    }

    const params = [currentUserId, targetUserId, schoolId];
    let paginationClause = '';

    if (Number.isFinite(beforeMessageId) && beforeMessageId > 0) {
      params.push(beforeMessageId);
      paginationClause = `AND m.id < $${params.length}`;
    }

    params.push(limit + 1);
    const limitPlaceholder = params.length;

    if (!paginationClause && Number.isFinite(offset) && offset > 0) {
      params.push(offset);
      paginationClause = `OFFSET $${params.length}`;
    }

    const { rows } = await pool.query(
      `SELECT
          m.id,
          m.sender_id,
          m.receiver_id,
          m.message,
          m.file_url,
          m.file_name,
          m.file_mime,
          m.file_size,
          m.message_type,
          m.reactions,
          m.deleted_for,
          m.deleted_for_everyone,
          m.seen_at,
          m.status,
          m.created_at,
          u.name AS sender_name
       FROM messages m
       LEFT JOIN users u ON u.id = m.sender_id
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
    const messages = mapMediaFieldsList(pageRows.reverse(), ['file_url']);

    return res.json({
      success: true,
      contact: permission.targetUser,
      messages,
      hasMore,
      pagination: {
        limit,
        hasMore,
        nextCursor: hasMore ? messages[0]?.id || null : null,
      },
    });
  } catch (error) {
    console.error('Get Conversation Error:', error);
    return res.status(500).json({ success: false, message: 'Failed to load conversation' });
  }
};

const sendConversationMessage = async (req, res) => {
  const currentUserId = req.user.id;
  const currentUserRole = req.user.role;
  const schoolId = req.user.school_id;
  const targetUserId = Number(req.params.userId);
  const { message } = req.body;
  const file = req.file;

  if (!targetUserId) {
    return res.status(400).json({ success: false, message: 'User ID is required' });
  }

  if (!message?.trim() && !file) {
    return res.status(400).json({ success: false, message: 'Message or file is required' });
  }

  try {
    const permission = await getChatPermission(currentUserId, targetUserId);

    if (!permission.allowed) {
      return res.status(403).json({ success: false, message: permission.reason });
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
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [currentUserId, targetUserId, message?.trim() || '', fileUrl, fileName, fileMime, fileSize, messageType, 'sent', schoolId]
    );
    const chat = mapMediaFields(rows[0], ['file_url']);

    const io = req.app.get('socketio');
    if (io) {
      io.to(`user_${targetUserId}`).emit('receiveMessage', chat);
      io.to(`user_${currentUserId}`).emit('messageSent', {
        id: chat.id,
        receiver_id: targetUserId,
        created_at: chat.created_at,
      });
    }

    await createNotification(
      targetUserId,
      getNotificationTitleForRole(currentUserRole),
      buildNotificationPreview(message, file),
      'chat',
      currentUserId,
      io
    );

    return res.status(201).json({
      success: true,
      message: 'Message sent successfully',
      chat,
      contact: permission.targetUser,
    });
  } catch (error) {
    console.error('Send Conversation Message Error:', error);
    return res.status(500).json({ success: false, message: 'Failed to send message' });
  }
};

module.exports = {
  getConversationMessages,
  sendConversationMessage,
};
