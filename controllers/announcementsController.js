const pool = require('../config/db');
const { createNotification } = require('./notificationController');
const { del } = require('../services/cacheService');

// Add Announcement
const addAnnouncement = async (req, res) => {
  const createdBy = req.user.id;
  const { title, description } = req.body;

  if (!title || !description) {
    return res.status(400).json({ 
      success: false, 
      message: 'Title and description are required' 
    });
  }

  try {
    const target_role = (req.user.role === 'teacher') ? 'my_class' : 'all';
    const schoolId = req.user.school_id;

    const { rows } = await pool.query(
      `INSERT INTO announcements (title, description, created_by, target_role, date, school_id)
       VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP, $5) 
       RETURNING id, title, description, target_role, date, created_by, reactions`,
      [title, description, createdBy, target_role, schoolId]
    );

    const newAnnouncement = rows[0];
    const io = req.app.get('socketio');

    // ================== NOTIFICATION LOGIC ==================
    try {
      if (req.user.role === 'teacher') {
        // Notify all students in this teacher's class
        const studentsRes = await pool.query(
          "SELECT id FROM users WHERE class_id = (SELECT class_id FROM users WHERE id = $1) AND role = 'student'",
          [createdBy]
        );

        for (const student of studentsRes.rows) {
          await createNotification(
            student.id, 
            "New Announcement", 
            title, 
            'announcement',
            createdBy,
            io
          );
        }
      } 
      else if (req.user.role === 'admin') {
        // Notify all students and teachers
        const allUsersRes = await pool.query(
          "SELECT id FROM users WHERE role IN ('student', 'teacher') AND school_id = $1",
          [schoolId]
        );

        for (const u of allUsersRes.rows) {
          await createNotification(
            u.id, 
            "New Announcement from Admin", 
            title, 
            'announcement',
            createdBy,
            io
          );
        }
      }
    } catch (notifError) {
      console.error("Failed to create notifications:", notifError);
      // Don't fail the announcement creation if notification fails
    }
    // =======================================================

    // Clear affected admin dashboard caches to update counters
    await del(`admin:dashboard:${schoolId}:*`);

    res.status(201).json({
      success: true,
      message: 'Announcement created successfully',
      announcement: newAnnouncement
    });
  } catch (error) {
    console.error('Add Announcement Error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to create announcement' 
    });
  }
};

// Get Announcements
const getAnnouncements = async (req, res) => {
  const userRole = req.user.role;
  const userId = req.user.id;
  const schoolId = req.user.school_id;

  try {
    let query = `
      SELECT 
        a.id, 
        a.title, 
        a.description, 
        a.target_role, 
        a.date, 
        a.created_by,
        a.reactions,
        u.name as created_by_name
      FROM announcements a
      LEFT JOIN users u ON a.created_by = u.id
      WHERE a.school_id = $1
    `;

    let params = [schoolId];

    if (userRole === 'student') {
      query += `
        AND (a.target_role IN ('all', 'student') 
           OR (a.target_role = 'my_class' AND a.created_by IN (
             SELECT id FROM users WHERE role = 'teacher' AND class_id = (SELECT class_id FROM users WHERE id = $2)
           )))
      `;
      params.push(userId);
    } else if (userRole === 'teacher') {
      query += `
        AND (a.target_role = 'all'
           OR (a.target_role = 'my_class' AND a.created_by = $2))
      `;
      params.push(userId);
    }
    // Admin sees all

    query += ` ORDER BY a.date DESC LIMIT 30`;

    const { rows } = await pool.query(query, params);
    
    res.json({ 
      success: true, 
      announcements: rows 
    });
  } catch (error) {
    console.error('Get Announcements Error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error' 
    });
  }
};

// Delete Announcement
const deleteAnnouncement = async (req, res) => {
  const { id } = req.params;
  const userId = req.user.id;
  const userRole = req.user.role;

  try {
    let query = 'DELETE FROM announcements WHERE id = $1';
    let params = [id];

    if (userRole === 'teacher') {
      query += ' AND created_by = $2';
      params.push(userId);
    }

    const result = await pool.query(query, params);

    if (result.rowCount === 0) {
      return res.status(404).json({ 
        success: false, 
        message: 'Announcement not found or not authorized' 
      });
    }

    await del(`admin:dashboard:${req.user.school_id}:*`);

    res.json({ 
      success: true, 
      message: 'Announcement deleted successfully' 
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to delete announcement' 
    });
  }
};

module.exports = {
  addAnnouncement,
  getAnnouncements,
  deleteAnnouncement
};
