const pool = require('../config/db');
const { normalizeStoredMediaPath } = require('../utils/media');
const { withCache } = require('../services/cacheService');

// Get Student Dashboard - Only own data
const getDashboard = async (req, res) => {
  const studentId = req.user.id;

  try {
    const payload = await withCache(`student:dashboard:${studentId}`, async () => {
      const studentQuery = await pool.query(`
        SELECT u.id, u.name, u.email, u.class_id, u.bio, u.profile_image,
               c.name as student_class_name,
               s.name as school_name, s.logo_url as school_logo_url,
               t.id as teacher_id, t.name as teacher_name, t.profile_image as teacher_image, t.bio as teacher_bio, t.online as teacher_online, t.last_seen as teacher_last_seen,
               tc.name as teacher_class_name
        FROM users u
        LEFT JOIN classes c ON u.class_id = c.id
        LEFT JOIN schools s ON u.school_id = s.id
        LEFT JOIN users t ON u.teacher_id = t.id
        LEFT JOIN classes tc ON t.class_id = tc.id
        WHERE u.id = $1 AND u.role = 'student'
      `, [studentId]);

      if (studentQuery.rows.length === 0) {
        return { statusCode: 404, body: { success: false, message: 'Student not found' } };
      }

      const student = studentQuery.rows[0];
      const attendanceQuery = await pool.query(`
        SELECT id, date, status 
        FROM attendance 
        WHERE student_id = $1 
        ORDER BY date DESC 
        LIMIT 30
      `, [studentId]);
      const resultsQuery = await pool.query(`
        SELECT id, subject, marks, created_at 
        FROM results 
        WHERE student_id = $1 
        ORDER BY created_at DESC
      `, [studentId]);
      const announcementsQuery = await pool.query(`
        SELECT title, description, date 
        FROM announcements 
        WHERE target_role IN ('all', 'student') 
        ORDER BY date DESC 
        LIMIT 10
      `);

      const feesQuery = await pool.query(`
        SELECT * FROM fees 
        WHERE student_id = $1 
        ORDER BY year DESC, month DESC 
        LIMIT 12
      `, [studentId]);

      const homeworkQuery = await pool.query(`
        SELECT h.*, u.name as teacher_name 
        FROM homework h 
        JOIN users u ON u.id = h.teacher_id 
        WHERE h.class_id = $1 AND COALESCE(h.expires_at, NOW()) >= NOW()
        ORDER BY h.assigned_date DESC LIMIT 15
      `, [student.class_id]);

      const examsQuery = await pool.query(`
        SELECT e.*, er.completed_at, er.score
        FROM exams e
        LEFT JOIN exam_results er ON er.exam_id = e.id AND er.student_id = $1
        WHERE e.class_id = $2
        ORDER BY e.created_at DESC
      `, [studentId, student.class_id]);

      const totalAttendance = attendanceQuery.rows.length;
      const presentDays = attendanceQuery.rows.filter(a => a.status === 'present' || a.status === 'late').length;
      const attendancePercentage = totalAttendance > 0 ? Math.round((presentDays / totalAttendance) * 100) : 0;

      // Real-time Academic Standing: Combine Regular Results + Online AI Exams
      const totalResultsCount = resultsQuery.rows.length;
      const totalResultsSum = resultsQuery.rows.reduce((acc, curr) => acc + Number(curr.marks), 0);
      
      const completedExams = examsQuery.rows.filter(e => e.completed_at);
      const totalExamsCount = completedExams.length;
      const totalExamsSum = completedExams.reduce((acc, curr) => acc + Number(curr.score), 0);

      const grandTotalCount = totalResultsCount + totalExamsCount;
      const averageMarks = grandTotalCount > 0
        ? Math.round((totalResultsSum + totalExamsSum) / grandTotalCount)
        : 0;

      return {
        statusCode: 200,
        body: {
          success: true,
          dashboard: {
            student: {
              id: student.id,
              name: student.name,
              email: student.email,
              class_name: student.student_class_name || "Not Assigned",
              school_name: student.school_name,
              school_logo_url: normalizeStoredMediaPath(student.school_logo_url),
              bio: student.bio,
              profile_image: normalizeStoredMediaPath(student.profile_image),
              performance: attendancePercentage,
              present_days: presentDays,
              total_days: totalAttendance,
              avg_marks: averageMarks
            },
            teacher: student.teacher_id ? {
              id: student.teacher_id,
              name: student.teacher_name,
              profile_image: normalizeStoredMediaPath(student.teacher_image),
              bio: student.teacher_bio,
              class_name: student.teacher_class_name,
              online: student.teacher_online,
              last_seen: student.teacher_last_seen
            } : null,
            attendance: attendanceQuery.rows,
            results: resultsQuery.rows,
            announcements: announcementsQuery.rows,
            homework: homeworkQuery.rows,
            fees: feesQuery.rows,
            exams: examsQuery.rows
          }
        }
      };
    }, 60);

    res.status(payload.statusCode).json(payload.body);
  } catch (error) {
    console.error("Student Dashboard Error:", error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error loading dashboard' 
    });
  }
};

// Get Own Attendance Only
const getMyAttendance = async (req, res) => {
  const studentId = req.user.id;

  try {
    const { rows } = await pool.query(`
      SELECT a.date, a.status, c.name as class_name
      FROM attendance a
      LEFT JOIN classes c ON a.class_id = c.id
      WHERE a.student_id = $1 
      ORDER BY a.date DESC
    `, [studentId]);

    res.json({ success: true, attendance: rows });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// Get Own Results Only
const getMyResults = async (req, res) => {
  const studentId = req.user.id;

  try {
    const { rows } = await pool.query(`
      SELECT subject, marks, created_at 
      FROM results 
      WHERE student_id = $1 
      ORDER BY created_at DESC
    `, [studentId]);

    res.json({ success: true, results: rows });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

module.exports = {
  getDashboard,
  getMyAttendance,
  getMyResults
};
