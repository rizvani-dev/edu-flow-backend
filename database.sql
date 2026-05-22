-- Drop tables if they exist (for fresh start)
DROP TABLE IF EXISTS notifications CASCADE;
DROP TABLE IF EXISTS messages CASCADE;
DROP TABLE IF EXISTS announcements CASCADE;
DROP TABLE IF EXISTS results CASCADE;
DROP TABLE IF EXISTS fee_payment_requests CASCADE;
DROP TABLE IF EXISTS fees CASCADE;
DROP TABLE IF EXISTS attendance CASCADE;
DROP TABLE IF EXISTS classes CASCADE;
DROP TABLE IF EXISTS schools CASCADE;
DROP TABLE IF EXISTS users CASCADE;

-- Schools Table (Tenants)
CREATE TABLE schools (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    subdomain VARCHAR(100) UNIQUE,
    logo_url TEXT,
    subscription_plan VARCHAR(50) DEFAULT 'none',
    subscription_price NUMERIC(12, 2) DEFAULT 0,
    subscription_status VARCHAR(20) DEFAULT 'inactive' CHECK (subscription_status IN ('inactive', 'active', 'paused', 'expired')),
    subscription_expires_at TIMESTAMP,
    subscription_paused BOOLEAN DEFAULT false,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Users Table
CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    email VARCHAR(100) UNIQUE NOT NULL,
    password VARCHAR(255) NOT NULL,
    role VARCHAR(20) NOT NULL CHECK (role IN ('admin', 'teacher', 'student', 'super_admin')),
    school_id INTEGER REFERENCES schools(id) ON DELETE CASCADE, -- NULL for super_admin
    class_id INTEGER,
    teacher_id INTEGER,
    bio TEXT,
    profile_image TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    online BOOLEAN DEFAULT false,
    last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE teacher_salaries (
    id SERIAL PRIMARY KEY,
    school_id INTEGER REFERENCES schools(id) ON DELETE CASCADE,
    teacher_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    month VARCHAR(20) NOT NULL,
    year INTEGER NOT NULL,
    amount NUMERIC(12, 2) NOT NULL,
    status VARCHAR(20) DEFAULT 'pending', -- 'pending' or 'paid'
    payment_screenshot TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Classes Table
CREATE TABLE classes (
    id SERIAL PRIMARY KEY,
    school_id INTEGER REFERENCES schools(id) ON DELETE CASCADE,
    name VARCHAR(50) NOT NULL,
    grade_level INTEGER NOT NULL DEFAULT 1,
    section VARCHAR(10) NOT NULL DEFAULT 'A',
    teacher_id INTEGER REFERENCES users(id) ON DELETE SET NULL
);

ALTER TABLE classes
ADD CONSTRAINT unique_school_grade_section UNIQUE (school_id, grade_level, section);

-- Add missing foreign keys after both tables exist
ALTER TABLE users
ADD CONSTRAINT fk_user_class FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE SET NULL;

ALTER TABLE users
ADD CONSTRAINT fk_user_teacher FOREIGN KEY (teacher_id) REFERENCES users(id) ON DELETE SET NULL;

-- Attendance Table
CREATE TABLE attendance (
    id SERIAL PRIMARY KEY,
    school_id INTEGER REFERENCES schools(id) ON DELETE CASCADE,
    student_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    teacher_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    class_id INTEGER REFERENCES classes(id) ON DELETE SET NULL,
    date DATE NOT NULL,
    status VARCHAR(20) NOT NULL CHECK (status IN ('present', 'absent', 'late', 'holiday')),
    remarks TEXT,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (student_id, date)
);

-- Results Table
CREATE TABLE results (
    id SERIAL PRIMARY KEY,
    school_id INTEGER REFERENCES schools(id) ON DELETE CASCADE,
    student_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    teacher_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    class_id INTEGER REFERENCES classes(id) ON DELETE SET NULL,
    subject VARCHAR(50) NOT NULL,
    marks INTEGER CHECK (marks >= 0 AND marks <= 100),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Announcements Table
CREATE TABLE announcements (
    id SERIAL PRIMARY KEY,
    school_id INTEGER REFERENCES schools(id) ON DELETE CASCADE,
    title VARCHAR(200) NOT NULL,
    description TEXT NOT NULL,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    target_role VARCHAR(20) CHECK (target_role IN ('all', 'teacher', 'student', 'my_class')),
    date DATE DEFAULT CURRENT_TIMESTAMP
);

-- Fees Table
CREATE TABLE fees (
    id SERIAL PRIMARY KEY,
    school_id INTEGER REFERENCES schools(id) ON DELETE CASCADE,
    student_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    class_id INTEGER REFERENCES classes(id) ON DELETE SET NULL,
    month VARCHAR(20) NOT NULL,
    year INTEGER NOT NULL,
    amount DECIMAL(10, 2) NOT NULL,
    status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'partial', 'overdue')),
    due_date DATE,
    remarks TEXT,
    updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (student_id, month, year)
);

-- Manual Fee Payment Requests (Student uploads screenshot + transaction id)
CREATE TABLE fee_payment_requests (
    id SERIAL PRIMARY KEY,
    school_id INTEGER REFERENCES schools(id) ON DELETE CASCADE,
    student_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    fee_id INTEGER REFERENCES fees(id) ON DELETE SET NULL,
    transaction_id VARCHAR(120) NOT NULL,
    screenshot_url TEXT,
    status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
    remarks TEXT,
    reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    reviewed_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Subscription Request Table
CREATE TABLE subscription_requests (
    id SERIAL PRIMARY KEY,
    school_id INTEGER REFERENCES schools(id) ON DELETE CASCADE,
    admin_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    duration VARCHAR(20) NOT NULL,
    price NUMERIC(12, 2) NOT NULL,
    screenshot_url TEXT,
    status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
    remarks TEXT,
    reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    reviewed_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Online Exams Table (AI Generated)
CREATE TABLE exams (
    id SERIAL PRIMARY KEY,
    school_id INTEGER REFERENCES schools(id) ON DELETE CASCADE,
    teacher_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    class_id INTEGER REFERENCES classes(id) ON DELETE CASCADE,
    title VARCHAR(255) NOT NULL,
    subject VARCHAR(120),
    difficulty VARCHAR(20) CHECK (difficulty IN ('Easy', 'Medium', 'Hard')),
    total_questions INTEGER DEFAULT 10,
    marks INTEGER DEFAULT 100,
    duration_minutes INTEGER DEFAULT 30,
    questions JSONB, -- Stores the AI-generated question structure
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Exam Results (Student Submissions)
CREATE TABLE exam_results (
    id SERIAL PRIMARY KEY,
    school_id INTEGER REFERENCES schools(id) ON DELETE CASCADE,
    exam_id INTEGER REFERENCES exams(id) ON DELETE CASCADE,
    student_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    score INTEGER CHECK (score >= 0 AND score <= 500),
    answers JSONB, -- Stores student's responses
    completed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (exam_id, student_id) -- Prevents multiple submissions for the same exam
);

-- Messages Table
CREATE TABLE messages (
    id SERIAL PRIMARY KEY,
    school_id INTEGER REFERENCES schools(id) ON DELETE CASCADE,
    sender_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    receiver_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    message TEXT,
    file_url TEXT,
    file_name TEXT,
    file_mime TEXT,
    file_size INTEGER,
    message_type VARCHAR(20) NOT NULL DEFAULT 'text' CHECK (message_type IN ('text', 'image', 'video', 'audio', 'file')),
    reactions JSONB NOT NULL DEFAULT '{}'::jsonb,
    deleted_for INTEGER[] NOT NULL DEFAULT '{}'::int[],
    deleted_for_everyone BOOLEAN NOT NULL DEFAULT false,
    seen_at TIMESTAMP,
    status VARCHAR(20) NOT NULL DEFAULT 'sent' CHECK (status IN ('sent', 'seen', 'deleted')),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Notifications Table
CREATE TABLE notifications (
    id SERIAL PRIMARY KEY,
    school_id INTEGER REFERENCES schools(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    title VARCHAR(200) NOT NULL,
    message TEXT NOT NULL,
    type VARCHAR(30) NOT NULL DEFAULT 'info',
    is_read BOOLEAN DEFAULT false,
    related_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_users_school_role ON users (school_id, role);
CREATE INDEX idx_users_school_id ON users (school_id);
CREATE INDEX idx_users_class_id ON users (class_id);
CREATE INDEX idx_attendance_school_student ON attendance (school_id, student_id, date DESC);
CREATE INDEX idx_results_school_student ON results (school_id, student_id, created_at DESC);
CREATE INDEX idx_exams_class_id ON exams (class_id);
CREATE INDEX idx_exam_results_student_id ON exam_results (student_id);
CREATE INDEX idx_fees_school_student ON fees (school_id, student_id, year DESC, month);
CREATE INDEX idx_fee_payment_requests_school_student ON fee_payment_requests (school_id, student_id, created_at DESC);
CREATE INDEX idx_messages_sender_receiver_created ON messages (sender_id, receiver_id, created_at DESC, id DESC);
CREATE INDEX idx_messages_receiver_status ON messages (receiver_id, status, created_at DESC);
CREATE INDEX idx_notifications_user_created ON notifications (user_id, created_at DESC);
CREATE INDEX idx_subscription_requests_status_created ON subscription_requests (status, created_at DESC);
CREATE INDEX idx_schools_created_at ON schools (created_at DESC);

-- Create Default Super Admin (password = "password")
INSERT INTO users (name, email, password, role, school_id)
VALUES (
    'Main Super Admin',
    'superadmin@system.com',
    '$2a$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi', -- Hashed password for "password"
    'super_admin',
    NULL
)
ON CONFLICT (email) DO NOTHING; -- Prevents error if super admin already exists

SELECT 'Database tables created and default super admin added' AS message;
