/**
 * Registers Socket.IO connection handlers (chat, presence, messaging).
 * @param {import('socket.io').Server} io
 * @param {import('pg').Pool} pool
 */
function registerSocketHandlers(io, pool) {
  const onlineUsers = new Map();
  const userContextCache = new Map();

  const getUserContext = async (userId) => {
    const normalizedUserId = Number(userId);
    const cached = userContextCache.get(normalizedUserId);
    const now = Date.now();

    if (cached && now - cached.cachedAt < 60 * 1000) {
      return cached.data;
    }

    const userRes = await pool.query(
      'SELECT id, role, class_id, school_id FROM users WHERE id = $1',
      [normalizedUserId]
    );
    const userData = userRes.rows[0] || null;

    if (userData) {
      userContextCache.set(normalizedUserId, {
        data: userData,
        cachedAt: now,
      });
    }

    return userData;
  };

  const emitPresenceUpdate = (userContext, payload) => {
    if (!userContext?.id) return;

    io.to(`user_${userContext.id}`).emit('userStatusUpdate', payload);

    if (userContext.school_id) {
      io.to(`school_${userContext.school_id}`).emit('userStatusUpdate', payload);
    }
  };

  const releaseUserSocket = async (socket) => {
    const userId = Number(socket.userId);
    if (!userId) return;

    const userSockets = onlineUsers.get(userId);
    if (!userSockets) return;

    userSockets.delete(socket.id);

    if (userSockets.size > 0) {
      return;
    }

    onlineUsers.delete(userId);

    const userContext =
      socket.userContext || (await getUserContext(userId).catch(() => null));
    const lastSeen = new Date();

    try {
      await pool.query(
        'UPDATE users SET online = false, last_seen = $1 WHERE id = $2',
        [lastSeen, userId]
      );
    } catch (err) {
      console.error('Last seen error:', err.message);
    }

    emitPresenceUpdate(userContext, {
      userId,
      online: false,
      last_seen: lastSeen,
    });

    console.log(`User ${userId} OFFLINE`);
  };

  io.on('connection', (socket) => {
    console.log('Socket connected:', socket.id);

    socket.on('join', async (payload = {}, ack) => {
      const userId =
        typeof payload === 'object' && payload !== null
          ? Number(payload.userId)
          : Number(payload);

      if (!userId) {
        if (typeof ack === 'function') {
          ack({ ok: false, error: 'Missing userId' });
        }
        return;
      }

      if (socket.userId && Number(socket.userId) !== userId) {
        await releaseUserSocket(socket);
      }

      const existingSockets = onlineUsers.get(userId);
      const isFirstActiveSocket = !existingSockets || existingSockets.size === 0;

      socket.userId = userId;
      socket.join(`user_${userId}`);

      if (!onlineUsers.has(userId)) {
        onlineUsers.set(userId, new Set());
      }

      onlineUsers.get(userId).add(socket.id);

      try {
        const userData = await getUserContext(userId);
        socket.userContext = userData;

        if (userData?.role === 'admin') socket.join('admins');
        if (userData?.class_id) socket.join(`class_${userData.class_id}`);
        if (userData?.school_id) socket.join(`school_${userData.school_id}`);

        if (isFirstActiveSocket) {
          await pool.query('UPDATE users SET online = true WHERE id = $1', [
            userId,
          ]);

          emitPresenceUpdate(userData, {
            userId,
            online: true,
          });
        }

        if (typeof ack === 'function') {
          ack({
            ok: true,
            userId,
            rooms: {
              schoolId: userData?.school_id || null,
              classId: userData?.class_id || null,
              role: userData?.role || null,
            },
          });
        }
      } catch (err) {
        console.error('Online update error:', err.message);
        if (typeof ack === 'function') {
          ack({ ok: false, error: 'Join failed' });
        }
      }
    });

    socket.on('leaveUser', async () => {
      await releaseUserSocket(socket);
      socket.userId = null;
      socket.userContext = null;
    });

    socket.on('typing', ({ senderId, receiverId }) => {
      if (!senderId || !receiverId) return;
      socket.to(`user_${receiverId}`).emit('typing', { senderId });
    });

    socket.on('broadcastMessage', async (messageData) => {
      if (!messageData?.receiver_id) return;
      io.to(`user_${messageData.receiver_id}`).emit('receiveMessage', messageData);
    });

    socket.on('deleteMessages', ({ receiverId, messageIds }) => {
      if (!receiverId || !Array.isArray(messageIds) || !messageIds.length) return;
      io.to(`user_${receiverId}`).emit('messagesDeleted', { messageIds });
    });

    socket.on(
      'sendMessage',
      async ({ senderId, receiverId, message, file_url, file_name }, ack) => {
        if (!senderId || !receiverId || (!message && !file_url)) {
          if (typeof ack === 'function') {
            ack({ ok: false, error: 'Invalid message payload' });
          }
          return;
        }

        try {
          const messageType = file_url ? 'file' : 'text';
          const result = await pool.query(
            `INSERT INTO messages (sender_id, receiver_id, message, file_url, file_name, message_type, status)
             VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
            [
              senderId,
              receiverId,
              message || '',
              file_url || null,
              file_name || null,
              messageType,
              'sent',
            ]
          );

          const savedMessage = result.rows[0];
          io.to(`user_${receiverId}`).emit('receiveMessage', savedMessage);
          io.to(`user_${senderId}`).emit('messageSent', {
            id: savedMessage.id,
            receiver_id: receiverId,
            created_at: savedMessage.created_at,
          });

          if (typeof ack === 'function') {
            ack({ ok: true, message: savedMessage });
          }
        } catch (err) {
          console.error('Message send error:', err.message);
          if (typeof ack === 'function') {
            ack({ ok: false, error: 'Message send failed' });
          }
        }
      }
    );

    socket.on('markSeen', async ({ senderId, receiverId, messageIds }, ack) => {
      if (!senderId || !receiverId || !Array.isArray(messageIds) || !messageIds.length) {
        if (typeof ack === 'function') {
          ack({ ok: false, error: 'Invalid seen payload' });
        }
        return;
      }

      try {
        const result = await pool.query(
          `UPDATE messages
           SET status = 'seen', seen_at = COALESCE(seen_at, NOW())
           WHERE id = ANY($1::int[]) AND sender_id = $2 AND receiver_id = $3`,
          [messageIds, senderId, receiverId]
        );
        io.to(`user_${senderId}`).emit('messagesSeen', { receiverId, messageIds });
        if (typeof ack === 'function') {
          ack({ ok: true, updatedCount: result.rowCount });
        }
      } catch (err) {
        console.error('Seen update error:', err.message);
        if (typeof ack === 'function') {
          ack({ ok: false, error: 'Seen update failed' });
        }
      }
    });

    socket.on('reactMessage', async ({ messageId, userId, emoji }) => {
      if (!messageId || !userId || !emoji) return;
      try {
        const msgRes = await pool.query(
          `SELECT id, sender_id, receiver_id, reactions
           FROM messages
           WHERE id = $1`,
          [messageId]
        );
        if (!msgRes.rows.length) return;
        const msg = msgRes.rows[0];

        const isParticipant =
          Number(userId) === Number(msg.sender_id) ||
          Number(userId) === Number(msg.receiver_id);
        if (!isParticipant) return;

        const reactions = msg.reactions || {};
        const current = Array.isArray(reactions[emoji]) ? reactions[emoji] : [];
        const already = current.some((id) => Number(id) === Number(userId));
        const next = already
          ? current.filter((id) => Number(id) !== Number(userId))
          : [...current, Number(userId)];

        const nextReactions = { ...reactions, [emoji]: next };
        if (next.length === 0) delete nextReactions[emoji];

        const updateRes = await pool.query(
          `UPDATE messages SET reactions = $1 WHERE id = $2 RETURNING id, reactions`,
          [nextReactions, messageId]
        );

        const payload = { messageId, reactions: updateRes.rows[0].reactions };
        io.to(`user_${msg.sender_id}`).emit('messageReactionUpdated', payload);
        io.to(`user_${msg.receiver_id}`).emit('messageReactionUpdated', payload);
      } catch (err) {
        console.error('Reaction update error:', err.message);
      }
    });

    socket.on('reactAnnouncement', async ({ announcementId, userId, emoji }) => {
      if (!announcementId || !userId || !emoji) return;
      try {
        const annRes = await pool.query(
          `SELECT id, school_id, reactions
           FROM announcements
           WHERE id = $1`,
          [announcementId]
        );
        if (!annRes.rows.length) return;
        const announcement = annRes.rows[0];

        const userContext = await getUserContext(userId);
        if (!userContext || Number(userContext.school_id) !== Number(announcement.school_id)) return;

        const reactions = announcement.reactions || {};
        const current = Array.isArray(reactions[emoji]) ? reactions[emoji] : [];
        const already = current.some((id) => Number(id) === Number(userId));
        const next = already
          ? current.filter((id) => Number(id) !== Number(userId))
          : [...current, Number(userId)];

        const nextReactions = { ...reactions, [emoji]: next };
        if (!next.length) delete nextReactions[emoji];

        const updateRes = await pool.query(
          `UPDATE announcements SET reactions = $1 WHERE id = $2 RETURNING id, reactions`,
          [nextReactions, announcementId]
        );

        io.to(`school_${announcement.school_id}`).emit('announcementReactionUpdated', {
          announcementId,
          reactions: updateRes.rows[0].reactions,
        });
      } catch (err) {
        console.error('Announcement reaction update error:', err.message);
      }
    });

    socket.on('disconnect', async () => {
      await releaseUserSocket(socket);
    });
  });
}

module.exports = registerSocketHandlers;
