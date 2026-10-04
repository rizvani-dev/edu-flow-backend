-- Fee breakdown snapshots, student codes, configurable adjustments, and unique payment references.
ALTER TABLE users ADD COLUMN IF NOT EXISTS student_code VARCHAR(40);
UPDATE users SET student_code = 'STU-' || LPAD(school_id::text, 4, '0') || '-' || LPAD(id::text, 6, '0')
WHERE role = 'student' AND student_code IS NULL AND school_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_users_student_code ON users (student_code) WHERE student_code IS NOT NULL;

CREATE OR REPLACE FUNCTION assign_student_code() RETURNS trigger AS $$
BEGIN
  IF NEW.role = 'student' AND NEW.student_code IS NULL AND NEW.school_id IS NOT NULL THEN
    NEW.student_code := 'STU-' || LPAD(NEW.school_id::text, 4, '0') || '-' || LPAD(NEW.id::text, 6, '0');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_assign_student_code ON users;
CREATE TRIGGER trg_assign_student_code BEFORE INSERT OR UPDATE ON users
FOR EACH ROW EXECUTE FUNCTION assign_student_code();

ALTER TABLE fee_structures
  ADD COLUMN IF NOT EXISTS tax_percent NUMERIC(7, 3) NOT NULL DEFAULT 0 CHECK (tax_percent BETWEEN 0 AND 100),
  ADD COLUMN IF NOT EXISTS discount_amount NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (discount_amount >= 0);

ALTER TABLE fees
  ADD COLUMN IF NOT EXISTS base_amount NUMERIC(12, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tax_rate NUMERIC(7, 3) NOT NULL DEFAULT 0 CHECK (tax_rate BETWEEN 0 AND 100),
  ADD COLUMN IF NOT EXISTS tax_amount NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (tax_amount >= 0),
  ADD COLUMN IF NOT EXISTS discount_amount NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (discount_amount >= 0);
UPDATE fees SET base_amount = GREATEST(0, amount - fine_amount - other_charges)
WHERE base_amount = 0 AND amount > 0;

CREATE TABLE IF NOT EXISTS student_fee_adjustments (
  id BIGSERIAL PRIMARY KEY,
  school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  fine_amount NUMERIC(12, 2) CHECK (fine_amount IS NULL OR fine_amount >= 0),
  tax_percent NUMERIC(7, 3) CHECK (tax_percent IS NULL OR tax_percent BETWEEN 0 AND 100),
  discount_amount NUMERIC(12, 2) CHECK (discount_amount IS NULL OR discount_amount >= 0),
  remarks TEXT,
  updated_by INTEGER REFERENCES users(id),
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (school_id, student_id)
);

-- Preserve old duplicate transaction values for audit; transaction_key is assigned
-- to one historical occurrence and is required for all new records.
ALTER TABLE fee_payment_requests ADD COLUMN IF NOT EXISTS transaction_key TEXT;
WITH ranked AS (
  SELECT id, school_id, lower(trim(transaction_id)) AS normalized,
         row_number() OVER (PARTITION BY school_id, lower(trim(transaction_id)) ORDER BY id) AS occurrence
  FROM fee_payment_requests
)
UPDATE fee_payment_requests r SET transaction_key = r.school_id::text || ':' || ranked.normalized
FROM ranked WHERE ranked.id = r.id AND ranked.occurrence = 1 AND r.transaction_key IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_fee_payment_transaction_key
  ON fee_payment_requests (transaction_key) WHERE transaction_key IS NOT NULL;
