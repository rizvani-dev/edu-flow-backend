const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const morgan = require('morgan');
const compression = require('compression');
const zlib = require('zlib');

const pool = require('./config/db');
const registerSocketHandlers = require('./socket/ioHandlers');
const { createNotification } = require('./controllers/notificationController');

dotenv.config();

// Ensure uploads directory exists for Railway persistence/startup
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const app = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 5000;

app.disable('x-powered-by');

// ======================
// ENV CHECKS
// ======================

if (!process.env.JWT_SECRET) {
  console.warn('⚠ JWT_SECRET is missing');
}

if (!process.env.DATABASE_URL) {
  console.warn('⚠ DATABASE_URL is missing');
}

if (!process.env.SUPABASE_SERVICE_ROLE_KEY && !process.env.SUPABASE_ANON_KEY) {
  console.warn('⚠ Supabase storage key is missing. Uploads will fail.');
}

// ======================
// CORS
// ======================

app.set('trust proxy', 1); // Required for Railway/Proxies

const configuredOrigins = String(process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

const allowedOrigins = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'https://edu-flow01.vercel.app',
  ...configuredOrigins,
];

const normalizedAllowedOrigins = [...new Set(allowedOrigins.map((origin) => origin.trim().toLowerCase().replace(/\/$/, '')))];

const corsOptions = {
  origin: (origin, callback) => {
    // Allow requests with no origin (like mobile apps or curl)
    if (!origin) return callback(null, true);

    const normalizedOrigin = origin.trim().toLowerCase().replace(/\/$/, '');

    if (normalizedAllowedOrigins.includes(normalizedOrigin)) {
      return callback(null, true);
    }

    callback(null, false); // Reject without throwing a hard error to the main stack
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Origin'],
};

app.use(cors(corsOptions));

// ======================
// SECURITY MIDDLEWARE
// ======================

app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  crossOriginEmbedderPolicy: false,
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://cdnjs.cloudflare.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com", "https://cdnjs.cloudflare.com"],
      imgSrc: ["'self'", "data:", "https:", "https://*.supabase.co"],
      scriptSrc: ["'self'"],
      connectSrc: ["'self'", "wss:", "ws:", "https://*.supabase.co", process.env.REDIS_URL],
    },
  },
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});

app.use('/api/', limiter);

// Stricter rate limiting for auth endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // limit each IP to 5 auth requests per windowMs
  message: 'Too many authentication attempts, please try again later.',
});

app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);

// Request logging
app.use(morgan('combined'));

// Response compression
app.use(compression({
  threshold: 1024,
  level: 6,
  brotli: {
    enabled: true,
    zlib: {
      [zlib.constants.BROTLI_PARAM_QUALITY]: 4,
    },
  },
}));



// ======================
// BODY PARSER
// ======================

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ======================
// STATIC UPLOADS
// ======================

app.use(
  '/uploads',
  express.static(path.join(__dirname, 'uploads'), {
    setHeaders: (res, filePath) => {
      const ext = path.extname(filePath).toLowerCase();

      if (ext === '.pdf') {
        res.setHeader('Content-Type', 'application/pdf');
      } else if (
        ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg'].includes(ext)
      ) {
        res.setHeader(
          'Content-Type',
          ext === '.svg' ? 'image/svg+xml' : `image/${ext === '.jpg' ? 'jpeg' : ext.slice(1)}`
        );
      } else if (['.mp4', '.webm', '.ogg'].includes(ext)) {
        res.setHeader('Content-Type', `video/${ext.slice(1)}`);
      }

      if (
        ext === '.pdf' ||
        ![
          '.jpg',
          '.jpeg',
          '.png',
          '.gif',
          '.webp',
          '.svg',
          '.mp4',
          '.webm',
          '.ogg',
        ].includes(ext)
      ) {
        res.setHeader('Content-Disposition', 'attachment');
      } else {
        res.setHeader('Content-Disposition', 'inline');
      }
    },
  })
);

// ======================
// SOCKET.IO
// ======================

const io = new Server(server, {
  cors: {
    origin: normalizedAllowedOrigins,
    methods: ['GET', 'POST'],
    credentials: true
  },
  transports: ['websocket', 'polling'],
  pingInterval: 25000,
  pingTimeout: 20000,
  maxHttpBufferSize: 1e6
})
app.set('socketio', io);

registerSocketHandlers(io, pool);

// ======================
// ROUTES
// ======================

const authRoutes = require('./routes/authRoutes');
const adminRoutes = require('./routes/adminRoutes');
const teacherRoutes = require('./routes/teacherRoutes');
const studentRoutes = require('./routes/studentRoutes');
const attendanceRoutes = require('./routes/attendanceRoutes');
const resultsRoutes = require('./routes/resultsRoutes');
const announcementsRoutes = require('./routes/announcementsRoutes');
const chatRoutes = require('./routes/chatRoutes');
const studentChatRoutes = require('./routes/studentChatRoutes');
const adminChatRoutes = require('./routes/adminChatRoutes');
const teacherNotificationRoutes = require('./routes/teacherNotificationRoutes');
const studentNotificationRoutes = require('./routes/studentNotificationRoutes');
const adminNotificationRoutes = require('./routes/adminNotificationRoutes');
const superAdminRoutes = require('./routes/superAdminRoutes');
const feeRoutes = require('./routes/feeRoutes');
const classRoutes = require('./routes/classRoutes');
const homeworkRoutes = require('./routes/homeworkRoutes.js');
const aiRoutes = require('./routes/aiRoutes');
const examRoutes = require('./routes/examRoutes');



// API Health Check
app.get('/api', (req, res) => {
  res.json({
    success: true,
    message: 'API Working Successfully',
  });
});

// Main Routes
app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/teacher', teacherRoutes);
app.use('/api/student', studentRoutes);
app.use('/api/attendance', attendanceRoutes);
app.use('/api/results', resultsRoutes);
app.use('/api/announcements', announcementsRoutes);
app.use('/api/teacher/chat', chatRoutes);
app.use('/api/student/chat', studentChatRoutes);
app.use('/api/admin/chat', adminChatRoutes);
app.use('/api/teacher/notifications', teacherNotificationRoutes);
app.use('/api/student/notifications', studentNotificationRoutes);
app.use('/api/admin/notifications', adminNotificationRoutes);
app.use('/api/superadmin', superAdminRoutes);
app.use('/api/fees', feeRoutes);
app.use('/api/classes', classRoutes);
app.use('/api/homework', homeworkRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/exams', examRoutes);
// ======================
// ROOT ROUTE
// ======================

app.get('/', (req, res) => {
  res.json({
    status: 'School Management Backend fully ready',
    message: 'Socket.io, real-time chat, and file uploads are available.',
  });
});

// ======================
// 404 HANDLER
// ======================

app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: 'Route not found',
  });
});

// ======================
// ERROR HANDLER
// ======================

app.use((err, req, res, next) => {
  console.error(err);

  if (err.message?.includes('CORS')) {
    return res.status(403).json({
      success: false,
      message: err.message,
    });
  }

  if (err.name === 'MulterError') {
    return res.status(400).json({
      success: false,
      message: err.message,
    });
  }

  if (
    err.message === 'Unsupported file type' ||
    err.message === 'Supabase storage is not configured on the server'
  ) {
    return res.status(400).json({
      success: false,
      message: err.message,
    });
  }

  res.status(500).json({
    success: false,
    message: 'Internal Server Error',
  });
});

// ======================
// AUTO DELETE
// ======================

const cleanupInterval = setInterval(async () => {
  try {
    await pool.query(`
      DELETE FROM announcements
      WHERE COALESCE(created_at, date, NOW()) < NOW() - INTERVAL '7 days'
    `);

    await pool.query(`
      DELETE FROM messages
      WHERE created_at < NOW() - INTERVAL '7 days'
    `);

    await pool.query(`
      DELETE FROM homework
      WHERE COALESCE(expires_at, due_date, assigned_date + INTERVAL '7 days') < NOW()
    `);

    await pool.query(`
      DELETE FROM exams
      WHERE expires_at < NOW()
    `);

    await pool.query(`
      DELETE FROM notifications
      WHERE created_at < NOW() - INTERVAL '7 days'
    `);

    console.log('✅ Auto cleanup completed');
  } catch (error) {
    console.error('❌ Auto delete error:', error);
  }
}, 24 * 60 * 60 * 1000);

cleanupInterval.unref();

const reminderInterval = setInterval(async () => {
  try {
    const io = app.get('socketio');

    const pendingFeeRows = await pool.query(`
      SELECT
        f.id,
        f.month,
        f.year,
        f.amount,
        f.due_date,
        u.id AS student_id,
        u.name AS student_name
      FROM fees f
      JOIN users u ON u.id = f.student_id
      WHERE LOWER(COALESCE(f.status, 'pending')) <> 'paid'
        AND (
          (f.due_date IS NOT NULL AND f.due_date::date <= CURRENT_DATE + INTERVAL '7 days')
          OR (
            f.due_date IS NULL
            AND LOWER(TRIM(COALESCE(f.month, ''))) = LOWER(TO_CHAR(CURRENT_DATE, 'FMMonth'))
            AND COALESCE(f.year, EXTRACT(YEAR FROM CURRENT_DATE)::INT) = EXTRACT(YEAR FROM CURRENT_DATE)::INT
          )
        )
      ORDER BY f.due_date NULLS LAST, f.year DESC, f.id DESC
    `);

    for (const fee of pendingFeeRows.rows) {
      await createNotification(
        fee.student_id,
        'Monthly fee reminder',
        `Your ${fee.month || 'current'} ${fee.year || ''} fee of PKR ${Number(fee.amount || 0).toLocaleString()} is pending${fee.due_date ? ` and due by ${new Date(fee.due_date).toLocaleDateString()}` : ''}. Please complete payment to avoid delays.`,
        'fee_reminder',
        fee.id,
        io
      );
    }

    const expiringSchools = await pool.query(`
      SELECT id, name, subscription_plan, subscription_expires_at
      FROM schools
      WHERE subscription_status = 'active'
        AND subscription_expires_at IS NOT NULL
        AND subscription_expires_at >= NOW()
        AND subscription_expires_at <= NOW() + INTERVAL '7 days'
    `);

    for (const school of expiringSchools.rows) {
      const admins = await pool.query(
        `SELECT id FROM users WHERE school_id = $1 AND role = 'admin'`,
        [school.id]
      );

      for (const admin of admins.rows) {
        await createNotification(
          admin.id,
          'Subscription expiring soon',
          `${school.name} subscription${school.subscription_plan ? ` (${school.subscription_plan})` : ''} will expire on ${new Date(school.subscription_expires_at).toLocaleDateString()}. You have 7 days or less left to renew.`,
          'subscription_expiring',
          school.id,
          io
        );
      }
    }

    console.log('Reminder scheduler completed');
  } catch (error) {
    console.error('Reminder scheduler error:', error);
  }
}, 12 * 60 * 60 * 1000);

reminderInterval.unref();

// ======================
// SERVER START
// ======================

server.listen(PORT, async () => {
  console.log(`🚀 Server running on port ${PORT}`);

  try {
    await pool.query('SELECT 1');

    console.log('✅ PostgreSQL connected successfully');

    await pool.query(`
      ALTER TABLE schools
      ADD COLUMN IF NOT EXISTS logo_url TEXT,
      ADD COLUMN IF NOT EXISTS subscription_plan VARCHAR(50) DEFAULT 'none',
      ADD COLUMN IF NOT EXISTS subscription_price NUMERIC(12,2) DEFAULT 0,
      ADD COLUMN IF NOT EXISTS subscription_status VARCHAR(20) DEFAULT 'inactive',
      ADD COLUMN IF NOT EXISTS subscription_expires_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS subscription_paused BOOLEAN DEFAULT false,
      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS subscription_requests (
        id SERIAL PRIMARY KEY,
        school_id INTEGER REFERENCES schools(id) ON DELETE CASCADE,
        admin_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        duration VARCHAR(20) NOT NULL,
        price NUMERIC(12,2) NOT NULL,
        screenshot_url TEXT,
        status VARCHAR(20) DEFAULT 'pending',
        remarks TEXT,
        reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        reviewed_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await pool.query(`
      ALTER TABLE messages
      ADD COLUMN IF NOT EXISTS file_mime TEXT,
      ADD COLUMN IF NOT EXISTS file_size INTEGER,
      ADD COLUMN IF NOT EXISTS reactions JSONB NOT NULL DEFAULT '{}'::jsonb,
      ADD COLUMN IF NOT EXISTS deleted_for INTEGER[] NOT NULL DEFAULT '{}'::int[],
      ADD COLUMN IF NOT EXISTS deleted_for_everyone BOOLEAN NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS seen_at TIMESTAMP
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS homework (
        id SERIAL PRIMARY KEY,
        school_id INTEGER REFERENCES schools(id) ON DELETE CASCADE,
        class_id INTEGER REFERENCES classes(id) ON DELETE CASCADE,
        teacher_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        title VARCHAR(255) NOT NULL,
        description TEXT,
        subject VARCHAR(120),
        assigned_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        due_date TIMESTAMP,
        duration_value INTEGER DEFAULT 7,
        duration_unit VARCHAR(20) DEFAULT 'days',
        expires_at TIMESTAMP,
        reactions JSONB NOT NULL DEFAULT '{}'::jsonb,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await pool.query(`
      ALTER TABLE homework
      ADD COLUMN IF NOT EXISTS assigned_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      ADD COLUMN IF NOT EXISTS due_date TIMESTAMP,
      ADD COLUMN IF NOT EXISTS duration_value INTEGER DEFAULT 7,
      ADD COLUMN IF NOT EXISTS duration_unit VARCHAR(20) DEFAULT 'days',
      ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS reactions JSONB NOT NULL DEFAULT '{}'::jsonb,
      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    `);

    await pool.query(`
      ALTER TABLE announcements
      ADD COLUMN IF NOT EXISTS reactions JSONB NOT NULL DEFAULT '{}'::jsonb,
      ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    `);

    await pool.query(`
      UPDATE messages
      SET
        reactions = COALESCE(reactions, '{}'::jsonb),
        deleted_for = COALESCE(deleted_for, '{}'::int[]),
        deleted_for_everyone = COALESCE(deleted_for_everyone, false),
        status = COALESCE(NULLIF(status, ''), 'sent'),
        message_type = COALESCE(NULLIF(message_type, ''), CASE WHEN file_url IS NOT NULL THEN 'file' ELSE 'text' END)
      WHERE
        reactions IS NULL
        OR deleted_for IS NULL
        OR deleted_for_everyone IS NULL
        OR status IS NULL
        OR status = ''
        OR message_type IS NULL
        OR message_type = ''
    `);

    await pool.query(`
      UPDATE homework
      SET
        reactions = COALESCE(reactions, '{}'::jsonb),
        duration_value = COALESCE(duration_value, 7),
        duration_unit = COALESCE(NULLIF(duration_unit, ''), 'days'),
        assigned_date = COALESCE(assigned_date, CURRENT_TIMESTAMP),
        expires_at = COALESCE(expires_at, due_date, assigned_date + INTERVAL '7 days'),
        updated_at = COALESCE(updated_at, CURRENT_TIMESTAMP)
      WHERE
        reactions IS NULL
        OR duration_value IS NULL
        OR duration_unit IS NULL
        OR duration_unit = ''
        OR assigned_date IS NULL
        OR expires_at IS NULL
        OR updated_at IS NULL
    `);

    await pool.query(`
      UPDATE announcements
      SET
        reactions = COALESCE(reactions, '{}'::jsonb),
        created_at = COALESCE(created_at, date, CURRENT_TIMESTAMP)
      WHERE reactions IS NULL OR created_at IS NULL
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_messages_conversation_created
      ON messages (sender_id, receiver_id, created_at DESC, id DESC)
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_messages_receiver_status
      ON messages (receiver_id, status, created_at DESC)
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_notifications_user_created
      ON notifications (user_id, created_at DESC)
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_homework_school_class_expiry
      ON homework (school_id, class_id, expires_at DESC, assigned_date DESC)
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_announcements_school_date
      ON announcements (school_id, date DESC)
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_subscription_requests_status_created
      ON subscription_requests (status, created_at DESC)
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_users_school_role
      ON users (school_id, role)
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_users_school_id
      ON users (school_id)
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_attendance_school_student
      ON attendance (school_id, student_id, date DESC)
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_results_school_student
      ON results (school_id, student_id, created_at DESC)
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_fees_school_student
      ON fees (school_id, student_id, year DESC, month)
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_fee_payment_requests_school_student
      ON fee_payment_requests (school_id, student_id, created_at DESC)
    `);

    await pool.query(`
      UPDATE users SET online = false
    `);

    console.log('✅ Database setup complete');
  } catch (error) {
    console.error('❌ Database connection failed:', error);
  }
});
