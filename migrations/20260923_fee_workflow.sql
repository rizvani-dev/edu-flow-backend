-- Apply this migration to existing installations before deploying fee charge fields.
ALTER TABLE fees
  ADD COLUMN IF NOT EXISTS fine_amount NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (fine_amount >= 0),
  ADD COLUMN IF NOT EXISTS other_charges NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (other_charges >= 0);

ALTER TABLE fee_structures
  ADD COLUMN IF NOT EXISTS fine_amount NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (fine_amount >= 0),
  ADD COLUMN IF NOT EXISTS other_charges NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (other_charges >= 0);

ALTER TABLE fee_payment_requests
  ADD COLUMN IF NOT EXISTS payment_method VARCHAR(20) NOT NULL DEFAULT 'online';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fee_payment_requests_payment_method_check'
      AND conrelid = 'fee_payment_requests'::regclass
  ) THEN
    ALTER TABLE fee_payment_requests
      ADD CONSTRAINT fee_payment_requests_payment_method_check CHECK (payment_method IN ('online', 'cash'));
  END IF;
END $$;
