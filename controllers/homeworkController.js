const pool = require('../config/db');
const { createNotification } = require('./notificationController');
 const { del } = require('../services/cacheService');

const toPositiveInt = (value, fallback = 7) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const computeHomeworkExpiry = ({ dueDate, durationValue, durationUnit }) => {
  if (dueDate) {
    const resolvedDate = new Date(dueDate);
    if (!Number.isNaN(resolvedDate.getTime())) return resolvedDate;
  }

  const resolved = new Date();
  const value = toPositiveInt(durationValue, 7);
  const unit = String(durationUnit || 'days').toLowerCase();

  if (unit.startsWith('month')) {
    resolved.setMonth(resolved.getMonth() + value);
  } else {
    resolved.setDate(resolved.getDate() + value);
  }

  return resolved;
};

// @desc    Teacher adds a new homework assignment
const addHomework = async (req, res) => {
  const teacherId = req.user.id;
  const schoolId = req.user.school_id;
  const { title, description, subject, due_date, class_id, duration_value, duration_unit } = req.body;

  if (!title || !class_id) {
    return res.status(400).json({ success: false, message: 'Title and class are required.' });
  }

  try {
    // Verify the teacher is assigned to the specified class
    const teacherClassCheck = await pool.query(
      "SELECT class_id FROM users WHERE id = $1 AND role = 'teacher' AND school_id = $2",
      [teacherId, schoolId]
    );

    if (!teacherClassCheck.rows.length || teacherClassCheck.rows[0].class_id !== class_id) {
      return res.status(403).json({ success: false, message: 'Unauthorized: You can only assign homework to your assigned class.' });
    }

    const expiresAt = computeHomeworkExpiry({
      dueDate: due_date,
      durationValue: duration_value,
      durationUnit: duration_unit,
    });

    const { rows } = await pool.query(
      `INSERT INTO homework (school_id, class_id, teacher_id, title, description, subject, due_date, duration_value, duration_unit, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [
        schoolId,
        class_id,
        teacherId,
        title,
        description || null,
        subject || null,
        expiresAt,
        toPositiveInt(duration_value, 7),
        String(duration_unit || 'days').toLowerCase(),
        expiresAt,
      ]
    );

    const newHomework = rows[0];
    const io = req.app.get('socketio');

    // Notify students in the class about new homework
    const studentsInClass = await pool.query(
      "SELECT id FROM users WHERE class_id = $1 AND role = 'student' AND school_id = $2",
      [class_id, schoolId]
    );

    await Promise.all(studentsInClass.rows.map(student =>
      createNotification(
        student.id,
        `New Homework: ${title}`,
        `A new homework assignment for ${subject || 'your class'} is due on ${new Date(expiresAt).toLocaleDateString()}.`,
        'homework',
        teacherId, // Related user is the teacher who assigned it
        io
      )
    ));

    // Clear dashboard cache for students to see the new homework immediately
    await del(`student:dashboard:*`);

    res.status(201).json({ success: true, message: 'Homework assigned successfully.', homework: newHomework });
  } catch (error) {
    console.error('Add Homework Error:', error);
    res.status(500).json({ success: false, message: 'Server error while assigning homework.' });
  }
};

// @desc    Teacher gets all homework assignments for their class
const getTeacherHomework = async (req, res) => {
  const teacherId = req.user.id;
  const schoolId = req.user.school_id;
  const { classId, subject, status, dueDate } = req.query; // Optional filters

  try {
    // Verify the teacher is assigned to the specified class
    const teacherClassCheck = await pool.query(
      "SELECT class_id FROM users WHERE id = $1 AND role = 'teacher' AND school_id = $2",
      [teacherId, schoolId]
    );

    const assignedClassId = teacherClassCheck.rows[0]?.class_id;

    if (!assignedClassId) {
      return res.status(403).json({ success: false, message: 'Unauthorized: You are not assigned to any class.' });
    }

    let query = `
      SELECT h.*, u.name as teacher_name, c.name as class_name
      FROM homework h
      JOIN users u ON u.id = h.teacher_id
      JOIN classes c ON c.id = h.class_id
      WHERE h.teacher_id = $1 AND h.school_id = $2 AND h.class_id = $3
        AND COALESCE(h.expires_at, h.due_date, h.assigned_date + INTERVAL '7 days') >= NOW()
    `;
    const params = [teacherId, schoolId, assignedClassId];
    let paramIndex = 4;

    if (subject) {
      query += ` AND h.subject ILIKE $${paramIndex}`;
      params.push(`%${subject}%`);
      paramIndex++;
    }
    // Add more filters as needed (e.g., by due date range, status)

    query += ` ORDER BY h.due_date ASC, h.assigned_date DESC`;

    const { rows } = await pool.query(query, params);
    res.json({ success: true, homework: rows });
  } catch (error) {
    console.error('Get Teacher Homework Error:', error);
    res.status(500).json({ success: false, message: 'Server error while fetching homework.' });
  }
};

// @desc    Student gets their homework assignments
const getStudentHomework = async (req, res) => {
  const studentId = req.user.id;
  const schoolId = req.user.school_id;
  const { subject, status, dueDate } = req.query; // Optional filters

  try {
    // Get the student's class ID
    const studentClassCheck = await pool.query(
      "SELECT class_id FROM users WHERE id = $1 AND role = 'student' AND school_id = $2",
      [studentId, schoolId]
    );

    const studentClassId = studentClassCheck.rows[0]?.class_id;

    if (!studentClassId) {
      return res.status(403).json({ success: false, message: 'You are not assigned to any class.' });
    }

    let query = `
      SELECT h.*, u.name as teacher_name, c.name as class_name
      FROM homework h
      JOIN users u ON u.id = h.teacher_id
      JOIN classes c ON c.id = h.class_id
      WHERE h.class_id = $1 AND h.school_id = $2
        AND COALESCE(h.expires_at, h.due_date, h.assigned_date + INTERVAL '7 days') >= NOW()
    `;
    const params = [studentClassId, schoolId];
    let paramIndex = 3;

    if (subject) {
      query += ` AND h.subject ILIKE $${paramIndex}`;
      params.push(`%${subject}%`);
      paramIndex++;
    }
    // Add more filters as needed

    query += ` ORDER BY h.due_date ASC, h.assigned_date DESC`;

    const { rows } = await pool.query(query, params);
    res.json({ success: true, homework: rows });
  } catch (error) {
    console.error('Get Student Homework Error:', error);
    res.status(500).json({ success: false, message: 'Server error while fetching homework.' });
  }
};

// @desc    Update a homework assignment (Teacher only)
const updateHomework = async (req, res) => {
  const teacherId = req.user.id;
  const schoolId = req.user.school_id;
  const { homeworkId } = req.params;
  const { title, description, subject, due_date, duration_value, duration_unit } = req.body;

  try {
    // Verify the teacher owns this homework assignment
    const homeworkCheck = await pool.query(
      "SELECT teacher_id FROM homework WHERE id = $1 AND school_id = $2",
      [homeworkId, schoolId]
    );

    if (!homeworkCheck.rows.length || homeworkCheck.rows[0].teacher_id !== teacherId) {
      return res.status(403).json({ success: false, message: 'Unauthorized: You can only update your own homework assignments.' });
    }

    const expiresAt = computeHomeworkExpiry({
      dueDate: due_date,
      durationValue: duration_value,
      durationUnit: duration_unit,
    });

    const { rows } = await pool.query(
      `UPDATE homework
       SET title = $1, description = $2, subject = $3, due_date = $4, duration_value = $5, duration_unit = $6, expires_at = $7, updated_at = CURRENT_TIMESTAMP
       WHERE id = $8 AND school_id = $9
       RETURNING *`,
      [
        title,
        description || null,
        subject || null,
        due_date ? new Date(due_date) : expiresAt, // Academic due date vs Cleanup expiry
        toPositiveInt(duration_value, 7),
        String(duration_unit || 'days').toLowerCase(),
        expiresAt,
        homeworkId,
        schoolId,
      ]
    );

    if (!rows.length) {
      return res.status(404).json({ success: false, message: 'Homework assignment not found.' });
    }

    // Invalidate student dashboard cache
    await del(`student:dashboard:*`);

    res.json({ success: true, message: 'Homework updated successfully.', homework: rows[0] });
  } catch (error) {
    console.error('Update Homework Error:', error);
    res.status(500).json({ success: false, message: 'Server error while updating homework.' });
  }
};

// @desc    Delete a homework assignment (Teacher only)
const deleteHomework = async (req, res) => {
  const teacherId = req.user.id;
  const schoolId = req.user.school_id;
  const { homeworkId } = req.params;

  try {
    // Verify the teacher owns this homework assignment
    const homeworkCheck = await pool.query(
      "SELECT teacher_id FROM homework WHERE id = $1 AND school_id = $2",
      [homeworkId, schoolId]
    );

    if (!homeworkCheck.rows.length || homeworkCheck.rows[0].teacher_id !== teacherId) {
      return res.status(403).json({ success: false, message: 'Unauthorized: You can only delete your own homework assignments.' });
    }

    const { rowCount } = await pool.query(
      `DELETE FROM homework WHERE id = $1 AND school_id = $2`,
      [homeworkId, schoolId]
    );

    if (rowCount === 0) {
      return res.status(404).json({ success: false, message: 'Homework assignment not found.' });
    }

    // Invalidate student dashboard cache
    await del(`student:dashboard:*`);

    res.json({ success: true, message: 'Homework deleted successfully.' });
  } catch (error) {
    console.error('Delete Homework Error:', error);
    res.status(500).json({ success: false, message: 'Server error while deleting homework.' });
  }
};

const reactToHomework = async (req, res) => {
  const userId = req.user.id;
  const schoolId = req.user.school_id;
  const { homeworkId } = req.params;
  const { emoji = '❤️' } = req.body || {};

  try {
    const { rows } = await pool.query(
      `SELECT id, reactions
       FROM homework
       WHERE id = $1 AND school_id = $2`,
      [homeworkId, schoolId]
    );

    if (!rows.length) {
      return res.status(404).json({ success: false, message: 'Homework not found.' });
    }

    const reactions = rows[0].reactions || {};
    const current = Array.isArray(reactions[emoji]) ? reactions[emoji] : [];
    const alreadyReacted = current.some((id) => Number(id) === Number(userId));
    const next = alreadyReacted
      ? current.filter((id) => Number(id) !== Number(userId))
      : [...current, Number(userId)];

    const nextReactions = { ...reactions, [emoji]: next };
    if (!next.length) delete nextReactions[emoji];

    const updateRes = await pool.query(
      `UPDATE homework
       SET reactions = $1
       WHERE id = $2 AND school_id = $3
       RETURNING *`,
      [nextReactions, homeworkId, schoolId]
    );

    res.json({ success: true, homework: updateRes.rows[0] });
  } catch (error) {
    console.error('Homework Reaction Error:', error);
    res.status(500).json({ success: false, message: 'Failed to update homework reaction.' });
  }
};


module.exports = {
  addHomework,
  getTeacherHomework,
  getStudentHomework,
  updateHomework,
  deleteHomework,
  reactToHomework,
};
