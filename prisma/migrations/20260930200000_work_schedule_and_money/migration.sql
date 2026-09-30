-- Work patterns, holidays and days off; contract payment schedules; cash
-- handed over. Only additions: new tables, and plain ADD COLUMNs on staff and
-- positions (those tables are not rebuilt; nothing existing is changed except
-- the one default below).

-- When people work: Monday–Saturday with public holidays off by default…
ALTER TABLE "Employee" ADD COLUMN "workDays" TEXT NOT NULL DEFAULT '123456';
ALTER TABLE "Employee" ADD COLUMN "holidaysOff" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Position" ADD COLUMN "workDays" TEXT NOT NULL DEFAULT '123456';
ALTER TABLE "Position" ADD COLUMN "holidaysOff" BOOLEAN NOT NULL DEFAULT true;

-- …but call-center staff (their calls are collected — they work from their
-- own phone) every day, holidays included. Changeable per person afterwards.
UPDATE "Employee" SET "workDays" = '1234567', "holidaysOff" = false WHERE "collectCalls" = true;
UPDATE "Position" SET "workDays" = '1234567', "holidaysOff" = false WHERE "collectCalls" = true;

-- CreateTable
CREATE TABLE "Holiday" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "date" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'suggested',
    "confirmedById" INTEGER,
    "confirmedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Holiday_confirmedById_fkey" FOREIGN KEY ("confirmedById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Absence" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "employeeId" INTEGER NOT NULL,
    "from" TEXT NOT NULL,
    "to" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "note" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "requestedById" INTEGER,
    "decidedById" INTEGER,
    "decidedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Absence_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Absence_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Absence_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CaseInstallment" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "caseId" INTEGER NOT NULL,
    "dueDate" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CaseInstallment_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "ClientCase" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CashHandover" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "userId" INTEGER NOT NULL,
    "amount" INTEGER NOT NULL,
    "date" TEXT NOT NULL,
    "note" TEXT,
    "receivedById" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CashHandover_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "CashHandover_receivedById_fkey" FOREIGN KEY ("receivedById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "Holiday_date_key" ON "Holiday"("date");
CREATE INDEX "Absence_employeeId_from_idx" ON "Absence"("employeeId", "from");
CREATE INDEX "Absence_status_idx" ON "Absence"("status");
CREATE INDEX "CaseInstallment_caseId_idx" ON "CaseInstallment"("caseId");
CREATE INDEX "CaseInstallment_dueDate_idx" ON "CaseInstallment"("dueDate");
CREATE INDEX "CashHandover_userId_date_idx" ON "CashHandover"("userId", "date");
