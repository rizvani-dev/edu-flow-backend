const pool = require('../config/db');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const { createNotification } = require('./notificationController');
const { mapMediaFieldsList } = require('../utils/media');
const { del, withCache } = require('../services/cacheService');

const getSchoolsCacheKey = ({ search = '', limit = 'all', offset = 0 }) =>
  `superadmin:schools:${search || 'all'}:${limit}:${offset}`;

const readBackupUpload = async (file) => {
  if (!file) return null;
  if (file.buffer) return file.buffer.toString('utf8');
  if (file.path) return fs.promises.readFile(file.path, 'utf8');
  return null;
};

const getBackupTableNames = (backupData) =>
  Object.keys(backupData || {}).filter((tableName) => Array.isArray(backupData[tableName]));

const buildUpsertClause = (columns) => {
  const updatableColumns = columns.filter((column) => column !== 'id');
  if (!updatableColumns.length) {
    return 'ON CONFLICT (id) DO NOTHING';
  }

  return `ON CONFLICT (id) DO UPDATE SET ${updatableColumns
    .map((column) => `"${column}" = EXCLUDED."${column}"`)
    .join(', ')}`;
};

const insertRecords = async (client, tableName, records) => {
  if (!Array.isArray(records) || records.length === 0) return;

  const columns = Object.keys(records[0]);
  const columnNames = columns.map((col) => `"${col}"`).join(', ');
  const valuePlaceholders = columns.map((_, i) => `$${i + 1}`).join(', ');
  const upsertClause = buildUpsertClause(columns);

  for (const record of records) {
    const values = columns.map((col) => record[col]);
    await client.query(
      `INSERT INTO "${tableName}" (${columnNames}) VALUES (${valuePlaceholders}) ${upsertClause};`,
      values
    );
  }
};

const syncTableSequence = async (client, tableName) => {
  const sequenceRes = await client.query(
    `SELECT pg_get_serial_sequence($1, 'id') AS sequence_name`,
    [`public.${tableName}`]
  );

  const sequenceName = sequenceRes.rows[0]?.sequence_name;
  if (!sequenceName) return;

  await client.query(
    `SELECT setval($1, COALESCE((SELECT MAX(id) FROM "${tableName}"), 0) + 1, false)`,
    [sequenceName]
  );
};

const syncBackupSequences = async (client, tableNames) => {
  for (const tableName of tableNames) {
    await syncTableSequence(client, tableName);
  }
};

const getSchoolAdmin = async (schoolId) => {
  const { rows } = await pool.query(
    `SELECT id FROM users WHERE school_id = $1 AND role = 'admin' LIMIT 1`,
    [schoolId]
  );
  return rows[0]?.id || null;
};

const getDurationEndDate = (duration) => {
  const now = new Date();
  switch (duration) {
    case '15days':
      now.setDate(now.getDate() + 15);
      break;
    case '1month':
      now.setMonth(now.getMonth() + 1);
      break;
    case '3months':
      now.setMonth(now.getMonth() + 3);
      break;
    case '6months':
      now.setMonth(now.getMonth() + 6);
      break;
    case '1year':
      now.setFullYear(now.getFullYear() + 1);
      break;
    default:
      now.setMonth(now.getMonth() + 1);
  }
  return now;
};

const createSchool = async (req, res) => {
  const { schoolName, adminName, adminEmail, adminPassword } = req.body;

  if (!schoolName || !adminName || !adminEmail || !adminPassword) {
    return res.status(400).json({ success: false, message: "All fields are required" });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Create the School
    const schoolRes = await client.query(
      'INSERT INTO schools (name) VALUES ($1) RETURNING id',
      [schoolName]
    );
    const schoolId = schoolRes.rows[0].id;

    // 2. Create the School Admin
    const hashedPassword = await bcrypt.hash(adminPassword, 10);
    const adminRes = await client.query(
      `INSERT INTO users (name, email, password, role, school_id)
       VALUES ($1, $2, $3, 'admin', $4) RETURNING id, name, email`,
      [adminName, adminEmail, hashedPassword, schoolId]
    );

    await client.query('COMMIT');
    res.status(201).json({
      success: true,
      message: "School and Admin created successfully",
      schoolId,
      admin: adminRes.rows[0]
    });
    
    // Clear all potential school list caches
    await del('superadmin:schools:*');
    await del('admin:dashboard:*'); // Pattern-like clearing for affected schools
  } catch (error) {
    await client.query('ROLLBACK');
    console.error("SuperAdmin Create School Error:", error);
    res.status(500).json({ success: false, message: "Failed to create school" });
  } finally {
    client.release();
  }
};

const getSubscriptionRequests = async (req, res) => {
  try {
    const rawLimit = Number(req.query.limit);
    const rawOffset = Number(req.query.offset);
    const status = req.query.status?.trim();
    const limit = Number.isFinite(rawLimit)
      ? Math.min(Math.max(rawLimit, 1), 200)
      : null;
    const offset = Number.isFinite(rawOffset)
      ? Math.max(rawOffset, 0)
      : 0;

    const params = [];
    const filters = [];

    if (status) {
      params.push(status);
      filters.push(`sr.status = $${params.length}`);
    }

    const whereClause = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    let paginationClause = '';
    if (limit !== null) {
      params.push(limit, offset);
      paginationClause = ` LIMIT $${params.length - 1} OFFSET $${params.length}`;
    }

    const { rows } = await pool.query(
      `SELECT sr.*, s.name AS school_name, u.name AS admin_name, u.email AS admin_email
       FROM subscription_requests sr
       JOIN schools s ON s.id = sr.school_id
       LEFT JOIN users u ON u.id = sr.admin_id
       ${whereClause}
       ORDER BY sr.created_at DESC
       ${paginationClause}`,
      params
    );
    res.json({ success: true, requests: mapMediaFieldsList(rows, ['screenshot_url']) });
  } catch (error) {
    console.error('Get Subscription Requests Error:', error);
    res.status(500).json({ success: false, message: 'Failed to load subscription requests' });
  }
};

const reviewSubscriptionRequest = async (req, res) => {
  const { requestId } = req.params;
  const { status, remarks } = req.body;

  if (!['approved', 'rejected'].includes(status)) {
    return res.status(400).json({ success: false, message: 'Invalid review action' });
  }

  try {
    const requestRes = await pool.query(
      `SELECT * FROM subscription_requests WHERE id = $1`,
      [requestId]
    );

    if (!requestRes.rows.length) {
      return res.status(404).json({ success: false, message: 'Subscription request not found' });
    }

    const request = requestRes.rows[0];
    const reviewedAt = new Date();

    // Verify the reviewer (Super Admin) exists in the users table to prevent FK violation (Error 23503)
    // This can happen if a full restore was performed and the current session ID is no longer in the DB.
    const reviewerCheck = await pool.query('SELECT id FROM users WHERE id = $1', [req.user.id]);
    const reviewerId = reviewerCheck.rows.length > 0 ? req.user.id : null;

    const { rows: updatedRequest } = await pool.query(
      `UPDATE subscription_requests
       SET status = $1, remarks = $2, reviewed_by = $3, reviewed_at = $4
       WHERE id = $5 RETURNING *`,
      [status, remarks || null, reviewerId, reviewedAt, requestId]
    );

    if (status === 'approved') {
      const expiresAt = getDurationEndDate(request.duration);
      await pool.query(
        `UPDATE schools
         SET subscription_status = 'active', subscription_plan = $1, subscription_price = $2, subscription_expires_at = $3, subscription_paused = false, updated_at = NOW()
         WHERE id = $4`,
        [request.duration, request.price, expiresAt, request.school_id]
      );
    }

    const adminId = await getSchoolAdmin(request.school_id);
    const message = status === 'approved'
      ? `Your subscription request for ${request.duration} was approved. Access extended until ${getDurationEndDate(request.duration).toLocaleDateString()}.`
      : `Your subscription request for ${request.duration} was rejected. ${remarks || ''}`;

    if (adminId) {
      const io = req.app.get('socketio');
      await createNotification(adminId, 'Subscription request reviewed', message, status === 'approved' ? 'subscription_approved' : 'subscription_rejected', reviewerId, io);
    }

    // CRITICAL: Invalidate school list and affected dashboard caches
    await del('superadmin:schools:*');
    await del(`admin:dashboard:${request.school_id}:*`);

    res.json({ success: true, message: `Subscription request ${status}` });
  } catch (error) {
    console.error('Review Subscription Request Error:', error);
    res.status(500).json({ success: false, message: 'Failed to review subscription request' });
  }
};

const updateSchoolSubscription = async (req, res) => {
  const { schoolId } = req.params;
  const { action } = req.body;

  if (!['pause', 'resume'].includes(action)) {
    return res.status(400).json({ success: false, message: 'Invalid action' });
  }

  try {
    // Improved logic: If resuming, check if current subscription is actually expired
    const isPause = action === 'pause';
    const { rows } = await pool.query(
      `UPDATE schools 
       SET subscription_paused = $1, 
           subscription_status = CASE 
             WHEN $1 = true THEN 'paused' 
             ELSE CASE WHEN subscription_expires_at > NOW() THEN 'active' ELSE 'expired' END
           END,
           updated_at = NOW()
       WHERE id = $2 RETURNING *`,
      [isPause, schoolId]
    );

    if (!rows.length) {
      return res.status(404).json({ success: false, message: 'School not found' });
    }

    // Clear caches
    await del('superadmin:schools:*');
    await del(`admin:dashboard:${schoolId}:*`);

    const userCheck = await pool.query('SELECT id FROM users WHERE id = $1', [req.user.id]);
    const currentUserId = userCheck.rows.length > 0 ? req.user.id : null;

    const adminId = await getSchoolAdmin(schoolId);
    if (adminId) {
      const io = req.app.get('socketio');
      await createNotification(adminId, 'Subscription status updated', `Your school subscription has been ${action === 'pause' ? 'paused' : 'resumed'}.`, 'subscription_update', currentUserId, io);
    }

    res.json({ success: true, school: rows[0] });
  } catch (error) {
    console.error('Update School Subscription Error:', error);
    res.status(500).json({ success: false, message: 'Failed to update subscription' });
  }
};

const getAllSchools = async (req, res) => {
  try {
    const rawLimit = Number(req.query.limit);
    const rawOffset = Number(req.query.offset);
    const search = req.query.search?.trim();
    const limit = Number.isFinite(rawLimit)
      ? Math.min(Math.max(rawLimit, 1), 200)
      : null;
    const offset = Number.isFinite(rawOffset)
      ? Math.max(rawOffset, 0)
      : 0;

    const params = [];
    const filters = [];

    if (search) {
      params.push(`%${search.toLowerCase()}%`);
      filters.push(
        `(LOWER(s.name) LIKE $${params.length} OR LOWER(COALESCE(u.email, '')) LIKE $${params.length} OR CAST(s.id AS TEXT) LIKE $${params.length})`
      );
    }

    const whereClause = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    let paginationClause = '';
    if (limit !== null) {
      params.push(limit, offset);
      paginationClause = ` LIMIT $${params.length - 1} OFFSET $${params.length}`;
    }

    const cacheKey = getSchoolsCacheKey({ search, limit: limit ?? 'all', offset });
    const payload = await withCache(cacheKey, async () => {
      const { rows } = await pool.query(`
        SELECT s.*, u.name as admin_name, u.email as admin_email 
        FROM schools s
        LEFT JOIN users u ON u.school_id = s.id AND u.role = 'admin'
        ${whereClause}
        ORDER BY s.created_at DESC
        ${paginationClause}
      `, params);

      return { success: true, schools: mapMediaFieldsList(rows, ['logo_url']) };
    }, 120);

    res.json(payload);
  } catch (error) {
    res.status(500).json({ success: false, message: "Server error" });
  }
};

const updateAllSchoolSubscriptions = async (req, res) => {
  const { action } = req.body;

  if (!['pause', 'resume'].includes(action)) {
    return res.status(400).json({ success: false, message: 'Invalid action' });
  }

  try {
    const isPause = action === 'pause';
    const newStatus = action === 'pause' ? 'paused' : 'active';
    const { rows } = await pool.query(
      `UPDATE schools 
       SET subscription_paused = $1, 
           subscription_status = CASE 
             WHEN $1 = true THEN 'paused' 
             ELSE CASE WHEN subscription_expires_at > NOW() THEN 'active' ELSE 'expired' END
           END,
           updated_at = NOW()
       WHERE TRUE RETURNING *`,
      [isPause]
    );

    await del('superadmin:schools:*');

    const userCheck = await pool.query('SELECT id FROM users WHERE id = $1', [req.user.id]);
    const currentUserId = userCheck.rows.length > 0 ? req.user.id : null;

    const adminRes = await pool.query(`SELECT id FROM users WHERE role = 'admin'`);
    const io = req.app.get('socketio');
    await Promise.all(adminRes.rows.map((row) =>
      createNotification(
        row.id,
        `Platform ${action === 'pause' ? 'Paused' : 'Resumed'}`,
        `Your school dashboard access has been ${action === 'pause' ? 'paused' : 'resumed'} by the software owner.`,
        'subscription_update',
        currentUserId,
        io
      )
    ));

    res.json({ success: true, message: `All schools ${action}d successfully`, updatedCount: rows.length });
  } catch (error) {
    console.error('Update All School Subscriptions Error:', error);
    res.status(500).json({ success: false, message: 'Failed to update all schools' });
  }
};


//Update School and Admin (with optional logo upload)

const updateSchool = async (req, res) => {
  const { id } = req.params;
  const { name, adminName, adminEmail, adminPassword, subscription_status, subscription_expires_at } = req.body;
  const file = req.file;

  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // 1. Update School Basic Info and Logo
      let logoUpdate = '';
      let schoolValues = [name, subscription_status, subscription_expires_at || null, id];
      
      if (file) {
        const logoUrl = file.path;
        logoUpdate = ', logo_url = $5';
      }

      // Use COALESCE to keep existing logo if no new file is uploaded
      const schoolUpdateRes = await client.query(
        `UPDATE schools 
         SET name = $1, 
             subscription_status = $2, 
             subscription_expires_at = $3,
             updated_at = NOW()
             ${logoUpdate} 
         WHERE id = $4
         RETURNING *`,
        file ? [name, subscription_status, subscription_expires_at || null, id, file.path] : schoolValues
      );

      // Find the user with role 'admin' for this school
      const adminRes = await client.query("SELECT id FROM users WHERE school_id = $1 AND role = 'admin' LIMIT 1", [id]);
      
      if (adminRes.rows.length > 0) {
        const adminId = adminRes.rows[0].id;
        let passwordUpdate = '';
        let adminValues = [adminName, adminEmail, adminId];

        if (adminPassword && adminPassword.trim() !== '') {
          const hashedPassword = await bcrypt.hash(adminPassword, 10);
          passwordUpdate = ', password = $4';
          adminValues.push(hashedPassword);
        }

        await client.query(
          `UPDATE users SET name = $1, email = $2 ${passwordUpdate} WHERE id = $3`,
          adminValues
        );
      }
      await del(`admin:dashboard:${id}:*`);
      await client.query('COMMIT');
      await del('superadmin:schools:*');
      
      res.json({
        success: true,
        message: 'School and Admin updated successfully',
        school: mapMediaFieldsList(schoolUpdateRes.rows, ['logo_url'])[0] || null,
      });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Update School Error:', error);
    res.status(500).json({ success: false, message: 'Server error during update' });
  }
};

const deleteSchool = async (req, res) => {
  const { id } = req.params;
  try {
    // Note: Database schema foreign keys should be ON DELETE CASCADE for full cleanup
    const { rowCount } = await pool.query('DELETE FROM schools WHERE id = $1', [id]);
    if (rowCount === 0) return res.status(404).json({ success: false, message: 'School not found' });
    await del('superadmin:schools:*');
    await del(`admin:dashboard:${id}:*`);
    res.json({ success: true, message: 'School and all associated data deleted successfully' });
  } catch (error) {
    console.error('Delete School Error:', error);
    res.status(500).json({ success: false, message: 'Failed to delete school' });
  }
};

const exportFullBackup = async (req, res) => {
  try {
    const client = await pool.connect();
    const backupData = {};

    // Get all public table names
    const tablesRes = await client.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'public';`);
    const tableNames = tablesRes.rows.map(row => row.tablename);

    for (const tableName of tableNames) {
      // Exclude system tables or tables that might not be relevant for a data backup
      if (!tableName.startsWith('pg_') && !tableName.startsWith('sql_')) {
        const dataRes = await client.query(`SELECT * FROM "${tableName}";`);
        backupData[tableName] = dataRes.rows;
      }
    }

    client.release();

    res.setHeader('Content-Disposition', `attachment; filename="full_system_backup_${new Date().toISOString().split('T')[0]}.json"`);
    res.setHeader('Content-Type', 'application/json');
    res.status(200).send(JSON.stringify(backupData, null, 2));
  } catch (error) {
    console.error('Export Full Backup Error:', error);
    res.status(500).json({ success: false, message: 'Failed to export full backup', error: error.message });
  }
};

const exportSchoolBackup = async (req, res) => {
  const { schoolId } = req.params;
  if (!schoolId) {
    return res.status(400).json({ success: false, message: 'School ID is required for school backup' });
  }

  try {
    const client = await pool.connect();
    const backupData = {};

    const schoolRes = await client.query(`SELECT * FROM schools WHERE id = $1;`, [schoolId]);
    if (!schoolRes.rows.length) {
      client.release();
      return res.status(404).json({ success: false, message: `School ${schoolId} not found` });
    }

    backupData.schools = schoolRes.rows;

    // Find all tables that have a 'school_id' column
    const tablesWithSchoolIdRes = await client.query(
      `SELECT table_name FROM information_schema.columns WHERE column_name = 'school_id' AND table_schema = 'public';`
    );
    const tableNames = tablesWithSchoolIdRes.rows
      .map(row => row.table_name)
      .filter((tableName) => tableName !== 'schools');

    for (const tableName of tableNames) {
      const dataRes = await client.query(`SELECT * FROM "${tableName}" WHERE school_id = $1;`, [schoolId]);
      backupData[tableName] = dataRes.rows;
    }

    client.release();

    res.setHeader('Content-Disposition', `attachment; filename="school_${schoolId}_backup_${new Date().toISOString().split('T')[0]}.json"`);
    res.setHeader('Content-Type', 'application/json');
    res.status(200).send(JSON.stringify(backupData, null, 2));
  } catch (error) {
    console.error(`Export School Backup Error for school ${schoolId}:`, error);
    res.status(500).json({ success: false, message: `Failed to export backup for school ${schoolId}`, error: error.message });
  }
};

const MASTER_DELETE_KEY = process.env.MASTER_DELETE_KEY || 'edu-flow-master-key';

const importFullBackup = async (req, res) => {
  const { masterKey } = req.body;
  if (masterKey !== MASTER_DELETE_KEY) {
    return res.status(403).json({ success: false, message: "Unauthorized: Invalid Master Key for full system restore." });
  }

  if (!req.file) {
    return res.status(400).json({ success: false, message: 'No backup file uploaded.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const backupFileContents = await readBackupUpload(req.file);
    if (!backupFileContents) {
      throw new Error('Uploaded backup file could not be read.');
    }

    const backupData = JSON.parse(backupFileContents);
    const backupTableNames = getBackupTableNames(backupData);

    // Disable foreign key checks for a smoother import process
    await client.query('SET session_replication_role = replica;');

    // Clear existing data (DANGER: This will delete all current data)
    // Iterate through tables in reverse order of foreign key dependencies if known,
    // or simply truncate all tables. For simplicity, we'll truncate all public tables.
    const tablesRes = await client.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'public';`);
    for (const row of tablesRes.rows) {
      const tableName = row.tablename;
      if (backupData[tableName]) { // Only truncate tables that are in the backup
        await client.query(`TRUNCATE TABLE "${tableName}" RESTART IDENTITY CASCADE;`);
      }
    }

    // Insert data from backup
    for (const tableName of backupTableNames) {
      await insertRecords(client, tableName, backupData[tableName]);
    }

    await syncBackupSequences(client, backupTableNames);

    // Re-enable foreign key checks
    await client.query('SET session_replication_role = DEFAULT;');

    await client.query('COMMIT');
    res.status(200).json({ success: true, message: 'Full database restored successfully.' });
  } catch (error) {
    await client.query('ROLLBACK');
    await client.query('SET session_replication_role = DEFAULT;').catch(() => {});
    console.error('Import Full Backup Error:', error);
    res.status(500).json({ success: false, message: 'Failed to import full backup', error: error.message });
  } finally {
    client.release();
  }
};

const importSchoolBackup = async (req, res) => {
  const { schoolId } = req.params;
  const { masterKey } = req.body;

  if (masterKey !== MASTER_DELETE_KEY) {
    return res.status(403).json({ success: false, message: "Unauthorized: Invalid Master Key for school restore." });
  }

  if (!schoolId) {
    return res.status(400).json({ success: false, message: 'School ID is required for school backup import.' });
  }
  if (!req.file) {
    return res.status(400).json({ success: false, message: 'No backup file uploaded.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const backupFileContents = await readBackupUpload(req.file);
    if (!backupFileContents) {
      throw new Error('Uploaded backup file could not be read.');
    }

    const backupData = JSON.parse(backupFileContents);
    
    // IMPROVED: Find school record by ID, or take the first available record from the backup
    let schoolRecord = null;
    if (backupData && Array.isArray(backupData.schools) && backupData.schools.length > 0) {
      schoolRecord = backupData.schools.find((record) => String(record.id) === String(schoolId)) || backupData.schools[0];
      // Force the record ID to match the target schoolId for a successful restore
      if (schoolRecord) {
        schoolRecord.id = parseInt(schoolId, 10);
      }
    }

    const backupTableNames = getBackupTableNames(backupData);

    // Disable foreign key checks
    await client.query('SET session_replication_role = replica;');

    const existingSchoolRes = await client.query(`SELECT id FROM schools WHERE id = $1;`, [schoolId]);
    if (existingSchoolRes.rows.length) {
      await client.query(`DELETE FROM schools WHERE id = $1;`, [schoolId]);
    }

    if (schoolRecord) {
      await insertRecords(client, 'schools', [schoolRecord]);
    } else {
      // If no school info in backup, ensure the school exists (re-insert placeholder if it was deleted)
      await client.query(
        `INSERT INTO schools (id, name)
         VALUES ($1, $2)
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name;`,
        [schoolId, `Restored School ${schoolId}`]
      );
    }

    // Insert data from backup for the specific school
    for (const tableName of backupTableNames) {
      if (tableName === 'schools') continue;

      const records = backupData[tableName];
      const filteredRecords = Array.isArray(records)
        ? records.filter((record) => String(record.school_id) === String(schoolId))
        : [];

      await insertRecords(client, tableName, filteredRecords);
    }

    await syncBackupSequences(client, ['schools', ...backupTableNames.filter((tableName) => tableName !== 'schools')]);

    // Re-enable foreign key checks
    await client.query('SET session_replication_role = DEFAULT;');

    await client.query('COMMIT');
    res.status(200).json({ success: true, message: `Backup for school ${schoolId} restored successfully.` });
  } catch (error) {
    await client.query('ROLLBACK');
    await client.query('SET session_replication_role = DEFAULT;').catch(() => {});
    console.error(`Import School Backup Error for school ${schoolId}:`, error);
    res.status(500).json({ success: false, message: `Failed to import backup for school ${schoolId}`, error: error.message });
  } finally {
    client.release();
  }
};

module.exports = {
  createSchool,
  updateSchool,
  deleteSchool,
  getAllSchools,
  getSubscriptionRequests,
  reviewSubscriptionRequest,
  updateSchoolSubscription,
  updateAllSchoolSubscriptions,
  exportFullBackup,
  exportSchoolBackup,
  importFullBackup,
  importSchoolBackup
};
