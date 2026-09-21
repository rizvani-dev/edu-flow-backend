const pool = require('../config/db');
const ExcelJS = require('exceljs');
const fs = require('fs');
const { parseDate } = require('./attendanceController');
const { createNotification } = require('./notificationController');
const { mapMediaFieldsList } = require('../utils/media');
const { del } = require('../services/cacheService');
const { generateFeeReceiptPdf } = require('../utils/pdfGenerator');

// Helper for audit logging
const logAuditAction = async (schoolId, userId, action, entityType, entityId, metadata = {}) => {
  try {
    await pool.query(
      `INSERT INTO audit_logs (school_id, user_id, action, entity_type, entity_id, metadata)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [schoolId, userId, action, entityType, entityId, JSON.stringify(metadata)]
    );
  } catch (err) {
    console.warn('Audit log error:', err.message);
  }
};

const getTeacherClassId = async (userId, schoolId) => {
  const { rows } = await pool.query(
    `SELECT class_id FROM users
     WHERE id = $1 AND role = 'teacher' AND school_id = $2
     LIMIT 1`,
    [userId, schoolId]
  );
  return rows[0]?.class_id || null;
};

// @desc    Get fees for a specific student (Student View)
const getStudentFees = async (req, res) => {
  const studentId = req.user.id;
  try {
    const { rows } = await pool.query(
      `SELECT f.*,
              latest_request.id AS payment_request_id,
              latest_request.status AS payment_request_status,
              latest_request.transaction_id
       FROM fees f
       LEFT JOIN LATERAL (
         SELECT id, status, transaction_id
         FROM fee_payment_requests
         WHERE fee_id = f.id
         ORDER BY created_at DESC
         LIMIT 1
       ) latest_request ON true
       WHERE f.student_id = $1
       ORDER BY f.year DESC,
                CASE f.month
                  WHEN 'January' THEN 1 WHEN 'February' THEN 2 WHEN 'March' THEN 3
                  WHEN 'April' THEN 4 WHEN 'May' THEN 5 WHEN 'June' THEN 6
                  WHEN 'July' THEN 7 WHEN 'August' THEN 8 WHEN 'September' THEN 9
                  WHEN 'October' THEN 10 WHEN 'November' THEN 11 WHEN 'December' THEN 12
                END DESC`,
      [studentId]
    );
    const fees = rows.map((fee) => {
      const status = fee.payment_request_status === 'pending'
        ? 'pending'
        : fee.payment_request_status === 'approved' || fee.status === 'paid'
          ? 'paid'
          : String(fee.status || 'unpaid').toLowerCase();
      return { ...fee, status, selectable: ['unpaid', 'overdue', 'rejected'].includes(status) };
    });
    res.json({ success: true, fees });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// @desc    Get Current Month Fee Status for Student Dashboard
const getCurrentFee = async (req, res) => {
  const studentId = req.user.id;
  const schoolId = req.user.school_id;

  try {
    const now = new Date();
    const currentMonth = now.toLocaleString('en-US', { month: 'long' });
    const currentYear = now.getFullYear();

    // 1. Check if record exists for this month
    let { rows } = await pool.query(
      `SELECT f.*, 
              latest_request.id AS payment_request_id,
              latest_request.status AS request_status,
              latest_request.transaction_id,
              latest_request.screenshot_url
       FROM fees f
       LEFT JOIN LATERAL (
         SELECT id, status, transaction_id, screenshot_url
         FROM fee_payment_requests
         WHERE fee_id = f.id
         ORDER BY created_at DESC
         LIMIT 1
       ) latest_request ON true
       WHERE f.student_id = $1 AND LOWER(TRIM(f.month)) = LOWER($2) AND f.year = $3
       LIMIT 1`,
      [studentId, currentMonth, currentYear]
    );

    let fee = rows[0] || null;

    // If no fee record exists, show the configured amount without inventing a fallback price.
    if (!fee) {
      const studentRes = await pool.query(
        `SELECT u.id, u.class_id, fs.monthly_fee 
         FROM users u
         LEFT JOIN fee_structures fs ON fs.class_id = u.class_id AND fs.school_id = u.school_id
         WHERE u.id = $1 AND u.role = 'student'`,
        [studentId]
      );
      const studentInfo = studentRes.rows[0];
      const configuredAmount = studentInfo?.monthly_fee == null ? null : Number(studentInfo.monthly_fee);

      // Construct a virtual/unbilled fee representation
      fee = {
        id: null,
        student_id: studentId,
        month: currentMonth,
        year: currentYear,
        amount: configuredAmount,
        status: configuredAmount == null ? 'unavailable' : 'unpaid',
        due_date: new Date(currentYear, now.getMonth(), 10).toISOString().split('T')[0],
        remarks: configuredAmount == null ? 'No fee structure configured for this class' : 'Configured monthly school fee'
      };
    } else {
      // If payment request is pending, display status clearly
      if (fee.request_status === 'pending') fee.status = 'pending';
      if (fee.request_status === 'approved') fee.status = 'paid';
      fee.payment_request_id = fee.payment_request_id || null;
      fee.selectable = ['unpaid', 'overdue', 'rejected'].includes(String(fee.status).toLowerCase());
    }

    res.json({
      success: true,
      currentFee: fee,
      month: currentMonth,
      year: currentYear
    });
  } catch (error) {
    console.error('Get Current Fee Error:', error);
    res.status(500).json({ success: false, message: 'Server error retrieving current fee' });
  }
};

// @desc    Get Eligible Unpaid Months for Student Payment Submission
const getEligibleMonths = async (req, res) => {
  const studentId = req.user.id;
  const schoolId = req.user.school_id;

  try {
    // Return each monthly fee with its effective payment state. The client must not
    // infer payment eligibility from a missing request or from an amount.
    const { rows } = await pool.query(
      `SELECT f.id, f.month, f.year, f.amount, f.due_date, f.status,
              latest_request.id AS payment_request_id,
              latest_request.status AS payment_request_status,
              latest_request.transaction_id
       FROM fees f
       LEFT JOIN LATERAL (
         SELECT id, status, transaction_id
         FROM fee_payment_requests
         WHERE fee_id = f.id
         ORDER BY created_at DESC
         LIMIT 1
       ) latest_request ON true
       WHERE f.student_id = $1
       ORDER BY f.year DESC, 
                CASE f.month 
                  WHEN 'January' THEN 1 WHEN 'February' THEN 2 WHEN 'March' THEN 3 
                  WHEN 'April' THEN 4 WHEN 'May' THEN 5 WHEN 'June' THEN 6 
                  WHEN 'July' THEN 7 WHEN 'August' THEN 8 WHEN 'September' THEN 9 
                  WHEN 'October' THEN 10 WHEN 'November' THEN 11 WHEN 'December' THEN 12 
                END DESC`,
      [studentId]
    );

    const eligibleMonths = rows.map((fee) => {
      const isPaid = fee.status === 'paid' || fee.payment_request_status === 'approved';
      const isPending = fee.payment_request_status === 'pending';
      const effectiveStatus = isPaid ? 'paid' : isPending ? 'pending' : String(fee.status || 'unpaid').toLowerCase();
      const isSelectable = ['unpaid', 'overdue', 'rejected'].includes(effectiveStatus);

      const displayStatus = ['unpaid', 'overdue', 'rejected', 'paid', 'pending'].includes(effectiveStatus)
        ? effectiveStatus
        : 'unpaid';

      return {
        id: fee.id,
        month: fee.month,
        year: fee.year,
        amount: Number(fee.amount),
        due_date: fee.due_date,
        status: displayStatus,
        selectable: isSelectable,
        payment_request_id: fee.payment_request_id,
        transaction_id: fee.transaction_id,
        disabledReason: isPaid ? 'Already Paid' : isPending ? 'Payment Under Review' : null
      };
    });

    res.json({ success: true, eligibleMonths });
  } catch (error) {
    console.error('Get Eligible Months Error:', error);
    res.status(500).json({ success: false, message: 'Failed to load eligible months' });
  }
};

// @desc    Get fees for all students in a teacher's class (Teacher View)
const getClassFees = async (req, res) => {
  const teacherId = req.user.id;
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 20;
  const offset = (page - 1) * limit;

  try {
    const teacherClassId = await getTeacherClassId(teacherId, req.user.school_id);

    if (!teacherClassId) {
      return res.json({ success: true, fees: [], hasMore: false });
    }

    const { rows } = await pool.query(`
      SELECT f.*, u.name as student_name, u.email as student_email, c.name as class_name,
             latest_request.id AS payment_request_id,
             latest_request.status AS payment_request_status,
             latest_request.transaction_id,
             latest_request.screenshot_url,
             latest_request.remarks AS payment_request_remarks
      FROM fees f
      JOIN users u ON f.student_id = u.id
      LEFT JOIN classes c ON u.class_id = c.id
      LEFT JOIN LATERAL (
        SELECT id, status, transaction_id, screenshot_url, remarks
        FROM fee_payment_requests
        WHERE fee_id = f.id
        ORDER BY created_at DESC
        LIMIT 1
      ) latest_request ON true
      WHERE u.class_id = $1 AND f.school_id = $2
      ORDER BY f.status ASC, u.name ASC
      LIMIT $3 OFFSET $4
    `, [teacherClassId, req.user.school_id, limit + 1, offset]);

    const hasMore = rows.length > limit;
    const fees = hasMore ? rows.slice(0, limit) : rows;

    res.json({ success: true, fees, hasMore });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

const createTeacherFeeProposal = async (req, res) => {
  const teacherId = req.user.id;
  const schoolId = req.user.school_id;
  const { month, year, due_date, amount: proposedAmount } = req.body;

  if (!month || !Number.isInteger(Number(year))) {
    return res.status(400).json({ success: false, message: 'Month and year are required' });
  }

  const classId = await getTeacherClassId(teacherId, schoolId);
  if (!classId) return res.status(403).json({ success: false, message: 'Teacher is not assigned to a class' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const structure = await client.query(
      `SELECT monthly_fee FROM fee_structures
       WHERE school_id = $1 AND class_id = $2`,
      [schoolId, classId]
    );
    const configuredAmount = structure.rows[0]?.monthly_fee;
    const amount = configuredAmount == null ? Number(proposedAmount) : Number(configuredAmount);
    if (configuredAmount == null && (!Number.isFinite(amount) || amount <= 0)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, code: 'FEE_AMOUNT_REQUIRED', message: 'Enter a valid monthly fee amount for this proposal or configure the class fee structure' });
    }

    const students = await client.query(
      `SELECT id FROM users
       WHERE school_id = $1 AND class_id = $2 AND role = 'student'`,
      [schoolId, classId]
    );
    let createdCount = 0;
    for (const student of students.rows) {
      const result = await client.query(
        `INSERT INTO fees (school_id, student_id, class_id, month, year, amount, status, due_date, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, 'unpaid', $7, $8)
         ON CONFLICT (student_id, month, year) DO NOTHING
         RETURNING id`,
        [schoolId, student.id, classId, String(month).trim(), Number(year), amount, due_date || null, teacherId]
      );
      createdCount += result.rowCount;
    }
    await client.query('COMMIT');
    await logAuditAction(schoolId, teacherId, 'FEE_PROPOSAL_CREATED', 'FEES', null, { class_id: classId, month, year, createdCount });
    return res.status(201).json({ success: true, message: `Fee proposal created for ${createdCount} students`, createdCount });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Create Teacher Fee Proposal Error:', error);
    return res.status(500).json({ success: false, message: 'Failed to create fee proposal' });
  } finally {
    client.release();
  }
};

// @desc    Teacher/Admin approves student fee status
const updateFeeStatus = async (req, res) => {
  const userId = req.user.id;
  const schoolId = req.user.school_id;
  const userRole = req.user.role;
  const { feeId } = req.params;
  const { status } = req.body;

  try {
    if (!['unpaid', 'pending', 'paid', 'overdue', 'rejected'].includes(String(status).toLowerCase())) {
      return res.status(400).json({ success: false, message: 'Invalid fee status' });
    }

    let checkQuery = 'SELECT f.* FROM fees f JOIN users u ON f.student_id = u.id WHERE f.id = $1 AND f.school_id = $2';
    let checkParams = [feeId, schoolId];

    if (userRole === 'teacher') {
      const teacherClassId = await getTeacherClassId(userId, schoolId);
      if (!teacherClassId) return res.status(403).json({ success: false, message: 'Unauthorized' });

      checkQuery += ' AND u.class_id = $3';
      checkParams.push(teacherClassId);
    }

    const check = await pool.query(checkQuery, checkParams);
    if (check.rows.length === 0) {
      return res.status(403).json({ success: false, message: 'Unauthorized or record not found' });
    }

    const { rows } = await pool.query(
      `UPDATE fees 
       SET status = $1, updated_by = $2, updated_at = CURRENT_TIMESTAMP 
       WHERE id = $3 AND school_id = $4
       RETURNING *`,
      [status, userId, feeId, schoolId]
    );

    if (rows.length > 0) {
      await del(`student:dashboard:${rows[0].student_id}`);
    }

    res.json({ success: true, message: 'Fee status updated', fee: rows[0] });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// @desc    Admin updates full fee record
const editFee = async (req, res) => {
  const { feeId } = req.params;
  const schoolId = req.user.school_id;
  const { month, year, amount, status, due_date, remarks } = req.body;
  const adminId = req.user.id;

  try {
    const { rows } = await pool.query(
      `UPDATE fees 
       SET month = $1, year = $2, amount = $3, status = $4, due_date = $5, updated_by = $6, remarks = $7, updated_at = CURRENT_TIMESTAMP 
       WHERE id = $8 AND school_id = $9 RETURNING *`,
      [month, year, amount, status, due_date, adminId, remarks, feeId, schoolId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Fee record not found' });
    }

    await del(`student:dashboard:${rows[0].student_id}`);
    res.json({ success: true, fee: rows[0] });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// @desc    Delete Fee Record
const deleteFee = async (req, res) => {
  const { feeId } = req.params;
  const schoolId = req.user.school_id;

  try {
    const { rowCount } = await pool.query('DELETE FROM fees WHERE id = $1 AND school_id = $2', [feeId, schoolId]);
    if (rowCount === 0) {
      return res.status(404).json({ success: false, message: 'Fee record not found' });
    }
    res.json({ success: true, message: 'Fee record deleted' });
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
      if (rowNumber === 1) return;
      const rowData = {};
      headers.forEach((header, colNumber) => {
        if (header) {
          const cell = row.getCell(colNumber);
          const key = header.toLowerCase().replace(/[\s_]/g, '');
          rowData[key] = cell.value;
        }
      });
      sheet.push(rowData);
    });

    const teacherId = req.user.id;
    const schoolId = req.user.school_id;

    // Get the teacher's assigned class
    const teacherClassRes = await pool.query(
      "SELECT class_id FROM users WHERE id = $1 AND role = 'teacher' AND school_id = $2",
      [teacherId, schoolId]
    );
    const teacherClassId = teacherClassRes.rows[0]?.class_id;
    if (!teacherClassId) return res.status(403).json({ success: false, message: "You are not assigned to a class section." });

    const requiredHeaders = ['studentid', 'month', 'year', 'totalfees'];
    const normalizedSheetHeaders = headers.filter(Boolean).map(h => h.toLowerCase().replace(/[\s_]/g, ''));
    
    const missingHeaders = requiredHeaders.filter(h => !normalizedSheetHeaders.includes(h));
    if (missingHeaders.length > 0) {
      return res.status(400).json({ success: false, message: `Missing required Excel columns: ${missingHeaders.join(', ')}` });
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
        
        // Security: Verify student belongs to this teacher's class AND current school
        const userCheck = await client.query("SELECT class_id FROM users WHERE id = $1 AND role = 'student' AND school_id = $2", [studentId, schoolId]);
        const studentClassId = userCheck.rows[0]?.class_id;

        if (Number(studentClassId) !== Number(teacherClassId)) {
          invalidRows.push({ studentId, classId: studentClassId });
          continue;
        }

        await client.query(`
          INSERT INTO fees (school_id, student_id, class_id, month, year, amount, status, due_date, updated_by, remarks)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
          ON CONFLICT (student_id, month, year) 
          DO UPDATE SET 
            amount = EXCLUDED.amount, 
            status = EXCLUDED.status, 
            due_date = EXCLUDED.due_date,
            updated_by = EXCLUDED.updated_by,
            remarks = EXCLUDED.remarks,
            class_id = $3,
            school_id = $1
        `, [schoolId, studentId, teacherClassId, month, year, amount, status, dueDate, teacherId, remarks]);
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

// @desc    Get Fee Statistics for Graph (Teacher View)
const getFeeStats = async (req, res) => {
  const teacherId = req.user.id;
  const schoolId = req.user.school_id;
  try {
    const teacherClassRes = await pool.query(
      "SELECT class_id FROM users WHERE id = $1 AND role = 'teacher' AND school_id = $2",
      [teacherId, schoolId]
    );
    const teacherClassId = teacherClassRes.rows[0]?.class_id;

    if (!teacherClassId) {
      return res.json({ success: true, stats: [] });
    }

    const { rows } = await pool.query(`
      SELECT status, COUNT(*)::int as count
      FROM fees f
      JOIN users u ON f.student_id = u.id
      WHERE u.class_id = $1 AND f.school_id = $2
      GROUP BY status
    `, [teacherClassId, schoolId]);

    res.json({ success: true, stats: rows });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// @desc    Admin generates monthly fee records for all students (FIXED: TENANT ISOLATION)
const adminGenerateFees = async (req, res) => {
  const schoolId = req.user.school_id;
  const { month, year, class_id } = req.body;

  if (!month || !year) {
    return res.status(400).json({ success: false, message: 'Month and year are required' });
  }

  try {
    // 1. Fetch configured fee structure for each class in this school
    const feeStructuresRes = await pool.query(
      'SELECT class_id, monthly_fee FROM fee_structures WHERE school_id = $1',
      [schoolId]
    );
    const feeMap = new Map();
    feeStructuresRes.rows.forEach(r => feeMap.set(Number(r.class_id), Number(r.monthly_fee)));

    // 2. Fetch only students belonging to this school
    let studentQuery = "SELECT id, class_id FROM users WHERE role = 'student' AND school_id = $1";
    const queryParams = [schoolId];

    if (class_id) {
      studentQuery += ' AND class_id = $2';
      queryParams.push(class_id);
    }

    const students = await pool.query(studentQuery, queryParams);
    let createdCount = 0;

    const defaultDueDate = new Date(year, new Date(`${month} 1, 2026`).getMonth() || new Date().getMonth(), 10);

    for (const student of students.rows) {
      const configuredClassFee = student.class_id ? feeMap.get(Number(student.class_id)) : null;
      if (configuredClassFee == null) continue;
      const finalAmount = configuredClassFee;

      const insertRes = await pool.query(`
        INSERT INTO fees (school_id, student_id, class_id, month, year, amount, status, due_date)
        VALUES ($1, $2, $3, $4, $5, $6, 'unpaid', $7)
        ON CONFLICT (student_id, month, year) DO NOTHING
        RETURNING id
      `, [schoolId, student.id, student.class_id, month, year, finalAmount, defaultDueDate]);

      if (insertRes.rowCount > 0) createdCount++;
    }

    await logAuditAction(schoolId, req.user.id, 'FEE_GENERATED', 'FEES', null, { month, year, createdCount });

    res.json({
      success: true,
      message: `Monthly fees generated successfully for ${month} ${year} (${createdCount} records created)`
    });
  } catch (error) {
    console.error('Admin Generate Fees Error:', error);
    res.status(500).json({ success: false, message: 'Server error generating fees' });
  }
};

// @desc    Get School Fee Structure (Admin View)
const getFeeStructure = async (req, res) => {
  const schoolId = req.user.school_id;
  try {
    const { rows } = await pool.query(`
      SELECT c.id AS class_id, c.name AS class_name, c.grade_level, c.section,
             fs.monthly_fee,
             fs.id AS structure_id,
             fs.effective_from
      FROM classes c
      LEFT JOIN fee_structures fs ON fs.class_id = c.id AND fs.school_id = c.school_id
      WHERE c.school_id = $1
      ORDER BY c.grade_level, c.section
    `, [schoolId]);

    res.json({ success: true, structures: rows });
  } catch (error) {
    console.error('Get Fee Structure Error:', error);
    res.status(500).json({ success: false, message: 'Failed to load fee structures' });
  }
};

// @desc    Save/Update Class Fee Structure (Admin View)
const saveFeeStructure = async (req, res) => {
  const schoolId = req.user.school_id;
  const adminId = req.user.id;
  const { class_id, monthly_fee } = req.body;

  if (!class_id || monthly_fee == null) {
    return res.status(400).json({ success: false, message: 'Class ID and monthly fee are required' });
  }

  try {
    const { rows } = await pool.query(`
      INSERT INTO fee_structures (school_id, class_id, monthly_fee, created_by, effective_from)
      VALUES ($1, $2, $3, $4, CURRENT_DATE)
      ON CONFLICT (school_id, class_id)
      DO UPDATE SET monthly_fee = EXCLUDED.monthly_fee, effective_from = CURRENT_DATE
      RETURNING *
    `, [schoolId, class_id, Number(monthly_fee), adminId]);

    await logAuditAction(schoolId, adminId, 'FEE_STRUCTURE_UPDATED', 'FEE_STRUCTURE', rows[0].id, { class_id, monthly_fee });

    res.json({ success: true, message: 'Fee structure updated successfully', structure: rows[0] });
  } catch (error) {
    console.error('Save Fee Structure Error:', error);
    res.status(500).json({ success: false, message: 'Failed to save fee structure' });
  }
};

// @desc    Send fee reminders to students with pending fees
const sendMonthlyFeeReminders = async (req, res) => {
  const schoolId = req.user.school_id;
  const { month, year } = req.body;

  try {
    const { rows } = await pool.query(
      `SELECT u.id, u.name, f.amount, f.month, f.year
       FROM users u
       JOIN fees f ON f.student_id = u.id
       WHERE u.school_id = $1 AND u.role = 'student'
         AND f.month = $2 AND f.year = $3
         AND LOWER(f.status) IN ('unpaid', 'overdue', 'rejected')`,
      [schoolId, month, year]
    );

    const io = req.app.get('socketio');
    await Promise.all(
      rows.map((student) =>
        createNotification(
          student.id,
          'Fee Reminder',
          `Hi ${student.name}, your fee for ${student.month} ${student.year} (PKR ${Number(student.amount).toLocaleString()}) is still pending. Please pay to avoid penalties.`,
          'fee_reminder',
          req.user.id,
          io
        )
      )
    );

    res.json({ success: true, message: `Reminders sent to ${rows.length} students` });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Failed to send reminders' });
  }
};

// ====================== Manual Student Payment Requests ======================

// @desc Student submits manual fee payment request
async function createFeePaymentRequest(req, res) {
  const studentId = req.user.id;
  const schoolId = req.user.school_id;
  const { transaction_id, fee_id } = req.body;
  const file = req.file;

  if (!transaction_id?.trim()) {
    return res.status(400).json({ success: false, message: 'Transaction ID is required' });
  }

  if (!file) {
    return res.status(400).json({ success: false, message: 'Payment screenshot is required' });
  }

  if (!fee_id) {
    return res.status(400).json({ success: false, message: 'Select a monthly fee record before submitting payment' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const feeRes = await client.query(
      `SELECT f.*,
              EXISTS (
                SELECT 1 FROM fee_payment_requests
                WHERE fee_id = f.id AND status = 'pending'
              ) AS has_pending_request,
              EXISTS (
                SELECT 1 FROM fee_payment_requests
                WHERE fee_id = f.id AND status = 'approved'
              ) AS has_approved_request
       FROM fees f
       WHERE f.id = $1 AND f.student_id = $2 AND f.school_id = $3
       FOR UPDATE`,
      [fee_id, studentId, schoolId]
    );
    if (!feeRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(403).json({ success: false, message: 'Invalid fee record selected' });
    }

    const feeRecord = feeRes.rows[0];
    if (feeRecord.status === 'paid' || feeRecord.has_approved_request) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: 'This month is already marked as PAID' });
    }
    if (feeRecord.has_pending_request) {
      await client.query('ROLLBACK');
      return res.status(409).json({ success: false, message: 'A payment verification request is already pending review for this month' });
    }

    const targetMonth = feeRecord.month;
    const targetYear = feeRecord.year;
    const targetAmount = feeRecord.amount;

    const screenshotUrl = file.path;

    const { rows } = await client.query(
      `INSERT INTO fee_payment_requests 
       (school_id, student_id, fee_id, transaction_id, screenshot_url, status, month, year, amount)
       VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7, $8)
       RETURNING *`,
      [schoolId, studentId, fee_id ? Number(fee_id) : null, transaction_id.trim(), screenshotUrl, targetMonth, targetYear, targetAmount]
    );

    // Update fee status to 'pending'
    await client.query(
      `UPDATE fees SET status = 'pending', updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND student_id = $2 AND school_id = $3`,
      [fee_id, studentId, schoolId]
    );
    await client.query('COMMIT');

    // Invalidate dashboard cache
    await del(`student:dashboard:${studentId}`);

    const recipients = await pool.query(
      `SELECT id FROM users
       WHERE school_id = $1 AND role = 'admin'
       UNION
       SELECT u.id
       FROM users u
       JOIN fees f ON f.class_id = u.class_id AND f.id = $2
       WHERE u.role = 'teacher' AND u.school_id = $1`,
      [schoolId, fee_id]
    );
    const io = req.app.get('socketio');
    await Promise.all(
      recipients.rows.map((recipient) =>
        createNotification(
          recipient.id,
          'New Fee Payment Submitted',
          `Student submitted payment for ${targetMonth} ${targetYear} [requestId:${rows[0].id}] [feeId:${fee_id}] [tx:${transaction_id.trim()}]`,
          'fee_payment_request',
          rows[0].id,
          io
        )
      )
    );

    return res.status(201).json({
      success: true,
      message: 'Payment verification request submitted successfully',
      request: rows[0]
    });
  } catch (error) {
    await client.query('ROLLBACK');
    if (error.code === '23505') {
      return res.status(409).json({ success: false, message: 'A payment verification request is already pending for this month' });
    }
    console.error('Create Fee Payment Request Error:', error);
    return res.status(500).json({ success: false, message: 'Failed to submit payment request' });
  } finally {
    client.release();
  }
}

// @desc Admin lists fee payment requests
async function listFeePaymentRequests(req, res) {
  const schoolId = req.user.school_id;
  const status = String(req.query.status || 'all');
  const teacherClassId = req.user.role === 'teacher' ? await getTeacherClassId(req.user.id, schoolId) : null;
  if (req.user.role === 'teacher' && !teacherClassId) {
    return res.json({ success: true, requests: [] });
  }
  try {
    const { rows } = await pool.query(
      `SELECT r.*,
              u.name AS student_name,
              u.email AS student_email,
              c.name AS class_name,
              f.month AS fee_month,
              f.year AS fee_year,
              f.amount AS fee_amount
       FROM fee_payment_requests r
       JOIN users u ON u.id = r.student_id
       LEFT JOIN classes c ON c.id = u.class_id
       LEFT JOIN fees f ON f.id = r.fee_id
       WHERE COALESCE(r.school_id, u.school_id) = $1
         AND ($3::integer IS NULL OR u.class_id = $3)
         AND ($2::text = 'all' OR r.status = $2)
       ORDER BY r.created_at DESC
       LIMIT 100`,
      [schoolId, status, teacherClassId]
    );
    return res.json({ success: true, requests: mapMediaFieldsList(rows, ['screenshot_url']) });
  } catch (error) {
    console.error('List Fee Payment Requests Error:', error);
    return res.status(500).json({ success: false, message: 'Failed to load requests' });
  }
}

// @desc Admin approves/rejects a payment request (Strict Financial Workflow)
async function reviewFeePaymentRequest(req, res) {
  const adminId = req.user.id;
  const schoolId = req.user.school_id;
  const { requestId } = req.params;
  const { status, remarks } = req.body;

  if (!['approved', 'rejected'].includes(String(status))) {
    return res.status(400).json({ success: false, message: 'Invalid status. Must be approved or rejected' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const reqRes = await client.query(
      `SELECT r.*, u.name as student_name
       FROM fee_payment_requests r
       JOIN users u ON u.id = r.student_id
       WHERE r.id = $1 AND COALESCE(r.school_id, u.school_id) = $2
         AND ($3::integer IS NULL OR u.class_id = $3)
       FOR UPDATE`,
      [requestId, schoolId, req.user.role === 'teacher' ? await getTeacherClassId(adminId, schoolId) : null]
    );

    if (!reqRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Request not found' });
    }

    const request = reqRes.rows[0];

    if (request.status !== 'pending') {
      await client.query('ROLLBACK');
      return res.status(409).json({ success: false, message: 'This payment request has already been reviewed' });
    }

    const approvedTimestamp = status === 'approved' ? new Date() : null;
    const rejectedTimestamp = status === 'rejected' ? new Date() : null;

    const { rows } = await client.query(
      `UPDATE fee_payment_requests
       SET status = $1,
           remarks = $2,
           reviewed_by = $3,
           reviewed_at = NOW(),
           approved_at = $4,
           rejected_at = $5
       WHERE id = $6
       RETURNING *`,
      [status, remarks || null, adminId, approvedTimestamp, rejectedTimestamp, requestId]
    );

    // When Approved: Fee status automatically becomes 'paid'
    if (status === 'approved' && request.fee_id) {
      await client.query(
        `UPDATE fees
         SET status = 'paid',
             updated_by = $1,
             updated_at = CURRENT_TIMESTAMP,
             remarks = COALESCE(remarks, '') || ' [Approved tx:' || $2 || ']'
         WHERE id = $3 AND student_id = $4`,
        [adminId, request.transaction_id, request.fee_id, request.student_id]
      );
    } else if (status === 'rejected' && request.fee_id) {
      // Revert fee to 'unpaid' or 'rejected' so student can resubmit
      await client.query(
        `UPDATE fees
         SET status = 'rejected',
             updated_by = $1,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $2 AND student_id = $3`,
        [adminId, request.fee_id, request.student_id]
      );
    }

    await logAuditAction(
      schoolId,
      adminId,
      status === 'approved' ? 'FEE_PAYMENT_APPROVED' : 'FEE_PAYMENT_REJECTED',
      'FEE_PAYMENT_REQUEST',
      requestId,
      { student_id: request.student_id, fee_id: request.fee_id, remarks }
    );

    await client.query('COMMIT');

    const io = req.app.get('socketio');
    await del(`student:dashboard:${request.student_id}`);
    if (io) io.to(`user_${request.student_id}`).emit('dashboardDataUpdate', { type: 'fee_status_change' });

    const teacher = await pool.query(
      `SELECT u.id FROM users u
       JOIN fees f ON f.class_id = u.class_id
       WHERE f.id = $1 AND u.role = 'teacher' AND u.school_id = $2
       LIMIT 1`,
      [request.fee_id, schoolId]
    );

    // Send notifications to the student and assigned teacher.
    await createNotification(
      request.student_id,
      status === 'approved' ? 'Fee Payment Approved' : 'Fee Payment Rejected',
      status === 'approved'
        ? `Congratulations! Your fee payment for ${request.month || 'fee'} has been verified and approved. [requestId:${requestId}]`
        : `Your fee payment request was rejected. ${remarks ? `Reason: ${remarks}` : 'Please re-verify your receipt and submit again.'} [requestId:${requestId}]`,
      status === 'approved' ? 'fee_payment_approved' : 'fee_payment_rejected',
      adminId,
      io
    );
    if (teacher.rows[0]) {
      await createNotification(
        teacher.rows[0].id,
        status === 'approved' ? 'Fee Payment Approved' : 'Fee Payment Rejected',
        `Fee payment for ${request.student_name} (${request.month || 'fee'}) was ${status}. [requestId:${requestId}]`,
        status === 'approved' ? 'fee_payment_approved' : 'fee_payment_rejected',
        requestId,
        io
      );
    }

    return res.json({ success: true, message: `Payment request marked as ${status}`, request: rows[0] });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('Review Fee Payment Request Error:', e);
    return res.status(500).json({ success: false, message: 'Failed to update request' });
  } finally {
    client.release();
  }
}

// @desc    Download Fee Receipt / Chalan PDF
const downloadFeeReceipt = async (req, res) => {
  const { requestId } = req.params;
  const userId = req.user.id;
  const userRole = req.user.role;
  const schoolId = req.user.school_id;

  try {
    const reqRes = await pool.query(
      `SELECT r.*, 
              u.name AS student_name, u.email AS student_email,
              c.name AS class_name, c.section,
              s.name AS school_name, s.logo_url AS school_logo_url,
              f.amount AS fee_amount, f.due_date AS fee_due_date, f.status AS fee_status
       FROM fee_payment_requests r
       JOIN users u ON u.id = r.student_id
       LEFT JOIN classes c ON c.id = u.class_id
       LEFT JOIN schools s ON s.id = u.school_id
       LEFT JOIN fees f ON f.id = r.fee_id
       WHERE r.id = $1 AND u.school_id = $2`,
      [requestId, schoolId]
    );

    if (!reqRes.rows.length) {
      return res.status(404).json({ success: false, message: 'Payment record not found' });
    }

    const payment = reqRes.rows[0];

    // Security check: Student can ONLY download their own receipts
    if (userRole === 'student' && payment.student_id !== userId) {
      return res.status(403).json({ success: false, message: 'Unauthorized: Cannot access another student receipt' });
    }

    // Do NOT allow downloading receipt if not yet approved
    if (payment.status !== 'approved') {
      return res.status(400).json({ success: false, message: 'Receipt is only available for approved payments' });
    }

    const pdfBuffer = await generateFeeReceiptPdf({
      school: { id: schoolId, name: payment.school_name, logo_url: payment.school_logo_url },
      student: { id: payment.student_id, name: payment.student_name, email: payment.student_email, class_name: payment.class_name, section: payment.section },
      payment: { id: payment.id, month: payment.month, year: payment.year, transaction_id: payment.transaction_id, created_at: payment.created_at, status: payment.status },
      fee: { amount: payment.amount || payment.fee_amount, due_date: payment.fee_due_date, month: payment.month, year: payment.year, status: payment.fee_status }
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=fee-receipt-${payment.month || 'fee'}-${payment.id}.pdf`);
    return res.send(pdfBuffer);
  } catch (error) {
    console.error('Download Fee Receipt Error:', error);
    return res.status(500).json({ success: false, message: 'Failed to generate PDF receipt' });
  }
};

module.exports = {
  getStudentFees,
  getCurrentFee,
  getEligibleMonths,
  getClassFees,
  createTeacherFeeProposal,
  updateFeeStatus,
  editFee,
  uploadFees,
  deleteFee,
  getFeeStats,
  adminGenerateFees,
  getFeeStructure,
  saveFeeStructure,
  createFeePaymentRequest,
  listFeePaymentRequests,
  reviewFeePaymentRequest,
  sendMonthlyFeeReminders,
  downloadFeeReceipt
};
