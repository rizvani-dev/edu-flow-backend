const pool = require('../config/db');

// Teacher: Add / Update Marks for students in their own class
const addOrUpdateResult = async (req, res) => {
  const teacherId = req.user.id;
  const { student_id, subject, marks, class_id } = req.body;

  if (marks < 0 || marks > 100) {
    return res.status(400).json({ success: false, message: 'Marks must be between 0 and 100' });
  }

  try {
    // Verify teacher can only manage their own class
    const classCheck = await pool.query(
      'SELECT class_id FROM users WHERE id = $1 AND role = \'teacher\'', 
      [teacherId]
    );

    const teacherClassId = classCheck.rows[0]?.class_id;

    if (!teacherClassId || teacherClassId !== parseInt(class_id)) {
      return res.status(403).json({ success: false, message: 'You can only manage results for your assigned class' });
    }

    // Check if result already exists for this student + subject
    const existing = await pool.query(
      'SELECT id FROM results WHERE student_id = $1 AND subject = $2',
      [student_id, subject]
    );

    if (existing.rows.length > 0) {
      // Update existing result
      const { rows } = await pool.query(
        `UPDATE results 
         SET marks = $1, teacher_id = $2 
         WHERE student_id = $3 AND subject = $4 
         RETURNING *`,
        [marks, teacherId, student_id, subject]
      );
      return res.json({ 
        success: true, 
        message: 'Result updated successfully', 
        result: rows[0] 
      });
    }

    // Insert new result
    const { rows } = await pool.query(
      `INSERT INTO results (student_id, teacher_id, class_id, subject, marks)
       VALUES ($1, $2, $3, $4, $5) 
       RETURNING *`,
      [student_id, teacherId, class_id, subject, marks]
    );

    res.status(201).json({
      success: true,
      message: 'Result added successfully',
      result: rows[0]
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// Get Results (Teacher: own class / Student: own results)
const getResults = async (req, res) => {
  const userId = req.user.id;
  const userRole = req.user.role;

  try {
    let query;
    let values;

    if (userRole === 'teacher') {
      // Teacher sees results of their own class
      query = `
        SELECT r.id, r.student_id, u.name as student_name, r.subject, r.marks, r.created_at
        FROM results r
        JOIN users u ON r.student_id = u.id
        WHERE r.teacher_id = $1
        ORDER BY r.created_at DESC, u.name
      `;
      values = [userId];
    } else if (userRole === 'student') {
      // Student sees only their own results
      query = `
        SELECT subject, marks, created_at 
        FROM results 
        WHERE student_id = $1 
        ORDER BY created_at DESC
      `;
      values = [userId];
    } else {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }

    const { rows } = await pool.query(query, values);
    res.json({ success: true, results: rows });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

module.exports = {
  addOrUpdateResult,
  getResults
};