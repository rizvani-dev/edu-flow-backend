const pool = require('../config/db');
const bcrypt = require('bcryptjs');
const { createNotification } = require('./notificationController');
const { mapMediaFields, mapMediaFieldsList } = require('../utils/media');
const { withCache, del } = require('../services/cacheService');

// Get My Students
const getMyStudents = async (req, res) => {
  const teacherId = req.user.id;

  try {
    const payload = await withCache(`teacher:students:${teacherId}`, async () => {
      const { rows } = await pool.query(
        `SELECT u.id, u.name, u.email, u.class_id, u.bio, u.profile_image, u.last_seen, u.online,
                c.name AS class_name,
                COALESCE(ROUND(AVG(r.marks)), 0)::int as avg_marks
         FROM users u
         LEFT JOIN classes c ON c.id = u.class_id
         LEFT JOIN results r ON r.student_id = u.id
         WHERE u.role = 'student' 
          AND u.teacher_id = $1
         GROUP BY u.id, c.name
         ORDER BY u.name`,
        [teacherId]
      );

      return { success: true, students: mapMediaFieldsList(rows, ['profile_image']) };
    }, 60);

    res.json(payload);
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// Add Student
const addStudent = async (req, res) => {
  const teacherId = req.user.id;
  const schoolId = req.user.school_id;
  const { name, email, password, bio } = req.body;
  const profile_image = req.file ? req.file.path : null;

  if (!name || !email || !password) {
    return res.status(400).json({ success: false, message: "Name, email and password are required" });
  }

  try {
    // Check if teacher has class
    const teacherCheck = await pool.query(
      'SELECT class_id FROM users WHERE id = $1 AND role = $2 AND school_id = $3',
      [teacherId, 'teacher', schoolId]
    );

    const classId = teacherCheck.rows[0]?.class_id;

    if (!classId) {
      return res.status(400).json({ 
        success: false, 
        message: "Teacher is not assigned to any class. Please ask Admin to assign a class." 
      });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const { rows } = await pool.query(
      `INSERT INTO users (name, email, password, role, class_id, teacher_id, school_id, bio, profile_image)
       VALUES ($1, $2, $3, 'student', $4, $5, $6, $7, $8) 
       RETURNING id, name, email, class_id, teacher_id, school_id, bio, profile_image`,
      [name, email, hashedPassword, classId, teacherId, schoolId, bio || null, profile_image || null]
    );

    // Clear teacher students cache
    await del(`teacher:students:${teacherId}`);

    // Clear admin dashboard cache so total counts update
    await del(`admin:dashboard:${schoolId}:*`);

    const io = req.app.get('socketio');
    if (io) {
      io.to('admins').emit('dashboardDataUpdate', {
        // This event should trigger a refresh of the admin's user list
        type: 'student_created',
        userId: rows[0].id,
      });
    }

    res.status(201).json({
      success: true,
      message: 'Student added successfully',
      student: mapMediaFields(rows[0], ['profile_image'])
    });
  } catch (error) {
    console.error("Add Student Error:", error);
    if (error.code === '23505') {
      return res.status(400).json({ success: false, message: 'Email already exists' });
    }
    res.status(500).json({ 
      success: false, 
      message: error.message || 'Server error while adding student' 
    });
  }
};

// Update Student (basic)
const updateStudent = async (req, res) => {
  const teacherId = req.user.id;
  const { id } = req.params;
  const { name, email, bio } = req.body;

  try {
    const { rows } = await pool.query(
      `UPDATE users 
       SET name = $1, email = $2, bio = $3 
       WHERE id = $4 AND teacher_id = $5 AND role = 'student'
       RETURNING *`,
      [name, email, bio, id, teacherId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: "Student not found or not in your class" });
    }

    // Clear teacher students cache
    await del(`teacher:students:${teacherId}`);

    await del(`admin:dashboard:${req.user.school_id}:*`);

    res.json({ success: true, message: "Student updated", student: rows[0] });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: "Failed to update student" });
  }
};

// Delete Student
const deleteStudent = async (req, res) => {
  const teacherId = req.user.id;
  const { id } = req.params;

  try {
    const result = await pool.query(
      `DELETE FROM users 
       WHERE id = $1 AND teacher_id = $2 AND role = 'student'`,
      [id, teacherId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, message: "Student not found or not in your class" });
    }

    // Clear teacher students cache
    await del(`teacher:students:${teacherId}`);

    await del(`admin:dashboard:${req.user.school_id}:*`);

    res.json({ success: true, message: "Student deleted successfully" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: "Failed to delete student" });
  }
};

// Update Teacher Profile (with image support)
const updateProfile = async (req, res) => {
  const teacherId = req.user.id;
  const { bio } = req.body;
  const file = req.file;

  try {
    let profileImageUrl = null;
    if (file) {
      profileImageUrl = file.path;
    }

    const { rows } = await pool.query(
      `UPDATE users 
       SET bio = $1, 
           profile_image = COALESCE($2, profile_image)
       WHERE id = $3 AND role = 'teacher'
       RETURNING id, name, email, bio, profile_image`,
      [bio, profileImageUrl, teacherId]
    );

    res.json({
      success: true,
      message: "Profile updated successfully",
      profile: mapMediaFields(rows[0], ['profile_image'])
    });
  } catch (error) {
    console.error("Profile Update Error:", error);
    res.status(500).json({ success: false, message: "Failed to update profile" });
  }
};

const getMySalaries = async (req, res) => {
  const teacherId = req.user.id;
  try {
    const { rows } = await pool.query(
      `SELECT * FROM teacher_salaries WHERE teacher_id = $1 ORDER BY year DESC, month DESC, id DESC`,
      [teacherId]
    );
    res.json({ success: true, salaries: mapMediaFieldsList(rows, ['payment_screenshot']) });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to load salaries' });
  }
};

const getMySalaryById = async (req, res) => {
  const teacherId = req.user.id;
  const { salaryId } = req.params;
  try {
    const { rows } = await pool.query(
      `SELECT * FROM teacher_salaries WHERE id = $1 AND teacher_id = $2`,
      [salaryId, teacherId]
    );
    if (!rows.length) return res.status(404).json({ success: false, message: 'Salary record not found' });
    res.json({ success: true, salary: mapMediaFields(rows[0], ['payment_screenshot']) });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to load salary record' });
  }
};

const confirmSalaryReceived = async (req, res) => {
  const teacherId = req.user.id;
  const { salaryId } = req.params;
  const { createNotification } = require('./notificationController');

  try {
    const { rows } = await pool.query(
      `UPDATE teacher_salaries
       SET status = 'received'
       WHERE id = $1 AND teacher_id = $2
       RETURNING *`,
      [salaryId, teacherId]
    );

    if (!rows.length) {
      return res.status(404).json({ success: false, message: 'Salary record not found' });
    }

    const salary = rows[0];
    const { rows: admins } = await pool.query(
      `SELECT id FROM users WHERE role = 'admin' AND school_id = $1`,
      [salary.school_id]
    );
    const io = req.app.get('socketio');

    await Promise.all(
      admins.map((a) =>
        createNotification(
          a.id,
          'Salary received approval',
          `Teacher #${teacherId} approved salary received for ${salary.month} ${salary.year} (Amount: ${salary.amount}). [salaryId:${salary.id}]`,
          'salary_approved',
          teacherId,
          io
        )
      )
    );

    res.json({ success: true, message: 'Salary marked as received', salary });
  } catch (error) {
    console.error('Confirm Salary Error:', error);
    res.status(500).json({ success: false, message: 'Failed to confirm salary received' });
  }
};

const rejectSalaryReceived = async (req, res) => {
  const teacherId = req.user.id;
  const { salaryId } = req.params;
  const { reason } = req.body;

  try {
    const { rows } = await pool.query(
      `UPDATE teacher_salaries
       SET status = 'rejected'
       WHERE id = $1 AND teacher_id = $2
       RETURNING *`,
      [salaryId, teacherId]
    );

    if (!rows.length) {
      return res.status(404).json({ success: false, message: 'Salary record not found' });
    }

    const salary = rows[0];
    const { rows: adminRows } = await pool.query(`SELECT id FROM users WHERE role = 'admin' AND school_id = $1`, [salary.school_id]);
    const io = req.app.get('socketio');

    await Promise.all(
      adminRows.map((admin) =>
        createNotification(
          admin.id,
          'Salary receipt rejected',
          `Teacher #${teacherId} rejected the salary record for ${salary.month} ${salary.year}. Reason: ${reason || 'No reason provided'}. [salaryId:${salary.id}]`,
          'salary_rejected',
          teacherId,
          io
        )
      )
    );

    res.json({ success: true, message: 'Salary marked as rejected', salary });
  } catch (error) {
    console.error('Reject Salary Error:', error);
    res.status(500).json({ success: false, message: 'Failed to reject salary' });
  }
};

module.exports = {
  getMyStudents,
  addStudent,
  updateStudent,
  deleteStudent,
  updateProfile,
  getMySalaries,
  getMySalaryById,
  confirmSalaryReceived,
  rejectSalaryReceived,
};
