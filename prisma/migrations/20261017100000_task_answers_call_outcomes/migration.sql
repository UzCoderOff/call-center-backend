-- Answers on tasks, "Ledger AI" as the author of what it prepares, walk-in
-- consultations, and what came of new callers who didn't book (2026-10-17).
-- Adds columns and one table only.

-- AlterTable
ALTER TABLE "Task" ADD COLUMN "answer" TEXT;
ALTER TABLE "Task" ADD COLUMN "answeredAt" DATETIME;
ALTER TABLE "Task" ADD COLUMN "needsAnswer" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Task" ADD COLUMN "viaAi" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Reminder" ADD COLUMN "viaAi" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ClientFollowUp" ADD COLUMN "viaAi" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Appointment" ADD COLUMN "walkIn" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "CallOutcome" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "phoneKey" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "note" TEXT,
    "employeeId" INTEGER,
    "createdById" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "CallOutcome_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "CallOutcome_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "CallOutcome_phoneKey_key" ON "CallOutcome"("phoneKey");
CREATE INDEX "CallOutcome_employeeId_createdAt_idx" ON "CallOutcome"("employeeId", "createdAt");
