-- The case as a project (2026-10-15): its tasks, typed
-- history with hearing outcomes, repeating calendar events, and covers for a
-- lawyer who is away. Adds columns and one table only.

-- AlterTable
ALTER TABLE "Task" ADD COLUMN "caseId" INTEGER REFERENCES "ClientCase" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CaseDate" ADD COLUMN "outcomeAt" DATETIME;
ALTER TABLE "CaseDate" ADD COLUMN "outcomeById" INTEGER REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PersonalEvent" ADD COLUMN "repeat" TEXT;
ALTER TABLE "PersonalEvent" ADD COLUMN "repeatUntil" TEXT;
ALTER TABLE "PersonalEvent" ADD COLUMN "skipDates" JSONB;

-- CreateTable
CREATE TABLE "LawyerCover" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "lawyerId" INTEGER NOT NULL,
    "coverId" INTEGER NOT NULL,
    "from" TEXT NOT NULL,
    "to" TEXT NOT NULL,
    "note" TEXT,
    "createdById" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" DATETIME,
    CONSTRAINT "LawyerCover_lawyerId_fkey" FOREIGN KEY ("lawyerId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "LawyerCover_coverId_fkey" FOREIGN KEY ("coverId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "LawyerCover_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- AlterTable (after LawyerCover exists)
ALTER TABLE "CaseExtraLawyer" ADD COLUMN "coverId" INTEGER REFERENCES "LawyerCover" ("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "Task_caseId_idx" ON "Task"("caseId");
CREATE INDEX "CaseExtraLawyer_coverId_idx" ON "CaseExtraLawyer"("coverId");
CREATE INDEX "LawyerCover_lawyerId_to_idx" ON "LawyerCover"("lawyerId", "to");
CREATE INDEX "LawyerCover_coverId_to_idx" ON "LawyerCover"("coverId", "to");
