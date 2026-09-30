-- Online or in-office consultations. A plain ADD COLUMN: the appointments
-- table is not rebuilt, and every existing appointment is "office".
ALTER TABLE "Appointment" ADD COLUMN "format" TEXT NOT NULL DEFAULT 'office';
