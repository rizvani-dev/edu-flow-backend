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
          AND u.teacher_id = $1 AND u.school_id = $2
         GROUP BY u.id, c.name
         ORDER BY u.name`,
        [teacherId, req.user.school_id]
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
       WHERE id = $4 AND teacher_id = $5 AND role = 'student' AND school_id = $6
       RETURNING id, name, email, class_id, teacher_id, school_id, bio, profile_image`,
      [name, email, bio, id, teacherId, req.user.school_id]
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
       WHERE id = $1 AND teacher_id = $2 AND role = 'student' AND school_id = $3`,
      [id, teacherId, req.user.school_id]
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
       WHERE id = $3 AND role = 'teacher' AND school_id = $4
       RETURNING id, name, email, bio, profile_image`,
      [bio, profileImageUrl, teacherId, req.user.school_id]
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
      `SELECT *, COALESCE(amount_paid, CASE WHEN status IN ('paid', 'received') THEN amount ELSE 0 END) AS amount_paid,
              GREATEST(amount - COALESCE(amount_paid, CASE WHEN status IN ('paid', 'received') THEN amount ELSE 0 END), 0) AS amount_pending
       FROM teacher_salaries WHERE teacher_id = $1 AND school_id = $2
       ORDER BY year DESC, CASE month WHEN 'January' THEN 1 WHEN 'February' THEN 2 WHEN 'March' THEN 3 WHEN 'April' THEN 4 WHEN 'May' THEN 5 WHEN 'June' THEN 6 WHEN 'July' THEN 7 WHEN 'August' THEN 8 WHEN 'September' THEN 9 WHEN 'October' THEN 10 WHEN 'November' THEN 11 WHEN 'December' THEN 12 END DESC, id DESC`,
      [teacherId, req.user.school_id]
    );
    res.json({ success: true, salaries: mapMediaFieldsList(rows, ['payment_screenshot']) });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to load salaries' });
  }
};

const getMySalaryRequests = async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM teacher_salary_requests WHERE teacher_id = $1 AND school_id = $2 ORDER BY created_at DESC, id DESC`,
      [req.user.id, req.user.school_id]
    );
    res.json({ success: true, requests: rows });
  } catch (error) {
    console.error('Get Salary Requests Error:', error);
    res.status(500).json({ success: false, message: 'Failed to load salary requests' });
  }
};

const createMySalaryRequest = async (req, res) => {
  const { month, year, amount, advance_percentage, request_type = 'salary', reason } = req.body;
  const validMonths = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const numericYear = Number(year);
  let numericAmount = Number(amount);
  const numericPercentage = Number(advance_percentage);
  if (request_type === 'advance' && Number.isFinite(numericPercentage) && numericPercentage > 0) {
    if (numericPercentage > 50) return res.status(400).json({ success: false, message: 'Advance requests are limited to 50% of the latest salary' });
    const basis = await pool.query(
      `SELECT amount FROM teacher_salaries WHERE teacher_id = $1 AND school_id = $2 ORDER BY year DESC,
       CASE LOWER(month) WHEN 'january' THEN 1 WHEN 'february' THEN 2 WHEN 'march' THEN 3 WHEN 'april' THEN 4 WHEN 'may' THEN 5 WHEN 'june' THEN 6 WHEN 'july' THEN 7 WHEN 'august' THEN 8 WHEN 'september' THEN 9 WHEN 'october' THEN 10 WHEN 'november' THEN 11 WHEN 'december' THEN 12 END DESC LIMIT 1`,
      [req.user.id, req.user.school_id]
    );
    if (!basis.rows.length) return res.status(409).json({ success: false, message: 'A salary record is required to calculate an advance percentage' });
    numericAmount = Math.round(Number(basis.rows[0].amount) * numericPercentage) / 100;
    const existingAdvance = await pool.query(
      `SELECT COALESCE(SUM(amount), 0)::float AS total FROM teacher_salary_advances
       WHERE teacher_id = $1 AND school_id = $2 AND LOWER(deduction_month) = LOWER($3)
         AND deduction_year = $4 AND status = 'approved'`,
      [req.user.id, req.user.school_id, month, numericYear]
    );
    if (Number(existingAdvance.rows[0]?.total || 0) + numericAmount > Number(basis.rows[0].amount) * 0.5) {
      return res.status(400).json({ success: false, message: 'Total approved advances for this period cannot exceed 50% of the latest salary' });
    }
  }
  if (!validMonths.includes(month) || !Number.isInteger(numericYear) || numericYear < 2000 || numericYear > 2100 || !Number.isFinite(numericAmount) || numericAmount <= 0 || !String(reason || '').trim()) {
    return res.status(400).json({ success: false, message: 'Enter a valid month, year, amount, and reason' });
  }
  if (!['salary', 'advance', 'correction'].includes(request_type)) {
    return res.status(400).json({ success: false, message: 'Invalid request type' });
  }
  try {
    const duplicate = await pool.query(
      `SELECT id FROM teacher_salary_requests WHERE teacher_id = $1 AND school_id = $2 AND month = $3 AND year = $4 AND request_type = $5 AND status = 'pending'`,
      [req.user.id, req.user.school_id, month, numericYear, request_type]
    );
    if (duplicate.rows.length) return res.status(409).json({ success: false, message: `You already have a pending ${request_type} request for ${month} ${numericYear}` });
    const { rows } = await pool.query(
      `INSERT INTO teacher_salary_requests (school_id, teacher_id, month, year, amount, request_type, reason, advance_percentage)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [req.user.school_id, req.user.id, month, numericYear, numericAmount, request_type, String(reason).trim(), request_type === 'advance' && numericPercentage > 0 ? numericPercentage : null]
    );
    const { rows: admins } = await pool.query(`SELECT id FROM users WHERE role = 'admin' AND school_id = $1`, [req.user.school_id]);
    const { createNotification } = require('./notificationController');
    await Promise.all(admins.map((admin) => createNotification(admin.id, 'Teacher salary request', `${req.user.name || `Teacher #${req.user.id}`} requested ${request_type} for ${month} ${numericYear} (PKR ${numericAmount}). [salaryRequestId:${rows[0].id}]`, 'salary_request', req.user.id, req.app.get('socketio'))));
    res.status(201).json({ success: true, request: rows[0] });
  } catch (error) {
    console.error('Create Salary Request Error:', error);
    res.status(500).json({ success: false, message: 'Failed to submit salary request' });
  }
};

const getMySalaryById = async (req, res) => {
  const teacherId = req.user.id;
  const { salaryId } = req.params;
  try {
    const { rows } = await pool.query(
      `SELECT * FROM teacher_salaries WHERE id = $1 AND teacher_id = $2 AND school_id = $3`,
      [salaryId, teacherId, req.user.school_id]
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
       SET status = 'received', amount_paid = amount, paid_at = COALESCE(paid_at, CURRENT_TIMESTAMP)
       WHERE id = $1 AND teacher_id = $2 AND school_id = $3 AND status = 'paid'
       RETURNING *`,
      [salaryId, teacherId, req.user.school_id]
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
       SET status = 'rejected', amount_paid = 0, paid_at = NULL,
           rejected_at = CURRENT_TIMESTAMP, rejection_reason = $4
       WHERE id = $1 AND teacher_id = $2 AND school_id = $3 AND status = 'paid'
       RETURNING *`,
      [salaryId, teacherId, req.user.school_id, String(reason || 'Not received or incorrect amount').slice(0, 1000)]
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
          `Teacher #${teacherId} rejected the salary record for ${salary.month} ${salary.year}. Reason: ${reason || 'No reason provided'}.`,
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

const { generateSalarySlipPdf } = require('../utils/pdfGenerator');

// @desc    Download Salary Slip PDF (Teacher can only access their own slip)
const downloadSalarySlip = async (req, res) => {
  const isSchoolAdmin = req.user.role === 'admin';
  const teacherId = isSchoolAdmin ? null : req.user.id;
  const schoolId = req.user.school_id;
  const { salaryId } = req.params;

  try {
    const { rows } = await pool.query(
      `SELECT ts.*,
              u.name AS teacher_name, u.email AS teacher_email,
              c.name AS class_name,
              s.name AS school_name, s.logo_url AS school_logo_url
       FROM teacher_salaries ts
       JOIN users u ON u.id = ts.teacher_id
       LEFT JOIN classes c ON c.id = u.class_id
       LEFT JOIN schools s ON s.id = ts.school_id
       WHERE ts.id = $1 AND ts.school_id = $2 AND ($3::int IS NULL OR ts.teacher_id = $3)`,
      [salaryId, schoolId, teacherId]
    );

    if (!rows.length) {
      return res.status(404).json({ success: false, message: 'Salary record not found' });
    }

    const salary = rows[0];

    // Only allow downloading slip if status is approved, paid, or received
    if (!['approved', 'paid', 'received'].includes(String(salary.status).toLowerCase())) {
      return res.status(400).json({
        success: false,
        message: 'Salary slip is only available after administration approval'
      });
    }

    const pdfBuffer = await generateSalarySlipPdf({
      school: { id: schoolId, name: salary.school_name, logo_url: salary.school_logo_url },
      teacher: { id: salary.teacher_id, name: salary.teacher_name, email: salary.teacher_email, class_name: salary.class_name },
      salary
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=salary-slip-${salary.month}-${salary.year}.pdf`);
    return res.send(pdfBuffer);
  } catch (error) {
    console.error('Download Salary Slip Error:', error);
    return res.status(500).json({ success: false, message: 'Failed to generate salary slip PDF' });
  }
};

module.exports = {
  getMyStudents,
  addStudent,
  updateStudent,
  deleteStudent,
  updateProfile,
  getMySalaries,
  getMySalaryRequests,
  createMySalaryRequest,
  getMySalaryById,
  confirmSalaryReceived,
  rejectSalaryReceived,
  downloadSalarySlip,
};
