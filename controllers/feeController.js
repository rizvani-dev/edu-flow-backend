const pool = require('../config/db');
const ExcelJS = require('exceljs');
const fs = require('fs');
const { parseDate } = require('./attendanceController'); // Reuse date helper
const { createNotification } = require('./notificationController');
const { mapMediaFieldsList } = require('../utils/media');
const { del } = require('../services/cacheService');

// @desc    Get fees for a specific student (Student View)
const getStudentFees = async (req, res) => {
  const studentId = req.user.id;
  try {
    const { rows } = await pool.query(
      'SELECT * FROM fees WHERE student_id = $1 ORDER BY year DESC, month DESC',
      [studentId]
    );
    res.json({ success: true, fees: rows });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// @desc    Get fees for all students in a teacher's class (Teacher View)
const getClassFees = async (req, res) => {
  const teacherId = req.user.id;
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 20;
  const offset = (page - 1) * limit;

  try {
    const teacherClassRes = await pool.query(
      "SELECT class_id FROM users WHERE id = $1 AND role = 'teacher'",
      [teacherId]
    );
    const teacherClassId = teacherClassRes.rows[0]?.class_id;

    if (!teacherClassId) {
      return res.json({ success: true, fees: [], hasMore: false });
    }

    const { rows } = await pool.query(`
      SELECT f.*, u.name as student_name, u.email as student_email, c.name as class_name
      FROM fees f
      JOIN users u ON f.student_id = u.id
      LEFT JOIN classes c ON u.class_id = c.id
      WHERE u.class_id = $1
      ORDER BY f.status ASC, u.name ASC
      LIMIT $2 OFFSET $3
    `, [teacherClassId, limit + 1, offset]);

    const hasMore = rows.length > limit;
    const fees = hasMore ? rows.slice(0, limit) : rows;

    res.json({ success: true, fees, hasMore });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// @desc    Teacher approves student fee status
const updateFeeStatus = async (req, res) => {
  const teacherId = req.user.id;
  const { feeId } = req.params;
  const { status } = req.body; // 'paid' or 'pending'

  try {
    // Security Check: Ensure the fee record belongs to a student in this teacher's class
    const teacherClassRes = await pool.query(
      "SELECT class_id FROM users WHERE id = $1 AND role = 'teacher'",
      [teacherId]
    );
    const teacherClassId = teacherClassRes.rows[0]?.class_id;

    const check = await pool.query(`
      SELECT f.id 
      FROM fees f
      JOIN users u ON f.student_id = u.id
      WHERE f.id = $1 AND u.class_id = $2
    `, [feeId, teacherClassId]);

    if (check.rows.length === 0) {
      return res.status(403).json({ success: false, message: 'Unauthorized: Student is not in your class' });
    }

    const { rows } = await pool.query(
      `UPDATE fees 
       SET status = $1, updated_by = $2, updated_at = CURRENT_TIMESTAMP 
       WHERE id = $3 
       RETURNING *`,
      [status, teacherId, feeId]
    );

    if (rows.length > 0) {
      // Clear student dashboard cache so they see the update immediately
      await del(`student:dashboard:${rows[0].student_id}`);
    }

    res.json({ success: true, message: 'Fee status updated', fee: rows[0] });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// @desc    Teacher/Admin updates full fee record
const editFee = async (req, res) => {
  const { feeId } = req.params;
  const { month, year, amount, status, due_date, remarks } = req.body;
  const teacherId = req.user.id;

  try {
    const { rows } = await pool.query(
      `UPDATE fees 
       SET month = $1, year = $2, amount = $3, status = $4, due_date = $5, updated_by = $6, remarks = $7, updated_at = CURRENT_TIMESTAMP 
       WHERE id = $8 RETURNING *`,
      [month, year, amount, status, due_date, teacherId, remarks, feeId]
    );
    res.json({ success: true, fee: rows[0] });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// @desc    Bulk Upload Fees via Excel
const uploadFees = async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, message: "No Excel file uploaded" });
  }

  try {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(req.file.path);
    const worksheet = workbook.getWorksheet(1);

    const sheet = [];
    const headers = [];
    worksheet.getRow(1).eachCell((cell, colNumber) => {
      headers[colNumber] = cell.value ? cell.value.toString().trim() : null;
    });

    worksheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return; // Skip header row
      const rowData = {};
      headers.forEach((header, colNumber) => {
        if (header) {
          const cell = row.getCell(colNumber);
          // Normalize header name to use as object key
          const key = header.toLowerCase().replace(/[\s_]/g, '');
          rowData[key] = cell.value;
        }
      });
      sheet.push(rowData);
    });

    const teacherId = req.user.id;

    // Get the teacher's assigned class
    const teacherClassRes = await pool.query(
      "SELECT class_id FROM users WHERE id = $1 AND role = 'teacher'",
      [teacherId]
    );
    const teacherClassId = teacherClassRes.rows[0]?.class_id;
    if (!teacherClassId) return res.status(403).json({ success: false, message: "You are not assigned to a class section." });

    // Validate required headers as per your request
    const requiredHeaders = ['studentid', 'month', 'year', 'totalfees'];
    const normalizedSheetHeaders = headers.filter(Boolean).map(h => h.toLowerCase().replace(/[\s_]/g, ''));
    
    const missingHeaders = requiredHeaders.filter(h => !normalizedSheetHeaders.includes(h));
    if (missingHeaders.length > 0) {
      return res.status(400).json({ success: false, message: `Missing required Excel columns (case-insensitive): ${missingHeaders.join(', ')}` });
    }

    // Strict Validation: Prevent uploading Attendance Sheet here
    if (normalizedSheetHeaders.includes('status') && !normalizedSheetHeaders.includes('totalfees')) {
       if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
       return res.status(400).json({ success: false, message: "Upload rejected: This appears to be an Attendance Sheet. Please upload it in the Attendance section." });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const invalidRows = [];

      for (const row of sheet) {
        const studentId = row.studentid || row.id;
        if (!studentId) continue;

        const dueDate = parseDate(row.date || row.duedate);
        const amount = row.totalfees || row.due || row.amount || 0;
        const month = row.month || (dueDate ? dueDate.toLocaleString('default', { month: 'long' }) : new Date().toLocaleString('default', { month: 'long' }));
        const year = row.year || (dueDate ? dueDate.getFullYear() : new Date().getFullYear());
        const status = String(row.status || 'pending').toLowerCase();
        const remarks = row.remarks || '';
        
        // Security: Verify student belongs to this teacher's class
        const userCheck = await client.query("SELECT class_id FROM users WHERE id = $1 AND role = 'student'", [studentId]);
        const studentClassId = userCheck.rows[0]?.class_id;

        if (Number(studentClassId) !== Number(teacherClassId)) {
          invalidRows.push({ studentId, classId: studentClassId });
          continue;
        }

        await client.query(`
          INSERT INTO fees (student_id, class_id, month, year, amount, status, due_date, updated_by, remarks)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          ON CONFLICT (student_id, month, year) 
          DO UPDATE SET 
            amount = EXCLUDED.amount, 
            status = EXCLUDED.status, 
            due_date = EXCLUDED.due_date,
            updated_by = EXCLUDED.updated_by,
            remarks = EXCLUDED.remarks,
            class_id = $2
        `, [studentId, teacherClassId, month, year, amount, status, dueDate, teacherId, remarks]);
      }

      if (invalidRows.length > 0) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          success: false,
          message: `Upload rejected: Excel contains ${invalidRows.length} student(s) not in your class section.`,
          invalidRows: invalidRows.slice(0, 30),
        });
      }

      await client.query("COMMIT");
      res.json({ success: true, message: "Fees processed successfully" });
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
      if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    }
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: "Upload failed" });
  }
};

// @desc    Delete Fee Record
const deleteFee = async (req, res) => {
  const { feeId } = req.params;
  try {
    await pool.query('DELETE FROM fees WHERE id = $1', [feeId]);
    res.json({ success: true, message: 'Fee record deleted' });
  } catch (error) {
    res.status(500).json({ success: false });
  }
};

// @desc    Get Fee Statistics for Graph (Teacher View)
const getFeeStats = async (req, res) => {
  const teacherId = req.user.id;
  try {
    const teacherClassRes = await pool.query(
      "SELECT class_id FROM users WHERE id = $1 AND role = 'teacher'",
      [teacherId]
    );
    const teacherClassId = teacherClassRes.rows[0]?.class_id;

    if (!teacherClassId) {
      return res.json({ success: true, stats: [] });
    }

    const { rows } = await pool.query(`
      SELECT status, COUNT(*)::int as count
      FROM fees f
      JOIN users u ON f.student_id = u.id
      WHERE u.class_id = $1
      GROUP BY status
    `, [teacherClassId]);

    res.json({ success: true, stats: rows });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// @desc    Admin generates monthly fee records for all students
const adminGenerateFees = async (req, res) => {
  const { month, year, amount } = req.body;
  try {
    // Get all students
    const students = await pool.query("SELECT id, class_id FROM users WHERE role = 'student'");
    
    for (const student of students.rows) {
      await pool.query(`
        INSERT INTO fees (student_id, class_id, month, year, amount)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (student_id, month, year) DO NOTHING
      `, [student.id, student.class_id, month, year, amount]);
    }

    res.json({ success: true, message: `Fees generated for ${month} ${year}` });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

module.exports = {
  getStudentFees,
  getClassFees,
  updateFeeStatus,
  editFee,
  uploadFees,
  deleteFee,
  getFeeStats,
  adminGenerateFees,

  // Manual student payment requests
  createFeePaymentRequest,
  listFeePaymentRequests,
  reviewFeePaymentRequest,
};

// ====================== Manual Fee Payment Requests ======================

// @desc Student submits manual fee payment request
async function createFeePaymentRequest(req, res) {
  const studentId = req.user.id;
  const schoolId = req.user.school_id;
  const { transaction_id, fee_id } = req.body;
  const file = req.file;

  if (!transaction_id?.trim()) {
    return res.status(400).json({ success: false, message: 'Transaction ID is required' });
  }

  try {
    let screenshotUrl = null;
    if (file) {
      screenshotUrl = file.path;
    }

    // Optional: validate fee belongs to student if provided
    let feeIdToSave = null;
    if (fee_id) {
      const feeRes = await pool.query('SELECT id FROM fees WHERE id = $1 AND student_id = $2', [fee_id, studentId]);
      if (!feeRes.rows.length) {
        return res.status(403).json({ success: false, message: 'Invalid fee selected' });
      }
      feeIdToSave = Number(fee_id);
    }

    const { rows } = await pool.query(
      `INSERT INTO fee_payment_requests (school_id, student_id, fee_id, transaction_id, screenshot_url, status)
       VALUES ($1, $2, $3, $4, $5, 'pending')
       RETURNING *`,
      [schoolId, studentId, feeIdToSave, transaction_id.trim(), screenshotUrl]
    );

    const admins = await pool.query(
      "SELECT id FROM users WHERE role = 'admin' AND school_id = $1",
      [schoolId]
    );
    await Promise.all(
      admins.rows.map((admin) =>
        createNotification(
          admin.id,
          'Fee payment request',
          `Student submitted fee payment request [requestId:${rows[0].id}] [tx:${transaction_id.trim()}]`,
          'fee_payment_request',
          studentId,
          req.app.get('socketio')
        )
      )
    );

    return res.status(201).json({ success: true, request: rows[0] });
  } catch (error) {
    console.error('Create Fee Payment Request Error:', error);
    return res.status(500).json({ success: false, message: 'Failed to submit payment request' });
  }
}

// @desc Admin lists fee payment requests
async function listFeePaymentRequests(req, res) {
  const schoolId = req.user.school_id;
  const status = String(req.query.status || 'pending');
  try {
    const { rows } = await pool.query(
      `SELECT r.*,
              u.name AS student_name,
              u.email AS student_email
       FROM fee_payment_requests r
       JOIN users u ON u.id = r.student_id
       WHERE COALESCE(r.school_id, u.school_id) = $1
         AND ($2::text = 'all' OR r.status = $2)
       ORDER BY r.created_at DESC
       LIMIT 100`,
      [schoolId, status]
    );
    return res.json({ success: true, requests: mapMediaFieldsList(rows, ['screenshot_url']) });
  } catch (error) {
    console.error('List Fee Payment Requests Error:', error);
    return res.status(500).json({ success: false, message: 'Failed to load requests' });
  }
}

// @desc Admin approves/rejects a request (and optionally marks a fee as paid)
async function reviewFeePaymentRequest(req, res) {
  const adminId = req.user.id;
  const schoolId = req.user.school_id;
  const { requestId } = req.params;
  const { status, remarks, mark_fee_paid } = req.body;

  if (!['approved', 'rejected'].includes(String(status))) {
    return res.status(400).json({ success: false, message: 'Invalid status' });
  }

  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const reqRes = await client.query(
        `SELECT r.*
         FROM fee_payment_requests r
         JOIN users student ON student.id = r.student_id
         WHERE r.id = $1
           AND COALESCE(r.school_id, student.school_id) = $2
         FOR UPDATE`,
        [requestId, schoolId]
      );
      if (!reqRes.rows.length) {
        await client.query('ROLLBACK');
        return res.status(404).json({ success: false, message: 'Request not found' });
      }

      const request = reqRes.rows[0];

      const { rows } = await client.query(
        `UPDATE fee_payment_requests
         SET status = $1,
             remarks = $2,
             reviewed_by = $3,
             reviewed_at = NOW()
         WHERE id = $4
         RETURNING *`,
        [status, remarks || null, adminId, requestId]
      );

      if (status === 'approved' && mark_fee_paid && request.fee_id) {
        await client.query(
          `UPDATE fees
           SET status = 'paid',
               updated_by = $1,
               updated_at = CURRENT_TIMESTAMP,
               remarks = COALESCE(remarks, '')
           WHERE id = $2 AND student_id = $3`,
          [adminId, request.fee_id, request.student_id]
        );
      }

      await client.query('COMMIT');

      const io = req.app.get('socketio');

      // Invalidate student dashboard cache
      await del(`student:dashboard:${request.student_id}`);
      if (io) io.to(`user_${request.student_id}`).emit('dashboardDataUpdate', { type: 'fee_approved' });

      // Notify student
      await createNotification(
        request.student_id,
        status === 'approved' ? 'Fee payment approved' : 'Fee payment rejected',
        status === 'approved'
          ? `Your fee payment request was approved. [requestId:${requestId}]`
          : `Your fee payment request was rejected. ${remarks ? `Reason: ${remarks}` : ''} [requestId:${requestId}]`,
        status === 'approved' ? 'fee_payment_approved' : 'fee_payment_rejected',
        adminId,
        io
      );

      return res.json({ success: true, request: rows[0] });
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Review Fee Payment Request Error:', error);
    return res.status(500).json({ success: false, message: 'Failed to update request' });
  }
}
