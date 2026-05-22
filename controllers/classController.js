const pool = require('../config/db');
const { del } = require('../services/cacheService');

const getClasses = async (req, res) => {
  if (!req.user) {
    return res.status(401).json({ 
      success: false, 
      message: 'Authentication failed. Access token missing or invalid.' 
    });
  }

  const schoolId = req.user.school_id;
  try {
    const { rows } = await pool.query(`
      SELECT
        c.*,
        t.name AS teacher_name,
        COUNT(u.id) FILTER (WHERE u.role = 'student')::int AS student_count
      FROM classes c
      LEFT JOIN users t ON t.id = c.teacher_id
      LEFT JOIN users u ON u.class_id = c.id AND u.school_id = c.school_id
      WHERE c.school_id = $1
      GROUP BY c.id, t.name
      ORDER BY c.grade_level ASC, c.section ASC
    `, [schoolId]);

    res.json({ success: true, classes: rows });
  } catch (error) {
    console.error('Get Classes Error:', error);
    res.status(500).json({ success: false, message: 'Server error fetching classes' });
  }
};

const createClass = async (req, res) => {
  if (!req.user) {
    return res.status(401).json({ 
      success: false, 
      message: 'Authentication failed. Access token missing or invalid.' 
    });
  }

  const schoolId = req.user.school_id;
  const { grade_level, section } = req.body;

  if (!grade_level || !section) {
    return res.status(400).json({ success: false, message: 'Grade level and section are required' });
  }

  const normalizedSection = String(section).trim().toUpperCase();
  const name = `${grade_level}${normalizedSection}`;

  try {
    const { rows } = await pool.query(
      `INSERT INTO classes (grade_level, section, name, school_id)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [grade_level, normalizedSection, name, schoolId]
    );

    // Clear admin dashboard cache so the new class appears immediately
    await del(`admin:dashboard:${schoolId}:*`);

    const io = req.app.get('socketio');
    if (io) {
      io.to('admins').emit('dashboardDataUpdate');
    }

    res.status(201).json({ success: true, class: rows[0] });
  } catch (error) {
    if (error.code === '23505') {
      return res.status(400).json({ success: false, message: 'This class section already exists' });
    }
    console.error('Create Class Error:', error);
    res.status(500).json({ success: false, message: 'Server error creating class' });
  }
};

module.exports = { getClasses, createClass };
