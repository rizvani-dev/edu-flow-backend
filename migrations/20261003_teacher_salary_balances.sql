ALTER TABLE teacher_salaries
  ADD COLUMN IF NOT EXISTS amount_paid numeric(12,2) NOT NULL DEFAULT 0;

UPDATE teacher_salaries
SET amount_paid = amount
WHERE status IN ('paid', 'received') AND amount_paid = 0;

CREATE INDEX IF NOT EXISTS idx_teacher_salary_requests_pending_period
  ON teacher_salary_requests (teacher_id, school_id, year, month, request_type)
  WHERE status = 'pending';
