const pool = require('../config/db');
const ExcelJS = require('exceljs');
const fs = require('fs');
const path = require('path');
const { del } = require('../services/cacheService');

// ================= DATE HELPER (VERY IMPORTANT) =================
const parseDate = (value) => {
  if (!value) return null;

  let d;
  if (typeof value === "number") {
    d = new Date(Math.round((value - 25569) * 86400 * 1000));
  } else {
    d = new Date(value);
  }
  if (isNaN(d.getTime())) return null;
  d.setHours(0, 0, 0, 0); // Normalize to midnight for consistent DB comparison
  return d;
};

// ================= FORMAT DATE DD/MM/YYYY =================
const formatDate = (date) => {
  if (!date) return "";

  const d = new Date(date);
  if (isNaN(d.getTime())) return "";

  const day = String(d.getDate()).padStart(2, "0");
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const year = d.getFullYear();

  return `${day}/${month}/${year}`;
};

// ================= BULK UPLOAD =================
const uploadAttendance = async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, message: "No Excel file uploaded" });
  }

  try {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(req.file.path);
    const worksheet = workbook.getWorksheet(1);

    const sheet = [];
    const headerRow = worksheet.getRow(1);
    const headerNames = [];
    headerRow.eachCell((cell, colNumber) => {
      headerNames[colNumber] = cell.value ? cell.value.toString().trim() : null;
    });

    worksheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return; // Skip header
      const rowData = {};
      headerNames.forEach((header, colNumber) => {
        if (header) {
          const cell = row.getCell(colNumber);
          // Normalize header name for reliable code access
          const key = header.toLowerCase().replace(/[\s_]/g, '');
          rowData[key] = cell.value;
        }
      });
      sheet.push(rowData);
    });

    if (sheet.length === 0) {
      if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
      return res.status(400).json({ success: false, message: "The uploaded file is empty." });
    }

    // --- Strict Content Validation ---
    const headers = headerNames.filter(Boolean).map(h => h.toLowerCase().replace(/[\s_]/g, ''));
    
    // Detect if this is a fee sheet instead
    const feeIndicators = ['totalfees', 'amount', 'month', 'year'];
    const isFeeSheet = feeIndicators.some(ind => headers.includes(ind)) && !headers.includes('status');
    
    if (isFeeSheet) {
      if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
      return res.status(400).json({ 
        success: false, 
        message: "Upload rejected: This appears to be a Fee Sheet. Please upload it in the Fee Management section." 
      });
    }

    // Ensure required attendance columns are present
    const hasRequired = headers.includes('studentid') && headers.includes('date') && headers.includes('status');
    if (!hasRequired) {
      if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
      return res.status(400).json({ 
        success: false, 
        message: "Invalid format. Attendance sheet must contain 'Student_id', 'Date', and 'Status' columns." 
      });
    }

    const client = await pool.connect();
    const uploaderRole = req.user.role;
    const uploaderId = req.user.id;
    const schoolId = req.user.school_id;
    let teacherClassId = null;
    let validStudentIds = null;

    if (uploaderRole === 'teacher') {
      const tRes = await client.query(
        "SELECT class_id FROM users WHERE id = $1 AND role = 'teacher' AND school_id = $2",
        [uploaderId, schoolId]
      );
      teacherClassId = tRes.rows[0]?.class_id || null;
      if (!teacherClassId) {
        if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        return res.status(403).json({ success: false, message: "You are not assigned to a class section." });
      }

      // Pre-fetch all student IDs for this class to speed up validation
      const studentsRes = await client.query(
        "SELECT id FROM users WHERE class_id = $1 AND role = 'student' AND school_id = $2",
        [teacherClassId, schoolId]
      );
      validStudentIds = new Set(studentsRes.rows.map(s => Number(s.id)));
    }

    try {
      await client.query("BEGIN");

      const invalidRows = [];

      for (const row of sheet) {
        const studentId = row.studentid || row.id;
        const providedClassId = row.classid || null;

        const date = parseDate(row.date);
        if (!studentId || !date) continue;

        // Handle case-sensitive headers (Status vs status)
        let statusRaw = row.status || "present";
        let status = String(statusRaw).toLowerCase().trim();
        if (!["present", "absent", "late", "holiday"].includes(status)) {
          status = "present";
        }

        // Teacher security: sheet can ONLY contain students of teacher's own class.
        let classId = providedClassId;
        if (uploaderRole === 'teacher') {
          if (!validStudentIds.has(Number(studentId))) {
            invalidRows.push({ studentId });
            continue;
          }
          classId = teacherClassId; // force correct class id
        }

        await client.query(
          `INSERT INTO attendance (student_id, class_id, date, status, remarks, created_by, school_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (student_id, date)
           DO UPDATE SET 
             status = EXCLUDED.status,
             remarks = EXCLUDED.remarks,
             class_id = EXCLUDED.class_id,
             school_id = EXCLUDED.school_id`,
          [
            studentId,
            classId,
            date,
            status,
            row.remarks || "",
            req.user.id,
            schoolId,
          ]
        );
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

      const io = req.app.get('socketio');
      if (io && teacherClassId) {
        io.to(`class_${teacherClassId}`).emit('dashboardDataUpdate', { type: 'attendance_bulk_updated' });
      }

      res.json({
        success: true,
        message: "Attendance uploaded successfully",
      });

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

const createManualAttendance = async (req, res) => {
  const teacherId = req.user.id;
  const schoolId = req.user.school_id;
  const { date, entries } = req.body;

  if (!date || !Array.isArray(entries) || !entries.length) {
    return res.status(400).json({ success: false, message: 'Date and attendance entries are required' });
  }

  const attendanceDate = parseDate(date);
  if (!attendanceDate) {
    return res.status(400).json({ success: false, message: 'Invalid attendance date' });
  }

  const client = await pool.connect();
  try {
    const teacherRes = await client.query(
      'SELECT class_id FROM users WHERE id = $1 AND role = $2 AND school_id = $3',
      [teacherId, 'teacher', schoolId]
    );
    const teacherClassId = teacherRes.rows[0]?.class_id;
    if (!teacherClassId) {
      return res.status(403).json({ success: false, message: 'You are not assigned to a class section.' });
    }

    const rosterRes = await client.query(
      `SELECT id, name, email
       FROM users
       WHERE class_id = $1 AND role = 'student' AND school_id = $2
       ORDER BY name`,
      [teacherClassId, schoolId]
    );
    const validStudents = new Set(rosterRes.rows.map((student) => Number(student.id)));

    await client.query('BEGIN');
    for (const entry of entries) {
      const studentId = Number(entry.student_id);
      const status = String(entry.status || '').toLowerCase().trim();
      if (!validStudents.has(studentId)) {
        await client.query('ROLLBACK');
        return res.status(400).json({ success: false, message: `Student ${entry.student_id} is not in your class section.` });
      }
      if (!['present', 'absent', 'late', 'holiday'].includes(status)) {
        await client.query('ROLLBACK');
        return res.status(400).json({ success: false, message: `Invalid status for student ${entry.student_id}.` });
      }

      await client.query(
        `INSERT INTO attendance (student_id, class_id, date, status, remarks, created_by, school_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (student_id, date)
         DO UPDATE SET
           class_id = EXCLUDED.class_id,
           status = EXCLUDED.status,
           remarks = EXCLUDED.remarks,
           created_by = EXCLUDED.created_by,
           school_id = EXCLUDED.school_id`,
        [
          studentId,
          teacherClassId,
          attendanceDate,
          status,
          String(entry.remarks || '').trim(),
          teacherId,
          schoolId,
        ]
      );

      await del(`student:dashboard:${studentId}`);
    }
    await client.query('COMMIT');

    const io = req.app.get('socketio');
    if (io) {
      io.to(`class_${teacherClassId}`).emit('dashboardDataUpdate', { type: 'attendance_manual_saved' });
      io.to(`school_${schoolId}`).emit('dashboardDataUpdate', { type: 'attendance_manual_saved' });
    }

    return res.status(201).json({
      success: true,
      message: 'Attendance saved successfully',
      roster: rosterRes.rows,
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error(error);
    return res.status(500).json({ success: false, message: 'Failed to save attendance' });
  } finally {
    client.release();
  }
};

// ================= GET ATTENDANCE (PAGINATED) =================
const getAllAttendance = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;

    let query;
    let params = [];

    if (req.user.role === "student") {
      query = `
        SELECT 
          a.id, a.student_id, a.date, a.status, a.remarks, a.created_by, a.school_id,
          u.name AS student_name,
          u.email AS student_email,
          c.id AS class_id,
          c.name AS class_name,
          c.grade_level,
          c.section
        FROM attendance a 
        JOIN users u ON u.id = a.student_id
        LEFT JOIN classes c ON c.id = u.class_id
        WHERE a.student_id = $1
        ORDER BY a.date DESC
      `;
      params = [req.user.id];
    } else if (req.user.role === "teacher") {
      const teacherClassRes = await pool.query(
        "SELECT class_id FROM users WHERE id = $1 AND role = 'teacher'",
        [req.user.id]
      );
      const teacherClassId = teacherClassRes.rows[0]?.class_id;
      if (!teacherClassId) {
        return res.json({ success: true, attendance: [], hasMore: false });
      }

      query = `
        SELECT 
          a.id, a.student_id, a.date, a.status, a.remarks, a.created_by, a.school_id,
          u.name AS student_name,
          u.email AS student_email,
          c.id AS class_id,
          c.name AS class_name,
          c.grade_level,
          c.section
        FROM attendance a
        JOIN users u ON u.id = a.student_id 
        LEFT JOIN classes c ON c.id = u.class_id
        WHERE u.class_id = $1
        ORDER BY a.date DESC
      `;
      params = [teacherClassId];
    } else {
      query = `
        SELECT 
          a.id, a.student_id, a.date, a.status, a.remarks, a.created_by, a.school_id,
          u.name AS student_name,
          u.email AS student_email,
          c.id AS class_id,
          c.name AS class_name,
          c.grade_level,
          c.section
        FROM attendance a
        JOIN users u ON u.id = a.student_id 
        LEFT JOIN classes c ON c.id = u.class_id
        ORDER BY a.date DESC
      `;
    }

    // Add pagination
    query += ` LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit + 1, offset);

    const { rows } = await pool.query(query, params);
    const hasMore = rows.length > limit;
    const attendance = hasMore ? rows.slice(0, limit) : rows;

    res.json({
      success: true,
      attendance,
      hasMore
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false });
  }
};

// ================= UPDATE ATTENDANCE =================
const editAttendance = async (req, res) => {
  const { id } = req.params;
  const { status, remarks } = req.body;

  try {
    const { rows } = await pool.query(
      `UPDATE attendance 
       SET status=$1, remarks=$2 
       WHERE id=$3 
       RETURNING *`,
      [status, remarks, id]
    );

    if (rows[0]?.student_id) {
      await del(`student:dashboard:${rows[0].student_id}`);
    }
    const io = req.app.get('socketio');
    if (io && rows[0]?.class_id) {
      io.to(`class_${rows[0].class_id}`).emit('dashboardDataUpdate', { type: 'attendance_updated', recordId: rows[0].id });
    }

    res.json({
      success: true,
      record: rows[0],
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false });
  }
};

// ================= DELETE ATTENDANCE =================
const deleteAttendance = async (req, res) => {
  const { id } = req.params;
  try {
    const deleted = await pool.query('DELETE FROM attendance WHERE id = $1 RETURNING student_id, class_id, id', [id]);
    const record = deleted.rows[0];
    if (record?.student_id) {
      await del(`student:dashboard:${record.student_id}`);
    }
    const io = req.app.get('socketio');
    if (io && record?.class_id) {
      io.to(`class_${record.class_id}`).emit('dashboardDataUpdate', { type: 'attendance_deleted', recordId: record.id });
    }
    res.json({
      success: true,
      message: "Attendance record deleted"
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false });
  }
};

// ================= ATTENDANCE SUMMARY =================
const getAttendanceSummary = async (req, res) => {
  try {
    const studentId = req.user.id;

    const { rows } = await pool.query(`
      SELECT 
        COUNT(*) FILTER (WHERE status='present') AS present,
        COUNT(*) FILTER (WHERE status='absent') AS absent,
        COUNT(*) FILTER (WHERE status='late') AS late,
        COUNT(*) AS total
      FROM attendance
      WHERE student_id=$1
    `, [studentId]);

    res.json({
      success: true,
      summary: rows[0],
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false });
  }
};

// ================= EXPORT ATTENDANCE (FIXED + COMPLETE DATA) =================
const exportAttendance = async (req, res) => {
  try {
    let result;

    if (req.user.role === 'teacher') {
      const teacherClassRes = await pool.query(
        "SELECT class_id FROM users WHERE id = $1 AND role = 'teacher'",
        [req.user.id]
      );
      const teacherClassId = teacherClassRes.rows[0]?.class_id;
      if (!teacherClassId) {
        return res.status(403).json({ success: false, message: "You are not assigned to a class section." });
      }

      result = await pool.query(
        `
          SELECT 
            u.id AS student_id,
            u.name AS student_name,
            c.id AS class_id,
            c.name AS class_name,
            c.grade_level,
            c.section,
            a.date,
            a.status,
            a.remarks
          FROM attendance a
          JOIN users u ON u.id = a.student_id 
          LEFT JOIN classes c ON c.id = u.class_id
          WHERE u.class_id = $1
          ORDER BY a.date DESC
        `,
        [teacherClassId]
      );
    } else {
      result = await pool.query(`
        SELECT 
          u.id AS student_id,
          u.name AS student_name,
          c.id AS class_id,
          c.name AS class_name,
          c.grade_level,
          c.section,
          a.date,
          a.status,
          a.remarks
        FROM attendance a
        JOIN users u ON u.id = a.student_id 
        LEFT JOIN classes c ON c.id = u.class_id
        ORDER BY a.date DESC
      `);
    }

    const rows = result.rows.map((r) => ({
      student_id: r.student_id,
      student_name: r.student_name,
      class_id: r.class_id,
      class_name: r.class_name,
      date: formatDate(r.date),   // ✅ FIXED DATE FORMAT
      status: r.status,
      remarks: r.remarks,
    }));

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet("Attendance");

    worksheet.columns = [
      { header: 'Student ID', key: 'student_id', width: 15 },
      { header: 'Student Name', key: 'student_name', width: 25 },
      { header: 'Class ID', key: 'class_id', width: 10 },
      { header: 'Class Name', key: 'class_name', width: 15 },
      { header: 'Date', key: 'date', width: 15 },
      { header: 'Status', key: 'status', width: 12 },
      { header: 'Remarks', key: 'remarks', width: 30 },
    ];

    worksheet.addRows(rows);

    const filePath = `uploads/attendance/export-${Date.now()}.xlsx`;
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    await workbook.xlsx.writeFile(filePath);

    res.download(filePath);

  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false });
  }
};

module.exports = {
  uploadAttendance,
  createManualAttendance,
  getAllAttendance,
  editAttendance,
  getAttendanceSummary,
  exportAttendance,
  deleteAttendance,
  parseDate,
};
