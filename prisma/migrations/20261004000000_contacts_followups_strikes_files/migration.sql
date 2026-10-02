-- Connected people (ClientContact), what has to happen next with a client
-- (ClientFollowUp), late call-back strikes (Strike), firm-wide rules
-- (Setting), files kept on clients (ClientFile), and why a consultation
-- didn't continue (ClientCase.lostReason / lostNote).
--
-- Only adds: new tables and two empty columns. One fill-in at the end: every
-- client's planned "next call" becomes an open follow-up (nothing is lost;
-- Client.nextCallAt stays as it is).

-- AlterTable
ALTER TABLE "ClientCase" ADD COLUMN "lostNote" TEXT;
ALTER TABLE "ClientCase" ADD COLUMN "lostReason" TEXT;

-- CreateTable
CREATE TABLE "ClientContact" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "clientId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "relation" TEXT NOT NULL,
    "phone" TEXT,
    "phoneKey" TEXT,
    "note" TEXT,
    "decides" BOOLEAN NOT NULL DEFAULT false,
    "createdById" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "deletedAt" DATETIME,
    CONSTRAINT "ClientContact_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ClientContact_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ClientFollowUp" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "clientId" INTEGER NOT NULL,
    "caseId" INTEGER,
    "contactId" INTEGER,
    "kind" TEXT NOT NULL,
    "dueAt" DATETIME NOT NULL,
    "note" TEXT,
    "assigneeId" INTEGER,
    "createdById" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'open',
    "outcome" TEXT,
    "outcomeNote" TEXT,
    "doneAt" DATETIME,
    "doneById" INTEGER,
    "remindedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ClientFollowUp_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ClientFollowUp_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "ClientCase" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "ClientFollowUp_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "ClientContact" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "ClientFollowUp_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "ClientFollowUp_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "ClientFollowUp_doneById_fkey" FOREIGN KEY ("doneById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Strike" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "employeeId" INTEGER NOT NULL,
    "callLogId" INTEGER NOT NULL,
    "month" TEXT NOT NULL,
    "missedAt" DATETIME NOT NULL,
    "deadlineAt" DATETIME NOT NULL,
    "answeredAt" DATETIME,
    "cancelledAt" DATETIME,
    "cancelledById" INTEGER,
    "cancelReason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Strike_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Strike_callLogId_fkey" FOREIGN KEY ("callLogId") REFERENCES "CallLog" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Strike_cancelledById_fkey" FOREIGN KEY ("cancelledById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Setting" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "value" JSONB NOT NULL,
    "updatedById" INTEGER,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Setting_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ClientFile" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "clientId" INTEGER NOT NULL,
    "caseId" INTEGER,
    "kind" TEXT NOT NULL,
    "title" TEXT,
    "name" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "uploadedById" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" DATETIME,
    CONSTRAINT "ClientFile_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ClientFile_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "ClientCase" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "ClientFile_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "ClientContact_clientId_idx" ON "ClientContact"("clientId");

-- CreateIndex
CREATE INDEX "ClientContact_phoneKey_idx" ON "ClientContact"("phoneKey");

-- CreateIndex
CREATE INDEX "ClientFollowUp_assigneeId_status_dueAt_idx" ON "ClientFollowUp"("assigneeId", "status", "dueAt");

-- CreateIndex
CREATE INDEX "ClientFollowUp_clientId_status_idx" ON "ClientFollowUp"("clientId", "status");

-- CreateIndex
CREATE INDEX "ClientFollowUp_status_dueAt_idx" ON "ClientFollowUp"("status", "dueAt");

-- CreateIndex
CREATE UNIQUE INDEX "Strike_callLogId_key" ON "Strike"("callLogId");

-- CreateIndex
CREATE INDEX "Strike_employeeId_month_idx" ON "Strike"("employeeId", "month");

-- CreateIndex
CREATE INDEX "ClientFile_clientId_idx" ON "ClientFile"("clientId");

-- CreateIndex
CREATE INDEX "ClientFile_caseId_idx" ON "ClientFile"("caseId");


-- Each planned next call -> an open follow-up, for the person working on the
-- client (the operator of their latest case, else whoever added them).
INSERT INTO "ClientFollowUp" ("clientId", "kind", "dueAt", "note", "assigneeId", "createdById", "status", "createdAt", "updatedAt")
SELECT c."id",
       'call',
       c."nextCallAt",
       c."nextCallNote",
       COALESCE(
           (SELECT e."userId" FROM "ClientCase" k JOIN "Employee" e ON e."id" = k."operatorId" WHERE k."clientId" = c."id" AND e."userId" IS NOT NULL ORDER BY k."updatedAt" DESC LIMIT 1),
           c."createdById"
       ),
       c."createdById",
       'open',
       CAST(strftime('%s', 'now') AS INTEGER) * 1000,
       CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM "Client" c
WHERE c."nextCallAt" IS NOT NULL;
