const pool = require('../config/db');
const bcrypt = require('bcryptjs');
const { createNotification } = require('./notificationController');
const { mapMediaFields, mapMediaFieldsList } = require('../utils/media');
const { del, withCache } = require('../services/cacheService');

const getAdminDashboardCacheKey = ({ schoolId, classId, page, limit, search }) =>
  `admin:dashboard:${schoolId}:${classId || 'all'}:${page}:${limit}:${search || 'all'}`;

const getTeacherIdForClass = async (client, classId) => {
  if (!classId) return null;
  // Note: in a full multi-tenant app, you'd add school_id check here too
  const { rows } = await client.query(
    'SELECT teacher_id FROM classes WHERE id = $1',
    [classId]
  );
  return rows[0]?.teacher_id || null;
};

const syncClassAssignments = async (client, role, classId, userId) => {
  if (!classId || isNaN(parseInt(classId))) return;

  if (role === 'teacher') {
    // If another teacher was assigned to this class, clear their assignment in users table
    await client.query(
      "UPDATE users SET class_id = NULL WHERE class_id = $1 AND role = 'teacher' AND id != $2",
      [classId, userId]
    );

    await client.query(
      'UPDATE classes SET teacher_id = $1 WHERE id = $2',
      [userId, classId]
    );

    await client.query(
      `UPDATE users
       SET teacher_id = $1
       WHERE role = 'student' AND class_id = $2`,
      [userId, classId]
    );
  }

  if (role === 'student') {
    const teacherId = await getTeacherIdForClass(client, classId);
    await client.query(
      'UPDATE users SET teacher_id = $1 WHERE id = $2',
      [teacherId, userId]
    );
  }
};

const userExists = async (email, excludeId = null) => {
  const query = excludeId
    ? 'SELECT id FROM users WHERE email = $1 AND id <> $2'
    : 'SELECT id FROM users WHERE email = $1';
  const values = excludeId ? [email, excludeId] : [email];
  const { rows } = await pool.query(query, values);
  return rows.length > 0;
};

const createUser = async (req, res) => {
  const { name, email, password, role, class_id, bio } = req.body;
  const profile_image = req.file ? req.file.path : null;
  const schoolId = req.user.school_id;
  if (!name || !email || !password || !role) {
    return res.status(400).json({
      success: false,
      message: 'Name, email, password and role are required',
    });
  }

  if (!['student', 'teacher'].includes(role)) {
    return res.status(400).json({
      success: false,
      message: 'Role must be student or teacher',
    });
  }

  try {
    if (await userExists(email)) {
      return res.status(409).json({
        success: false,
        message: 'Email already exists',
      });
    }

    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const hashedPassword = await bcrypt.hash(password, 10);

      const { rows } = await client.query(
        `INSERT INTO users (name, email, password, role, class_id, bio, profile_image, school_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id, name, email, role, class_id, teacher_id, bio, profile_image, online, last_seen`,
        [name, email, hashedPassword, role, class_id || null, bio || null, profile_image || null, schoolId]
      );

      await syncClassAssignments(client, role, class_id, rows[0].id);

      // Flush affected dashboard caches
      await del(`admin:dashboard:${schoolId}:*`);

      await client.query('COMMIT');

      const io = req.app.get('socketio');
      if (io) {
        io.to('admins').emit('dashboardDataUpdate');
      }

      res.status(201).json({
        success: true,
        message: `${role.charAt(0).toUpperCase() + role.slice(1)} created successfully`,
        user: rows[0],
      });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Create User Error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while creating user',
    });
  }
};

const getAllUsers = async (req, res) => {
  const schoolId = req.user.school_id;
  try {
    const { rows } = await pool.query(`
      SELECT
        u.id,
        u.name,
        u.email,
        u.role,
        u.class_id,
        u.teacher_id,
        u.bio,
        u.profile_image,
        u.created_at,
        u.online,
        u.last_seen,
        c.name AS class_name
      FROM users u
      LEFT JOIN classes c ON c.id = u.class_id AND c.school_id = u.school_id
      WHERE u.school_id = $1
      ORDER BY
        CASE u.role WHEN 'admin' THEN 1 WHEN 'teacher' THEN 2 ELSE 3 END,
        u.name
    `, [schoolId]);

    res.json({ success: true, users: rows });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

const updateUser = async (req, res) => {
  const { id } = req.params;
  const schoolId = req.user.school_id;
  const { name, email, role, class_id, bio, password } = req.body;
  const profile_image = req.file ? req.file.path : null;
  if (!name || !email || !role) return res.status(400).json({ success: false, message: 'Missing required fields' });
  try {
    if (await userExists(email, id)) {
      return res.status(409).json({ success: false, message: 'Email already exists' });
    }

    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const currentUserRes = await client.query(
        'SELECT id, role, class_id FROM users WHERE id = $1 AND school_id = $2',
        [id, schoolId]
      );

      if (!currentUserRes.rows.length) {
        await client.query('ROLLBACK');
        return res.status(404).json({ success: false, message: 'User not found' });
      }

      const currentUser = currentUserRes.rows[0];

      if (currentUser.role === 'teacher' && currentUser.class_id && currentUser.class_id !== Number(class_id || 0)) {
        await client.query(
          'UPDATE classes SET teacher_id = NULL WHERE teacher_id = $1 AND id = $2',
          [id, currentUser.class_id]
        );

        // Also clear the teacher_id from students in the old class who were linked to this teacher
        await client.query(
          "UPDATE users SET teacher_id = NULL WHERE role = 'student' AND teacher_id = $1 AND class_id = $2",
          [id, currentUser.class_id]
        );
      }

      let passwordUpdate = '';
      let updateValues = [name, email, role, class_id || null, bio || null, profile_image, id, schoolId];

      if (password && password.trim() !== '') {
        const hashedPassword = await bcrypt.hash(password, 10);
        passwordUpdate = ', password = $9';
        updateValues.push(hashedPassword);
      }

      const { rows } = await client.query(
        `UPDATE users
         SET name = $1, email = $2, role = $3, class_id = $4, bio = $5, profile_image = COALESCE($6, profile_image) ${passwordUpdate}
         WHERE id = $7 AND school_id = $8
         RETURNING id, name, email, role, class_id, teacher_id, bio, profile_image, online, last_seen`,
        updateValues
      );

      await syncClassAssignments(client, role, class_id, id);
      await del(`admin:dashboard:${schoolId}:*`);
      await client.query('COMMIT');

      const io = req.app.get('socketio');
      if (io) {
        io.to('admins').emit('dashboardDataUpdate');
      }

      res.json({
        success: true,
        message: 'User updated successfully',
        user: rows[0],
      });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

const deleteUser = async (req, res) => {
  const { id } = req.params;
  const schoolId = req.user.school_id;

  try {
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const existingRes = await client.query(
        'SELECT id, role, class_id FROM users WHERE id = $1 AND school_id = $2',
        [id, schoolId]
      );

      if (!existingRes.rows.length) {
        await client.query('ROLLBACK');
        return res.status(404).json({ success: false, message: 'User not found' });
      }

      const user = existingRes.rows[0];

      if (user.role === 'teacher') {
        await client.query(
          'UPDATE classes SET teacher_id = NULL WHERE teacher_id = $1',
          [id]
        );
        await client.query(
          `UPDATE users
           SET teacher_id = NULL
           WHERE role = 'student' AND teacher_id = $1`,
          [id]
        );
      }

      const { rowCount } = await client.query('DELETE FROM users WHERE id = $1 AND school_id = $2', [id, schoolId]);

      await client.query('COMMIT');

      const io = req.app.get('socketio');
      if (io) {
        io.to('admins').emit('dashboardDataUpdate');
      }

      if (rowCount === 0) {
        return res.status(404).json({ success: false, message: 'User not found' });
      }

      res.json({ success: true, message: 'User deleted successfully' });
      await del(`admin:dashboard:${schoolId}:*`);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

const getDashboardAnalytics = async (req, res) => {
  const schoolId = req.user.school_id;
  const classId = req.query.classId ? Number(req.query.classId) : null;
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 10;
  const offset = (page - 1) * limit;
  const search = req.query.search || '';

  try {
    const cacheData = await withCache(
      getAdminDashboardCacheKey({ schoolId, classId, page, limit, search }),
      async () => {
        const schoolRes = await pool.query(
          `SELECT id, name, logo_url, subscription_plan, subscription_price, subscription_status, subscription_expires_at, subscription_paused
           FROM schools
           WHERE id = $1`,
          [schoolId]
        );

        const school = schoolRes.rows[0];
        if (!school) {
          return { statusCode: 404, body: { success: false, message: 'School not found' } };
        }

        if (school.subscription_paused || school.subscription_status !== 'active') {
          const message = school.subscription_paused
            ? 'Your activity is paused by the software owner. Please wait.'
            : 'Subscription inactive. Please contact support to reactivate.';
          return {
            statusCode: 403,
            body: {
              success: false,
              message,
              school: mapMediaFields(school, ['logo_url']),
            },
          };
        }

        const filters = [];
        const values = [];
        
        // Security: Parameterized values start at $2 because $1 is reserved for schoolId
        let paramIdx = 2;
        
        if (search) {
          const searchPattern = `%${search}%`;
          values.push(searchPattern);
          filters.push(`(u.name ILIKE $${paramIdx} OR u.email ILIKE $${paramIdx} OR u.id::text ILIKE $${paramIdx})`);
          paramIdx++;
        }

        if (classId) {
          values.push(classId);
          filters.push(`u.class_id = $${paramIdx}`);
          paramIdx++;
        }

        const userFilter = filters.length ? `AND ${filters.join(' AND ')}` : '';
        const classFilter = 'WHERE c.school_id = $1';
        const attendanceFilter = 'WHERE a.school_id = $1';
        const resultsFilter = 'WHERE r.school_id = $1';
        const feeFilter = 'WHERE f.school_id = $1';

        const [
          usersResult,
          totalUsersCountRes,
          statsResult,
          classesResult,
          attendanceResult,
          resultAnalyticsResult,
          feeAnalyticsResult,
          trendAttendanceResult,
          subjectPerformanceResult,
          recentAnnouncementsResult,
        ] = await Promise.all([
          pool.query(
        `SELECT
           u.id,
           u.name,
           u.email,
           u.role,
           u.class_id,
           u.teacher_id,
           teacher.name AS teacher_name,
           u.bio,
           u.profile_image,
           u.online,
           u.last_seen,
           c.name AS class_name
         FROM users u
         LEFT JOIN classes c ON c.id = u.class_id AND c.school_id = u.school_id
         LEFT JOIN users teacher ON teacher.id = u.teacher_id AND teacher.school_id = u.school_id
         WHERE u.school_id = $1 AND u.role <> 'admin' ${userFilter}
         ORDER BY u.role, u.name
         LIMIT $${values.length + 2} OFFSET $${values.length + 3}`,
        [schoolId, ...values, limit, offset]
          ),
          pool.query(
        `SELECT COUNT(*)::int AS total FROM users u 
         WHERE u.school_id = $1 AND u.role <> 'admin' ${userFilter}`,
        [schoolId, ...values]
          ),
          pool.query(
        `SELECT
           COUNT(*) FILTER (WHERE role = 'student')::int AS total_students,
           COUNT(*) FILTER (WHERE role = 'teacher')::int AS total_teachers,
           COUNT(*) FILTER (WHERE role = 'admin')::int AS total_admins
         FROM users WHERE school_id = $1`,
        [schoolId]
          ),
          pool.query(
        `SELECT
           c.id,
           c.name,
           c.grade_level,
           c.section,
           t.name AS teacher_name,
           COUNT(u.id) FILTER (WHERE u.role = 'student')::int AS student_count
         FROM classes c
         LEFT JOIN users t ON t.id = c.teacher_id AND t.school_id = c.school_id
         LEFT JOIN users u ON u.class_id = c.id AND u.school_id = c.school_id
         ${classFilter}
         GROUP BY c.id, t.name
         ORDER BY c.grade_level, c.section`,
        [schoolId]
          ),
          pool.query(
        `SELECT
           c.id AS class_id,
           c.name AS class_name,
           COUNT(*) FILTER (WHERE a.status = 'present')::int AS present_count,
           COUNT(*) FILTER (WHERE a.status = 'late')::int AS late_count,
           COUNT(*) FILTER (WHERE a.status = 'absent')::int AS absent_count,
           COUNT(*) FILTER (WHERE a.status = 'holiday')::int AS holiday_count,
           COUNT(*)::int AS total_records,
           ROUND(
             (
               COUNT(*) FILTER (WHERE a.status IN ('present', 'late'))::numeric
               / NULLIF(COUNT(*) FILTER (WHERE a.status <> 'holiday'), 0)
             ) * 100,
             2
           )::float AS attendance_percentage
         FROM attendance a
         JOIN users u ON u.id = a.student_id
         JOIN classes c ON c.id = u.class_id
         ${attendanceFilter}
         GROUP BY c.id, c.name
         ORDER BY c.name`,
        [schoolId]
          ),
          pool.query(
        `SELECT
           c.id AS class_id,
           c.name AS class_name,
           ROUND(AVG(r.marks), 2) AS average_marks,
           COUNT(DISTINCT r.student_id)::int AS students_evaluated,
           COUNT(r.id)::int AS total_results
         FROM results r
         JOIN classes c ON c.id = r.class_id AND c.school_id = r.school_id
         WHERE r.school_id = $1
         GROUP BY c.id, c.name
         ORDER BY c.name`,
        [schoolId]
          ),
          pool.query(
        `SELECT
           c.id AS class_id,
           c.name AS class_name,
           COALESCE(SUM(f.amount), 0)::float AS total_fees,
           COALESCE(SUM(CASE WHEN f.status = 'paid' THEN f.amount ELSE 0 END), 0)::float AS paid_fees,
           COALESCE(SUM(CASE WHEN f.status <> 'paid' THEN f.amount ELSE 0 END), 0)::float AS pending_fees,
           COUNT(*) FILTER (WHERE f.status = 'paid')::int AS paid_records,
           COUNT(*) FILTER (WHERE f.status <> 'paid')::int AS pending_records
         FROM fees f
         JOIN classes c ON c.id = f.class_id AND c.school_id = f.school_id
         ${feeFilter}
         GROUP BY c.id, c.name
         ORDER BY c.name`,
        [schoolId]
          ),
          pool.query(
        `SELECT
           TO_CHAR(a.date, 'YYYY-MM-DD') AS day,
           ROUND(
             (
               COUNT(*) FILTER (WHERE a.status IN ('present', 'late'))::numeric
               / NULLIF(COUNT(*) FILTER (WHERE a.status <> 'holiday'), 0)::numeric
             ) * 100,
             2
           )::float AS attendance_percentage
         FROM attendance a
         ${attendanceFilter}
         GROUP BY a.date
         ORDER BY a.date DESC
         LIMIT 7`,
        [schoolId]
          ),
          pool.query(
        `SELECT
           r.subject,
           ROUND(AVG(r.marks), 2)::float AS average_marks
         FROM results r
         ${resultsFilter}
         GROUP BY r.subject
         ORDER BY average_marks DESC`,
        [schoolId]
          ),
          pool.query(
        `SELECT id, title, description, date
         FROM announcements
         WHERE school_id = $1
         ORDER BY date DESC, id DESC
         LIMIT 5`,
        [schoolId]
          ),
        ]);

        const totals = statsResult.rows[0];
        const announcementsCountRes = await pool.query('SELECT COUNT(*)::int AS total FROM announcements WHERE school_id = $1', [schoolId]);

        return {
          statusCode: 200,
          body: {
            success: true,
            analytics: {
              summary: {
                totalStudents: totals.total_students,
                totalTeachers: totals.total_teachers,
                totalClasses: classesResult.rows.length,
                totalAnnouncements: announcementsCountRes.rows[0].total,
              },
              users: mapMediaFieldsList(usersResult.rows, ['profile_image']),
              totalUsersCount: totalUsersCountRes.rows[0].total,
              classes: classesResult.rows,
              attendanceByClass: attendanceResult.rows,
              resultsByClass: resultAnalyticsResult.rows,
              feeByClass: feeAnalyticsResult.rows,
              attendanceTrend: trendAttendanceResult.rows.reverse(),
              subjectPerformance: subjectPerformanceResult.rows,
              recentAnnouncements: recentAnnouncementsResult.rows,
              generatedAt: new Date().toISOString(),
              selectedClassId: classId,
              school: school ? mapMediaFields(school, ['logo_url']) : null,
            },
          },
        };
      },
      90
    );

    return res.status(cacheData.statusCode).json(cacheData.body);
  } catch (error) {
    console.error('Dashboard Analytics Error:', error);
    res.status(500).json({ success: false, message: 'Failed to load dashboard analytics' });
  }
};

// Fetch specific user details for admin views and chat notifications
const getUserDetails = async (req, res) => {
  const { userId } = req.params;
  const schoolId = req.user.school_id;
  try {
    const { rows } = await pool.query(
      `SELECT u.id, u.name, u.email, u.role, u.class_id, u.teacher_id, u.bio, u.profile_image, u.online, u.last_seen, c.name as class_name 
       FROM users u 
       LEFT JOIN classes c ON c.id = u.class_id AND c.school_id = u.school_id
       WHERE u.id = $1 AND u.role <> 'admin' AND u.school_id = $2`,
      [userId, schoolId]
    );
    if (rows.length === 0) return res.status(404).json({ success: false, message: 'User not found' });
    res.json({ success: true, user: mapMediaFields(rows[0], ['profile_image']) });
  } catch (error) {
    console.error("Get User Details Error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

// Get attendance logs for a specific teacher
const getTeacherAttendance = async (req, res) => {
  const { teacherId } = req.params;
  const schoolId = req.user.school_id;
  try {
    // Assumes teacher attendance records have student_id as NULL
    const { rows } = await pool.query(
      `SELECT * FROM attendance WHERE teacher_id = $1 AND school_id = $2 AND student_id IS NULL ORDER BY date DESC`,
      [parseInt(teacherId, 10), schoolId]
    );
    res.json({ success: true, attendance: rows });
  } catch (error) {
    console.error("Get Teacher Attendance Error:", error);
    res.status(500).json({ success: false, message: "Failed to load attendance" });
  }
};

// Get salary history for a specific teacher
const getTeacherSalaries = async (req, res) => {
  const { teacherId } = req.params;
  const schoolId = req.user.school_id;
  try {
    const { rows } = await pool.query(
      `SELECT * FROM teacher_salaries 
       WHERE teacher_id = $1 AND school_id = $2 
       ORDER BY year DESC, 
       CASE month 
         WHEN 'January' THEN 1 WHEN 'February' THEN 2 WHEN 'March' THEN 3 
         WHEN 'April' THEN 4 WHEN 'May' THEN 5 WHEN 'June' THEN 6 
         WHEN 'July' THEN 7 WHEN 'August' THEN 8 WHEN 'September' THEN 9 
         WHEN 'October' THEN 10 WHEN 'November' THEN 11 WHEN 'December' THEN 12 
       END DESC`,
      [parseInt(teacherId, 10), schoolId]
    );
    res.json({ success: true, salaries: mapMediaFieldsList(rows, ['payment_screenshot']) });
  } catch (error) {
    console.error("Get Teacher Salaries Error:", error);
    res.status(500).json({ success: false, message: "Failed to load salaries" });
  }
};

// Create a manual salary record with screenshot upload
const addTeacherSalary = async (req, res) => {
  const { teacherId } = req.params;
  const schoolId = req.user.school_id;
  const { month, year, amount, status } = req.body;
  const file = req.file;

  try {
    const screenshotPath = file ? file.path : null;
    const { rows } = await pool.query(
      `INSERT INTO teacher_salaries (teacher_id, month, year, amount, status, payment_screenshot, school_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [parseInt(teacherId, 10), month, year, amount || 0, status || 'pending', screenshotPath, schoolId]
    );
    const salary = rows[0];
    const teacherNotifMessage = `A salary record has been created for ${salary.month} ${salary.year} (PKR ${salary.amount}). Please review and confirm receipt. [salaryId:${salary.id}]`;
    const io = req.app.get('socketio');
    await createNotification(teacherId, 'New salary record', teacherNotifMessage, 'salary', req.user.id, io);
    res.status(201).json({ success: true, salary: mapMediaFields(salary, ['payment_screenshot']) });
  } catch (error) {
    console.error("Add Salary Error:", error);
    res.status(500).json({ success: false, message: "Failed to create salary record" });
  }
};

// Update salary status (Approve/Revert)
const updateSalaryStatus = async (req, res) => {
  const { salaryId } = req.params;
  const schoolId = req.user.school_id;
  const { status } = req.body;
  try {
    const { rows } = await pool.query(
      `UPDATE teacher_salaries SET status = $1 WHERE id = $2 AND school_id = $3 RETURNING *`,
      [status, salaryId, schoolId]
    );
    if (rows.length === 0) return res.status(404).json({ success: false, message: "Record not found" });
    res.json({ success: true, salary: rows[0] });
  } catch (error) {
    console.error("Update Salary Status Error:", error);
    res.status(500).json({ success: false, message: "Failed to update status" });
  }
};

// Delete a teacher salary record
const deleteTeacherSalary = async (req, res) => {
  const { salaryId } = req.params;
  const schoolId = req.user.school_id;
  try {
    const { rowCount } = await pool.query('DELETE FROM teacher_salaries WHERE id = $1 AND school_id = $2', [salaryId, schoolId]);
    if (rowCount === 0) return res.status(404).json({ success: false, message: 'Salary record not found' });
    res.json({ success: true, message: 'Salary record deleted successfully' });
  } catch (error) {
    console.error("Delete Salary Error:", error);
    res.status(500).json({ success: false, message: "Failed to delete salary record" });
  }
};

const createSubscriptionRequest = async (req, res) => {
  const schoolId = req.user.school_id;
  const adminId = req.user.id;
  const { duration, price } = req.body;
  const file = req.file;

  if (!duration || !price) {
    return res.status(400).json({ success: false, message: 'Duration and price are required' });
  }

  try {
    const screenshotUrl = file ? file.path : null;
    const { rows } = await pool.query(
      `INSERT INTO subscription_requests (school_id, admin_id, duration, price, screenshot_url)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [schoolId, adminId, duration, price, screenshotUrl]
    );

    const superAdminsRes = await pool.query(`SELECT id FROM users WHERE role = 'super_admin'`);
    const io = req.app.get('socketio');

    await Promise.all(superAdminsRes.rows.map((row) =>
      createNotification(
        row.id,
        'Subscription access request',
        `School #${schoolId} requested a ${duration} subscription at PKR ${price}. [requestId:${rows[0].id}]`,
        'subscription_request',
        adminId,
        io
      )
    ));

    res.status(201).json({ success: true, request: rows[0] });
  } catch (error) {
    console.error('Create Subscription Request Error:', error);
    res.status(500).json({ success: false, message: 'Failed to submit subscription request' });
  }
};


// @desc Send push notifications for next month's fee reminder
const sendMonthlyFeeReminders = async (req, res) => {
  const schoolId = req.user.school_id;
  const { month, year } = req.body; 

  if (!month || !year) {
    return res.status(400).json({ success: false, message: 'Month and year are required' });
  }

  try {
    // Find students who haven't paid for the specified period
    const unpaidStudents = await pool.query(
      `SELECT u.id, u.name 
       FROM users u 
       LEFT JOIN fees f ON f.student_id = u.id AND f.month = $1 AND f.year = $2
       WHERE u.school_id = $3 AND u.role = 'student' 
       AND (f.id IS NULL OR f.status <> 'paid')`,
      [month, year, schoolId]
    );

    const io = req.app.get('socketio');
    const reminderTitle = `Fee Reminder: ${month} ${year}`;
    const reminderMsg = `Hello! This is a reminder that the tuition fee for ${month} ${year} is now due. Please ensure timely payment.`;

    await Promise.all(
      unpaidStudents.rows.map(student => 
        createNotification(
          student.id,
          reminderTitle,
          reminderMsg,
          'fee_reminder',
          req.user.id,
          io
        )
      )
    );

    res.json({ 
      success: true, 
      message: `Reminders sent to ${unpaidStudents.rows.length} students.` 
    });
  } catch (error) {
    console.error('Fee Reminder Error:', error);
    res.status(500).json({ success: false, message: 'Failed to send reminders' });
  }
};

module.exports = {
  createUser,
  getAllUsers,
  updateUser,
  deleteUser,
  getDashboardAnalytics,
  deleteTeacherSalary,
  getUserDetails,
  getTeacherAttendance,
  getTeacherSalaries,
  addTeacherSalary,
  updateSalaryStatus,
  createSubscriptionRequest,
  sendMonthlyFeeReminders
};
