-- More lawyers on a case; lawyers' own calendars. Adds tables only.

-- CreateTable
CREATE TABLE "CaseExtraLawyer" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "caseId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "addedById" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CaseExtraLawyer_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "ClientCase" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "CaseExtraLawyer_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "CaseExtraLawyer_addedById_fkey" FOREIGN KEY ("addedById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PersonalEvent" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "ownerId" INTEGER NOT NULL,
    "date" TEXT NOT NULL,
    "start" INTEGER,
    "end" INTEGER,
    "kind" TEXT NOT NULL DEFAULT 'meeting',
    "title" TEXT NOT NULL,
    "place" TEXT,
    "note" TEXT,
    "caseId" INTEGER,
    "createdById" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "deletedAt" DATETIME,
    CONSTRAINT "PersonalEvent_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PersonalEvent_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "ClientCase" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "PersonalEvent_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "CaseExtraLawyer_caseId_userId_key" ON "CaseExtraLawyer"("caseId", "userId");

-- CreateIndex
CREATE INDEX "CaseExtraLawyer_userId_idx" ON "CaseExtraLawyer"("userId");

-- CreateIndex
CREATE INDEX "PersonalEvent_ownerId_date_idx" ON "PersonalEvent"("ownerId", "date");
