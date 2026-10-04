const pool = require('../config/db');
const ExcelJS = require('exceljs');
const fs = require('fs');
const { parseDate } = require('./attendanceController');
const { createNotification } = require('./notificationController');
const { mapMediaFieldsList } = require('../utils/media');
const { del } = require('../services/cacheService');
const { generateFeeReceiptPdf } = require('../utils/pdfGenerator');
const { getPrivateProofSignedUrl, deletePrivateProof } = require('../utils/privateStorage');

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

const feeMonths = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// @desc    Get fees for a specific student (Student View)
const getStudentFees = async (req, res) => {
  const studentId = req.user.id;
  try {
    const { rows } = await pool.query(
      `SELECT f.*,
              latest_request.id AS payment_request_id,
              latest_request.status AS payment_request_status,
              latest_request.transaction_id,
              latest_request.payment_method
       FROM fees f
       LEFT JOIN LATERAL (
         SELECT id, status, transaction_id, payment_method
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
              latest_request.payment_method,
              latest_request.screenshot_url
       FROM fees f
       LEFT JOIN LATERAL (
         SELECT id, status, transaction_id, payment_method, screenshot_url
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
      `SELECT u.id, u.class_id,
                GREATEST(0, fs.monthly_fee + COALESCE(a.fine_amount, fs.fine_amount, 0) + COALESCE(fs.other_charges, 0)
                  + round(fs.monthly_fee * COALESCE(a.tax_percent, fs.tax_percent, 0) / 100, 2)
                  - least(COALESCE(a.discount_amount, fs.discount_amount, 0), fs.monthly_fee + COALESCE(a.fine_amount, fs.fine_amount, 0) + COALESCE(fs.other_charges, 0) + round(fs.monthly_fee * COALESCE(a.tax_percent, fs.tax_percent, 0) / 100, 2))) AS monthly_fee,
                COALESCE(a.tax_percent, fs.tax_percent, 0) AS tax_rate,
                round(fs.monthly_fee * COALESCE(a.tax_percent, fs.tax_percent, 0) / 100, 2) AS tax_amount,
                COALESCE(a.fine_amount, fs.fine_amount, 0) AS fine_amount,
                LEAST(COALESCE(a.discount_amount, fs.discount_amount, 0), fs.monthly_fee + COALESCE(a.fine_amount, fs.fine_amount, 0) + COALESCE(fs.other_charges, 0) + round(fs.monthly_fee * COALESCE(a.tax_percent, fs.tax_percent, 0) / 100, 2)) AS discount_amount
         FROM users u
         LEFT JOIN fee_structures fs ON fs.class_id = u.class_id AND fs.school_id = u.school_id
         LEFT JOIN student_fee_adjustments a ON a.school_id = u.school_id AND a.student_id = u.id
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
        tax_rate: studentInfo?.tax_rate || 0,
        tax_amount: studentInfo?.tax_amount || 0,
        fine_amount: studentInfo?.fine_amount || 0,
        discount_amount: studentInfo?.discount_amount || 0,
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
              , latest_request.payment_method
       FROM fees f
       LEFT JOIN LATERAL (
         SELECT id, status, transaction_id, payment_method
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
              latest_request.transaction_id, latest_request.payment_method,
             latest_request.screenshot_url,
             latest_request.remarks AS payment_request_remarks
      FROM fees f
      JOIN users u ON f.student_id = u.id AND u.school_id = f.school_id AND u.role = 'student'
      LEFT JOIN classes c ON u.class_id = c.id AND c.school_id = u.school_id
      LEFT JOIN LATERAL (
        SELECT id, status, transaction_id, payment_method, screenshot_url, remarks
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

  const normalizedMonth = feeMonths.find((item) => item.toLowerCase() === String(month || '').trim().toLowerCase());
  const numericYear = Number(year);
  const validDueDate = !due_date || (typeof due_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(due_date) && !Number.isNaN(Date.parse(`${due_date}T00:00:00Z`)));
  const amount = proposedAmount === '' || proposedAmount == null ? null : Number(proposedAmount);
  if (!normalizedMonth || !Number.isInteger(numericYear) || numericYear < 2000 || numericYear > 2200 || !validDueDate || (amount !== null && (!Number.isFinite(amount) || amount <= 0))) {
    return res.status(400).json({ success: false, message: 'Month and year are required' });
  }

  const classId = await getTeacherClassId(teacherId, schoolId);
  if (!classId) return res.status(403).json({ success: false, message: 'Teacher is not assigned to a class' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `INSERT INTO fee_proposals (school_id, teacher_id, class_id, month, year, due_date, proposed_amount)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [schoolId, teacherId, classId, normalizedMonth, numericYear, due_date || null, amount]
    );
    await client.query('COMMIT');
    await logAuditAction(schoolId, teacherId, 'FEE_PROPOSAL_SUBMITTED', 'FEE_PROPOSAL', result.rows[0].id, { class_id: classId, month: normalizedMonth, year: numericYear });
    return res.status(201).json({ success: true, message: 'Fee proposal submitted for admin approval', proposal: result.rows[0] });
  } catch (error) {
    await client.query('ROLLBACK');
    if (error.code === '23505') return res.status(409).json({ success: false, message: 'A proposal for this class and month is already awaiting review' });
    console.error('Create Teacher Fee Proposal Error:', error);
    return res.status(500).json({ success: false, message: 'Failed to create fee proposal' });
  } finally {
    client.release();
  }
};

const listFeeProposals = async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT p.*, t.name AS teacher_name, c.name AS class_name, c.grade_level, c.section,
              fs.monthly_fee + COALESCE(fs.fine_amount, 0) + COALESCE(fs.other_charges, 0) AS configured_amount
       FROM fee_proposals p
       JOIN users t ON t.id = p.teacher_id AND t.school_id = p.school_id
       JOIN classes c ON c.id = p.class_id AND c.school_id = p.school_id
       LEFT JOIN fee_structures fs ON fs.school_id = p.school_id AND fs.class_id = p.class_id
       WHERE p.school_id = $1 AND p.status = 'pending'
       ORDER BY p.created_at ASC`, [req.user.school_id]
    );
    return res.json({ success: true, proposals: rows });
  } catch (error) {
    console.error('List Fee Proposals Error:', error);
    return res.status(500).json({ success: false, message: 'Failed to load fee proposals' });
  }
};

const reviewFeeProposal = async (req, res) => {
  const { proposalId } = req.params;
  const { status, approved_amount: submittedAmount, remarks } = req.body;
  if (!['approved', 'rejected'].includes(status)) return res.status(400).json({ success: false, message: 'Choose approve or reject' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const selected = await client.query(
      `SELECT p.*, fs.monthly_fee, COALESCE(fs.fine_amount, 0) AS fine_amount,
              COALESCE(fs.other_charges, 0) AS other_charges
       FROM fee_proposals p LEFT JOIN fee_structures fs ON fs.school_id = p.school_id AND fs.class_id = p.class_id
       WHERE p.id = $1 AND p.school_id = $2 FOR UPDATE OF p`, [proposalId, req.user.school_id]
    );
    if (!selected.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ success: false, message: 'Proposal not found' }); }
    const proposal = selected.rows[0];
    if (proposal.status !== 'pending') { await client.query('ROLLBACK'); return res.status(409).json({ success: false, message: 'Proposal has already been reviewed' }); }
    let createdCount = 0;
    let approvedAmount = null;
    if (status === 'approved') {
      approvedAmount = submittedAmount === '' || submittedAmount == null
        ? (proposal.proposed_amount == null ? Number(proposal.monthly_fee) + Number(proposal.fine_amount) + Number(proposal.other_charges) : Number(proposal.proposed_amount))
        : Number(submittedAmount);
      if (!Number.isFinite(approvedAmount) || approvedAmount <= 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ success: false, message: 'Enter a valid approved amount greater than zero' });
      }
      const dueDate = proposal.due_date || new Date(proposal.year, feeMonths.indexOf(proposal.month), 10);
      const inserted = await client.query(
        `INSERT INTO fees (school_id, student_id, class_id, month, year, amount, fine_amount, other_charges, status, due_date, updated_by)
         SELECT $1, u.id, u.class_id, $2, $3, $4, $5, $6, 'unpaid', $7, $8
         FROM users u WHERE u.school_id = $1 AND u.class_id = $9 AND u.role = 'student'
         ON CONFLICT (student_id, month, year) DO NOTHING`,
        [req.user.school_id, proposal.month, proposal.year, approvedAmount, proposal.fine_amount, proposal.other_charges, dueDate, req.user.id, proposal.class_id]
      );
      createdCount = inserted.rowCount;
    }
    const updated = await client.query(
      `UPDATE fee_proposals SET status = $1, approved_amount = $2, reviewed_by = $3,
       reviewed_at = CURRENT_TIMESTAMP, review_remarks = $4 WHERE id = $5 RETURNING *`,
      [status, approvedAmount, req.user.id, typeof remarks === 'string' ? remarks.trim() || null : null, proposalId]
    );
    await client.query('COMMIT');
    await logAuditAction(req.user.school_id, req.user.id, `FEE_PROPOSAL_${status.toUpperCase()}`, 'FEE_PROPOSAL', proposalId, { created_count: createdCount, approved_amount: approvedAmount });
    try {
      await createNotification(
        proposal.teacher_id,
        status === 'approved' ? 'Fee Proposal Approved' : 'Fee Proposal Rejected',
        status === 'approved'
          ? `${proposal.month} ${proposal.year} proposal approved. ${createdCount} student invoices were created.`
          : `${proposal.month} ${proposal.year} fee proposal was rejected.${remarks ? ` Admin note: ${String(remarks).trim()}` : ''}`,
        status === 'approved' ? 'fee_proposal_approved' : 'fee_proposal_rejected',
        req.user.id,
        req.app.get('socketio')
      );
    } catch (notificationError) {
      console.warn('Fee proposal notification failed:', notificationError.message);
    }
    return res.json({ success: true, message: status === 'approved' ? `Proposal approved; ${createdCount} invoices created` : 'Proposal rejected', proposal: updated.rows[0], createdCount });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Review Fee Proposal Error:', error);
    return res.status(500).json({ success: false, message: 'Failed to review fee proposal' });
  } finally { client.release(); }
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

// Teachers can report a cash payment, but only an admin can confirm it.
const createTeacherCashStatusRequest = async (req, res) => {
  const teacherId = req.user.id;
  const schoolId = req.user.school_id;
  const { fee_id: feeId, remarks } = req.body;
  const classId = await getTeacherClassId(teacherId, schoolId);
  if (!classId) return res.status(403).json({ success: false, message: 'Teacher is not assigned to a class' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const feeResult = await client.query(
      `SELECT f.* FROM fees f
       JOIN users u ON u.id = f.student_id
       WHERE f.id = $1 AND f.school_id = $2 AND u.class_id = $3 AND u.role = 'student'
       FOR UPDATE`, [feeId, schoolId, classId]
    );
    if (!feeResult.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Fee record not found for your class' });
    }
    const fee = feeResult.rows[0];
    if (fee.status === 'paid') {
      await client.query('ROLLBACK');
      return res.status(409).json({ success: false, message: 'This fee is already paid' });
    }
    const existing = await client.query(
      `SELECT id FROM fee_payment_requests WHERE fee_id = $1 AND status = 'pending' LIMIT 1`, [feeId]
    );
    if (existing.rowCount) {
      await client.query('ROLLBACK');
      return res.status(409).json({ success: false, message: 'A payment request is already awaiting admin review' });
    }
    const transactionId = `CASH-${feeId}-${Date.now()}-${require('crypto').randomUUID()}`;
    const request = await client.query(
      `INSERT INTO fee_payment_requests (school_id, student_id, fee_id, transaction_id, payment_method, status, remarks, month, year, amount, transaction_key)
       VALUES ($1, $2, $3, $4, 'cash', 'pending', $5, $6, $7, $8, $9) RETURNING *`,
      [schoolId, fee.student_id, feeId, transactionId, remarks?.trim() || 'Cash payment reported by class teacher', fee.month, fee.year, fee.amount, `${schoolId}:${transactionId.toLowerCase()}`]
    );
    await client.query(
      `UPDATE fees SET status = 'pending', updated_by = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 AND school_id = $3`,
      [teacherId, feeId, schoolId]
    );
    await client.query('COMMIT');
    await del(`student:dashboard:${fee.student_id}`);
    const admins = await pool.query(`SELECT id FROM users WHERE school_id = $1 AND role = 'admin'`, [schoolId]);
    const io = req.app.get('socketio');
    try {
      await Promise.all(admins.rows.map((admin) => createNotification(
        admin.id, 'Cash Fee Confirmation Requested',
        `Teacher reported cash received for ${fee.month} ${fee.year} [requestId:${request.rows[0].id}] [feeId:${feeId}]`,
        'fee_payment_request', request.rows[0].id, io
      )));
    } catch (notificationError) {
      console.warn('Cash fee request notification failed:', notificationError.message);
    }
    return res.status(201).json({ success: true, message: 'Cash payment sent to an admin for approval', request: request.rows[0] });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Teacher cash fee request error:', error);
    return res.status(500).json({ success: false, message: 'Could not send the cash payment for admin approval' });
  } finally {
    client.release();
  }
};

// @desc    Admin updates full fee record
const editFee = async (req, res) => {
  const { feeId } = req.params;
  const schoolId = req.user.school_id;
  const { month, year, amount, status, due_date, remarks } = req.body;
  const adminId = req.user.id;
  const normalizedMonth = feeMonths.find((item) => item.toLowerCase() === String(month || '').trim().toLowerCase());
  const numericYear = Number(year);
  const numericAmount = Number(amount);
  const validStatuses = ['unpaid', 'pending', 'paid', 'partial', 'overdue', 'rejected'];
  const normalizedStatus = String(status || '').trim().toLowerCase();
  const parsedDueDate = typeof due_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(due_date) ? Date.parse(`${due_date}T00:00:00Z`) : NaN;
  const validDueDate = !due_date || (!Number.isNaN(parsedDueDate) && new Date(parsedDueDate).toISOString().slice(0, 10) === due_date);

  if (!normalizedMonth || !Number.isInteger(numericYear) || numericYear < 2000 || numericYear > 2200 || !Number.isFinite(numericAmount) || numericAmount < 0 || !validStatuses.includes(normalizedStatus) || !validDueDate) {
    return res.status(400).json({ success: false, message: 'Enter a valid billing period, amount, status, and due date' });
  }

  try {
    const { rows } = await pool.query(
      `UPDATE fees 
       SET month = $1, year = $2, amount = $3, status = $4, due_date = $5, updated_by = $6, remarks = $7, updated_at = CURRENT_TIMESTAMP 
       WHERE id = $8 AND school_id = $9 RETURNING *`,
      [normalizedMonth, numericYear, numericAmount, normalizedStatus, due_date || null, adminId, typeof remarks === 'string' ? remarks.trim().slice(0, 1000) : null, feeId, schoolId]
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
  const normalizedMonth = feeMonths.find((item) => item.toLowerCase() === String(month || '').trim().toLowerCase());
  const numericYear = Number(year);
  const classId = class_id == null || class_id === '' ? null : Number(class_id);
  if (!normalizedMonth || !Number.isInteger(numericYear) || numericYear < 2000 || numericYear > 2200 || (classId !== null && (!Number.isInteger(classId) || classId < 1))) {
    return res.status(400).json({ success: false, message: 'Choose a valid month, year, and class' });
  }

  try {
    const monthIndex = feeMonths.indexOf(normalizedMonth);
    const defaultDueDate = new Date(numericYear, monthIndex, 10);
    const insertResult = await pool.query(`
      INSERT INTO fees (school_id, student_id, class_id, month, year, amount, fine_amount, other_charges, status, due_date, base_amount, tax_rate, tax_amount, discount_amount)
      SELECT $1, u.id, u.class_id, $2, $3,
             GREATEST(0, fs.monthly_fee + COALESCE(a.fine_amount, fs.fine_amount, 0) + COALESCE(fs.other_charges, 0)
               + round(fs.monthly_fee * COALESCE(a.tax_percent, fs.tax_percent, 0) / 100, 2)
               - LEAST(COALESCE(a.discount_amount, fs.discount_amount, 0), fs.monthly_fee + COALESCE(a.fine_amount, fs.fine_amount, 0) + COALESCE(fs.other_charges, 0)
                 + round(fs.monthly_fee * COALESCE(a.tax_percent, fs.tax_percent, 0) / 100, 2))),
             COALESCE(a.fine_amount, fs.fine_amount, 0), COALESCE(fs.other_charges, 0), 'unpaid', $5,
             fs.monthly_fee, COALESCE(a.tax_percent, fs.tax_percent, 0),
             round(fs.monthly_fee * COALESCE(a.tax_percent, fs.tax_percent, 0) / 100, 2),
             LEAST(COALESCE(a.discount_amount, fs.discount_amount, 0), fs.monthly_fee + COALESCE(a.fine_amount, fs.fine_amount, 0) + COALESCE(fs.other_charges, 0) + round(fs.monthly_fee * COALESCE(a.tax_percent, fs.tax_percent, 0) / 100, 2))
      FROM users u
      JOIN fee_structures fs ON fs.school_id = u.school_id AND fs.class_id = u.class_id
      LEFT JOIN student_fee_adjustments a ON a.school_id = u.school_id AND a.student_id = u.id
      WHERE u.school_id = $1 AND u.role = 'student'
        AND ($4::integer IS NULL OR u.class_id = $4)
      ON CONFLICT (student_id, month, year) DO NOTHING
    `, [schoolId, normalizedMonth, numericYear, classId, defaultDueDate]);
    const createdCount = insertResult.rowCount;

    await logAuditAction(schoolId, req.user.id, 'FEE_GENERATED', 'FEES', null, { month: normalizedMonth, year: numericYear, class_id: classId, createdCount });

    res.json({
      success: true,
      message: `Monthly fees generated successfully for ${normalizedMonth} ${numericYear} (${createdCount} records created)`
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
             fs.monthly_fee, COALESCE(fs.fine_amount, 0) AS fine_amount,
             COALESCE(fs.other_charges, 0) AS other_charges,
             COALESCE(fs.tax_percent, 0) AS tax_percent, COALESCE(fs.discount_amount, 0) AS discount_amount,
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
  const { class_id, monthly_fee, fine_amount = 0, other_charges = 0, tax_percent = 0, discount_amount = 0 } = req.body;

  const monthlyFee = Number(monthly_fee);
  const fineAmount = Number(fine_amount);
  const otherCharges = Number(other_charges);
  const taxPercent = Number(tax_percent);
  const discountAmount = Number(discount_amount);
  const classId = Number(class_id);
  if (!Number.isInteger(classId) || classId < 1 || !Number.isFinite(monthlyFee) || monthlyFee < 0 || !Number.isFinite(fineAmount) || fineAmount < 0 || !Number.isFinite(otherCharges) || otherCharges < 0 || !Number.isFinite(taxPercent) || taxPercent < 0 || taxPercent > 100 || !Number.isFinite(discountAmount) || discountAmount < 0) {
    return res.status(400).json({ success: false, message: 'Enter valid non-negative fee amounts' });
  }

  try {
    const { rows } = await pool.query(`
      INSERT INTO fee_structures (school_id, class_id, monthly_fee, fine_amount, other_charges, created_by, effective_from, tax_percent, discount_amount)
      SELECT $1, c.id, $3, $4, $5, $6, CURRENT_DATE, $7, $8 FROM classes c WHERE c.id = $2 AND c.school_id = $1
      ON CONFLICT (school_id, class_id)
      DO UPDATE SET monthly_fee = EXCLUDED.monthly_fee, fine_amount = EXCLUDED.fine_amount,
                    other_charges = EXCLUDED.other_charges, tax_percent = EXCLUDED.tax_percent,
                    discount_amount = EXCLUDED.discount_amount, effective_from = CURRENT_DATE
      RETURNING *
    `, [schoolId, classId, monthlyFee, fineAmount, otherCharges, adminId, taxPercent, discountAmount]);

    if (!rows.length) return res.status(404).json({ success: false, message: 'Class not found in this school' });

    await logAuditAction(schoolId, adminId, 'FEE_STRUCTURE_UPDATED', 'FEE_STRUCTURE', rows[0].id, { class_id, monthly_fee: monthlyFee, fine_amount: fineAmount, other_charges: otherCharges });

    res.json({ success: true, message: 'Fee structure updated successfully', structure: rows[0] });
  } catch (error) {
    console.error('Save Fee Structure Error:', error);
    res.status(500).json({ success: false, message: 'Failed to save fee structure' });
  }
};

const saveStudentFeeAdjustment = async (req, res) => {
  const schoolId = req.user.school_id;
  const studentId = Number(req.body.student_id);
  const toOptionalAmount = (value) => value === '' || value === null || value === undefined ? null : Number(value);
  const fineAmount = toOptionalAmount(req.body.fine_amount);
  const taxPercent = toOptionalAmount(req.body.tax_percent);
  const discountAmount = toOptionalAmount(req.body.discount_amount);
  if (!Number.isInteger(studentId) || studentId < 1 ||
      (fineAmount !== null && (!Number.isFinite(fineAmount) || fineAmount < 0)) ||
      (taxPercent !== null && (!Number.isFinite(taxPercent) || taxPercent < 0 || taxPercent > 100)) ||
      (discountAmount !== null && (!Number.isFinite(discountAmount) || discountAmount < 0))) {
    return res.status(400).json({ success: false, message: 'Choose a student and enter valid adjustment values' });
  }
  try {
    const student = await pool.query("SELECT id FROM users WHERE id = $1 AND school_id = $2 AND role = 'student'", [studentId, schoolId]);
    if (!student.rowCount) return res.status(404).json({ success: false, message: 'Student not found in this school' });
    if (fineAmount === null && taxPercent === null && discountAmount === null) {
      await pool.query('DELETE FROM student_fee_adjustments WHERE school_id = $1 AND student_id = $2', [schoolId, studentId]);
      return res.json({ success: true, message: 'Student adjustments reset to class defaults' });
    }
    const { rows } = await pool.query(
      `INSERT INTO student_fee_adjustments (school_id, student_id, fine_amount, tax_percent, discount_amount, remarks, updated_by, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP)
       ON CONFLICT (school_id, student_id) DO UPDATE SET fine_amount = EXCLUDED.fine_amount,
         tax_percent = EXCLUDED.tax_percent, discount_amount = EXCLUDED.discount_amount,
         remarks = EXCLUDED.remarks, updated_by = EXCLUDED.updated_by, updated_at = CURRENT_TIMESTAMP
       RETURNING *`,
      [schoolId, studentId, fineAmount, taxPercent, discountAmount, String(req.body.remarks || '').trim() || null, req.user.id]
    );
    await logAuditAction(schoolId, req.user.id, 'STUDENT_FEE_ADJUSTMENT_UPDATED', 'STUDENT_FEE_ADJUSTMENT', rows[0].id, { student_id: studentId });
    return res.json({ success: true, message: 'Student fee adjustments saved', adjustment: rows[0] });
  } catch (error) {
    console.error('Save Student Fee Adjustment Error:', error);
    return res.status(500).json({ success: false, message: 'Could not save student fee adjustments' });
  }
};

const getStudentFeeAdjustment = async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT a.* FROM student_fee_adjustments a JOIN users u ON u.id = a.student_id AND u.school_id = a.school_id
       WHERE a.school_id = $1 AND a.student_id = $2 AND u.role = 'student'`, [req.user.school_id, req.params.studentId]
    );
    return res.json({ success: true, adjustment: rows[0] || null });
  } catch (error) {
    console.error('Get Student Fee Adjustment Error:', error);
    return res.status(500).json({ success: false, message: 'Could not load student fee adjustments' });
  }
};

const listFeeStudents = async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT u.id, u.student_code, u.name, u.class_id, c.name AS class_name, c.section
       FROM users u LEFT JOIN classes c ON c.id = u.class_id AND c.school_id = u.school_id
       WHERE u.school_id = $1 AND u.role = 'student' ORDER BY u.name`, [req.user.school_id]
    );
    return res.json({ success: true, students: rows });
  } catch (error) {
    console.error('List Fee Students Error:', error);
    return res.status(500).json({ success: false, message: 'Could not load student list' });
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
    await deletePrivateProof(file?.path).catch(() => {});
    return res.status(400).json({ success: false, message: 'Transaction ID is required' });
  }

  if (!file) {
    return res.status(400).json({ success: false, message: 'Payment screenshot is required' });
  }

  if (!fee_id) {
    await deletePrivateProof(file.path).catch(() => {});
    return res.status(400).json({ success: false, message: 'Select a monthly fee record before submitting payment' });
  }

  const client = await pool.connect();
  let committed = false;
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
      await deletePrivateProof(file.path).catch(() => {});
      return res.status(403).json({ success: false, message: 'Invalid fee record selected' });
    }

    const feeRecord = feeRes.rows[0];
    if (feeRecord.status === 'paid' || feeRecord.has_approved_request) {
      await client.query('ROLLBACK');
      await deletePrivateProof(file.path).catch(() => {});
      return res.status(400).json({ success: false, message: 'This month is already marked as PAID' });
    }
    if (feeRecord.has_pending_request) {
      await client.query('ROLLBACK');
      await deletePrivateProof(file.path).catch(() => {});
      return res.status(409).json({ success: false, message: 'A payment verification request is already pending review for this month' });
    }

    const targetMonth = feeRecord.month;
    const targetYear = feeRecord.year;
    const targetAmount = feeRecord.amount;

    const normalizedTransaction = transaction_id.trim().toLowerCase();
    const duplicateTransaction = await client.query(
      'SELECT id FROM fee_payment_requests WHERE school_id = $1 AND lower(trim(transaction_id)) = $2 LIMIT 1',
      [schoolId, normalizedTransaction]
    );
    if (duplicateTransaction.rowCount) {
      await client.query('ROLLBACK');
      await deletePrivateProof(file.path).catch(() => {});
      return res.status(409).json({ success: false, message: 'This transaction ID has already been submitted for this school' });
    }

    const screenshotUrl = file.path;

    const { rows } = await client.query(
      `INSERT INTO fee_payment_requests 
       (school_id, student_id, fee_id, transaction_id, screenshot_url, status, month, year, amount, transaction_key)
       VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7, $8, $9)
       RETURNING *`,
      [schoolId, studentId, fee_id ? Number(fee_id) : null, transaction_id.trim(), screenshotUrl, targetMonth, targetYear, targetAmount, `${schoolId}:${normalizedTransaction}`]
    );

    // Update fee status to 'pending'
    await client.query(
      `UPDATE fees SET status = 'pending', updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND student_id = $2 AND school_id = $3`,
      [fee_id, studentId, schoolId]
    );
    await client.query('COMMIT');
    committed = true;

    try {
      await del(`student:dashboard:${studentId}`);
      const recipients = await pool.query(
        `SELECT id FROM users
         WHERE school_id = $1 AND role = 'admin'
         UNION
         SELECT u.id
         FROM users u
         JOIN fees f ON f.class_id = u.class_id AND f.id = $2 AND f.school_id = u.school_id
         WHERE u.role = 'teacher' AND u.school_id = $1`,
        [schoolId, fee_id]
      );
      const io = req.app.get('socketio');
      await Promise.all(recipients.rows.map((recipient) => createNotification(
        recipient.id,
        'New Fee Payment Submitted',
        `Student submitted payment for ${targetMonth} ${targetYear} [requestId:${rows[0].id}] [feeId:${fee_id}] [tx:${transaction_id.trim()}]`,
        'fee_payment_request', rows[0].id, io
      )));
    } catch (notificationError) {
      console.warn('Fee payment request notification failed:', notificationError.message);
    }

    return res.status(201).json({
      success: true,
      message: 'Payment verification request submitted successfully',
      request: rows[0]
    });
  } catch (error) {
    await client.query('ROLLBACK');
    if (!committed) await deletePrivateProof(file.path).catch(() => {});
    if (error.code === '23505') {
      return res.status(409).json({ success: false, message: 'This transaction ID was already used, or this fee already has a pending request' });
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
              u.student_code,
              u.email AS student_email,
              c.name AS class_name,
              f.month AS fee_month,
              f.year AS fee_year,
              f.amount AS fee_amount
       FROM fee_payment_requests r
       JOIN users u ON u.id = r.student_id
       LEFT JOIN classes c ON c.id = u.class_id AND c.school_id = u.school_id
       LEFT JOIN fees f ON f.id = r.fee_id
       WHERE u.school_id = $1 AND COALESCE(r.school_id, u.school_id) = $1
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

async function getFeePaymentProofUrl(req, res) {
  const requestId = Number(req.params.requestId);
  const schoolId = req.user.school_id;
  if (!Number.isInteger(requestId) || requestId < 1) {
    return res.status(400).json({ success: false, message: 'Invalid payment request id' });
  }

  try {
    const teacherClassId = req.user.role === 'teacher' ? await getTeacherClassId(req.user.id, schoolId) : null;
    if (req.user.role === 'teacher' && !teacherClassId) {
      return res.status(403).json({ success: false, message: 'Teacher is not assigned to a class' });
    }

    const { rows } = await pool.query(
      `SELECT r.screenshot_url, u.class_id
       FROM fee_payment_requests r
       JOIN users u ON u.id = r.student_id AND u.role = 'student'
       WHERE r.id = $1 AND u.school_id = $2 AND COALESCE(r.school_id, u.school_id) = $2
         AND ($3::integer IS NULL OR u.class_id = $3)
       LIMIT 1`,
      [requestId, schoolId, teacherClassId]
    );
    if (!rows.length || !rows[0].screenshot_url) {
      return res.status(404).json({ success: false, message: 'Payment proof not found' });
    }

    const reference = rows[0].screenshot_url;
    if (!reference.startsWith('private-storage://') && !reference.startsWith('private-local://')) {
      if (!/^https:\/\//i.test(reference)) {
        return res.status(404).json({ success: false, message: 'Payment proof is unavailable' });
      }
      return res.json({ success: true, url: reference, expires_in: null, legacy: true });
    }

    const url = await getPrivateProofSignedUrl(reference, 300);
    return res.json({ success: true, url, expires_in: reference.startsWith('private-local://') ? null : 300, legacy: false });
  } catch (error) {
    console.error('Get fee proof URL error:', error);
    return res.status(500).json({ success: false, message: 'Could not access payment proof' });
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
              u.name AS student_name, u.student_code, u.email AS student_email,
              c.name AS class_name, c.section,
              s.name AS school_name, s.logo_url AS school_logo_url,
              f.amount AS fee_amount, f.base_amount AS fee_base_amount, f.fine_amount AS fee_fine_amount,
              f.other_charges AS fee_other_charges, f.tax_rate AS fee_tax_rate, f.tax_amount AS fee_tax_amount,
              f.discount_amount AS fee_discount_amount, f.due_date AS fee_due_date, f.status AS fee_status
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
      student: { id: payment.student_id, student_code: payment.student_code, name: payment.student_name, email: payment.student_email, class_name: payment.class_name, section: payment.section },
      payment: { id: payment.id, month: payment.month, year: payment.year, transaction_id: payment.transaction_id, payment_method: payment.payment_method, created_at: payment.created_at, status: payment.status },
      fee: { amount: payment.amount || payment.fee_amount, base_amount: payment.fee_base_amount, fine_amount: payment.fee_fine_amount, other_charges: payment.fee_other_charges, tax_rate: payment.fee_tax_rate, tax_amount: payment.fee_tax_amount, discount_amount: payment.fee_discount_amount, due_date: payment.fee_due_date, month: payment.month, year: payment.year, status: payment.fee_status }
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
  listFeeProposals,
  reviewFeeProposal,
  createTeacherCashStatusRequest,
  updateFeeStatus,
  editFee,
  uploadFees,
  deleteFee,
  getFeeStats,
  adminGenerateFees,
  getFeeStructure,
  saveFeeStructure,
  saveStudentFeeAdjustment,
  getStudentFeeAdjustment,
  listFeeStudents,
  createFeePaymentRequest,
  listFeePaymentRequests,
  getFeePaymentProofUrl,
  reviewFeePaymentRequest,
  sendMonthlyFeeReminders,
  downloadFeeReceipt
};
