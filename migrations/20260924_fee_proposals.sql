CREATE TABLE IF NOT EXISTS fee_proposals (
    id SERIAL PRIMARY KEY,
    school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
    teacher_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
    month VARCHAR(20) NOT NULL,
    year INTEGER NOT NULL CHECK (year BETWEEN 2000 AND 2200),
    due_date DATE,
    proposed_amount NUMERIC(12, 2) CHECK (proposed_amount IS NULL OR proposed_amount > 0),
    status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
    approved_amount NUMERIC(12, 2),
    reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    reviewed_at TIMESTAMP,
    review_remarks TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_fee_proposal_pending_period
ON fee_proposals (school_id, class_id, month, year)
WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_fee_proposals_school_status
ON fee_proposals (school_id, status, created_at);
