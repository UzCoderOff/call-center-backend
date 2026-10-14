-- The boss's feedback (2026-10-14): a case's details, corrected payments,
-- consultation summaries ("suhbat yakuni") and the strikes for ones not
-- written in time, and Ledger AI's offers waiting for a yes.
--
-- Only adds columns and tables: no existing table is rebuilt and no existing
-- value changes.

ALTER TABLE "ClientCase" ADD COLUMN "details" TEXT;
ALTER TABLE "Payment" ADD COLUMN "editedAt" DATETIME;
ALTER TABLE "Appointment" ADD COLUMN "caseId" INTEGER REFERENCES "ClientCase" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Appointment" ADD COLUMN "summary" JSONB;
ALTER TABLE "Appointment" ADD COLUMN "summaryAt" DATETIME;
ALTER TABLE "Appointment" ADD COLUMN "summaryById" INTEGER REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Message" ADD COLUMN "data" JSONB;

CREATE INDEX "Appointment_summaryAt_idx" ON "Appointment"("summaryAt");

CREATE TABLE "SummaryStrike" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "userId" INTEGER NOT NULL,
    "appointmentId" INTEGER NOT NULL,
    "month" TEXT NOT NULL,
    "deadlineAt" DATETIME NOT NULL,
    "writtenAt" DATETIME,
    "cancelledAt" DATETIME,
    "cancelledById" INTEGER,
    "cancelReason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SummaryStrike_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SummaryStrike_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "Appointment" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SummaryStrike_cancelledById_fkey" FOREIGN KEY ("cancelledById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "SummaryStrike_appointmentId_key" ON "SummaryStrike"("appointmentId");
CREATE INDEX "SummaryStrike_userId_month_idx" ON "SummaryStrike"("userId", "month");
