-- What Natijalar measures a person on (auto | client | office). One new
-- column with a default: everyone stays "auto", nothing else changes.
ALTER TABLE "Employee" ADD COLUMN "workKind" TEXT NOT NULL DEFAULT 'auto';
