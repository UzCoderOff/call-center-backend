-- Who does what (Employee.job, Position.job), the coordinator on a case, a
-- case's court and closing date, its stage history and key dates, and
-- edit/remove marks on timeline entries.
--
-- Only adds columns and tables: no existing table is rebuilt and no existing
-- value changes. Two fill-ins at the end: each person's (and position's) job
-- from their current settings, and one stage-history row for every case
-- that already has a stage.

ALTER TABLE "Employee" ADD COLUMN "job" TEXT NOT NULL DEFAULT 'other';
ALTER TABLE "Position" ADD COLUMN "job" TEXT NOT NULL DEFAULT 'other';
ALTER TABLE "ClientCase" ADD COLUMN "coordinatorId" INTEGER REFERENCES "Employee" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ClientCase" ADD COLUMN "court" TEXT;
ALTER TABLE "ClientCase" ADD COLUMN "closedDate" TEXT;
ALTER TABLE "ClientEvent" ADD COLUMN "data" JSONB;
ALTER TABLE "ClientEvent" ADD COLUMN "deletedAt" DATETIME;
ALTER TABLE "ClientEvent" ADD COLUMN "editedAt" DATETIME;

CREATE TABLE "CaseStage" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "caseId" INTEGER NOT NULL,
    "stage" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "court" TEXT,
    "note" TEXT,
    "createdById" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "deletedAt" DATETIME,
    CONSTRAINT "CaseStage_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "ClientCase" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "CaseStage_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE "CaseDate" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "caseId" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "time" INTEGER,
    "title" TEXT,
    "place" TEXT,
    "note" TEXT,
    "outcome" TEXT,
    "createdById" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "deletedAt" DATETIME,
    CONSTRAINT "CaseDate_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "ClientCase" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "CaseDate_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "ClientCase_coordinatorId_idx" ON "ClientCase"("coordinatorId");
CREATE INDEX "CaseStage_caseId_date_idx" ON "CaseStage"("caseId", "date");
CREATE INDEX "CaseDate_caseId_date_idx" ON "CaseDate"("caseId", "date");
CREATE INDEX "CaseDate_date_idx" ON "CaseDate"("date");

-- Each person's job from what they do now — the rule Natijalar guessed by:
-- set explicitly (workKind), books consultations, or a monitored phone with
-- the automatic report alone -> call center; a report form to fill in ->
-- office; anyone else -> other. The developer can change it afterwards.
UPDATE "Employee" SET "job" = CASE
    WHEN "workKind" = 'client' THEN 'call_center'
    WHEN "workKind" = 'office' THEN 'office'
    WHEN "calendarAccess" = 'book' THEN 'call_center'
    WHEN "collectCalls" = 1 AND "autoReport" = 1 AND "alsoForm" = 0 THEN 'call_center'
    WHEN "reportTemplateId" IS NOT NULL AND ("autoReport" = 0 OR "alsoForm" = 1) THEN 'office'
    ELSE 'other'
END;

UPDATE "Position" SET "job" = CASE
    WHEN "calendarAccess" = 'book' THEN 'call_center'
    WHEN "collectCalls" = 1 AND "autoReport" = 1 AND "alsoForm" = 0 THEN 'call_center'
    WHEN "reportTemplateId" IS NOT NULL THEN 'office'
    ELSE 'other'
END;

-- A case that already has a stage gets it as its first history row, dated
-- when the stage was last set in Ledger (else the contract or start date).
-- The date is approximate; it can be corrected on the case.
INSERT INTO "CaseStage" ("caseId", "stage", "date", "note", "createdAt", "updatedAt")
SELECT c."id",
       c."legalStage",
       COALESCE(
           (SELECT strftime('%Y-%m-%d', MAX(e."createdAt") / 1000 + 18000, 'unixepoch') FROM "ClientEvent" e WHERE e."caseId" = c."id" AND e."kind" = 'stage'),
           c."contractDate",
           c."startDate",
           strftime('%Y-%m-%d', c."createdAt" / 1000 + 18000, 'unixepoch')
       ),
       'Sana taxminiy: bosqich Ledgerda shu kuni belgilangan',
       CAST(strftime('%s', 'now') AS INTEGER) * 1000,
       CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM "ClientCase" c
WHERE c."legalStage" IS NOT NULL;
