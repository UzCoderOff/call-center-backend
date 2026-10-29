-- Court hearings from sud.uz (2026-10-29): the court a case is in, hearings
-- kept in step with the court's lists, and "is this our client?" questions.
-- Adds columns and one table only.

-- AlterTable
ALTER TABLE "ClientCase" ADD COLUMN "courtKey" TEXT;
ALTER TABLE "CaseDate" ADD COLUMN "sudKey" TEXT;
ALTER TABLE "CaseDate" ADD COLUMN "sudSeenAt" DATETIME;

-- CreateTable
CREATE TABLE "CourtFind" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "caseId" INTEGER NOT NULL,
    "courtKey" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "time" INTEGER,
    "judge" TEXT,
    "stage" TEXT,
    "instance" TEXT,
    "category" TEXT,
    "side" TEXT,
    "parties" JSONB,
    "state" TEXT NOT NULL DEFAULT 'asking',
    "answeredById" INTEGER,
    "answeredAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "CourtFind_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "ClientCase" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "CourtFind_answeredById_fkey" FOREIGN KEY ("answeredById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "CourtFind_caseId_number_key" ON "CourtFind"("caseId", "number");
CREATE INDEX "CourtFind_state_idx" ON "CourtFind"("state");
