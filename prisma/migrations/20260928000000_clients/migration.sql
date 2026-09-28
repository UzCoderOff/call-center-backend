-- AlterTable
ALTER TABLE "Position" ADD COLUMN "targetConsultations" INTEGER;
ALTER TABLE "Position" ADD COLUMN "targetContracts" INTEGER;

-- CreateTable
CREATE TABLE "Client" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "city" TEXT,
    "email" TEXT,
    "source" TEXT,
    "notes" TEXT,
    "nextCallAt" DATETIME,
    "nextCallNote" TEXT,
    "searchText" TEXT NOT NULL DEFAULT '',
    "archivedAt" DATETIME,
    "extra" JSONB,
    "createdById" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Client_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ClientPhone" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "clientId" INTEGER NOT NULL,
    "phone" TEXT NOT NULL,
    "phoneKey" TEXT,
    CONSTRAINT "ClientPhone_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ClientCase" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "clientId" INTEGER NOT NULL,
    "matter" TEXT,
    "number" TEXT,
    "lawyer" TEXT,
    "operatorId" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'consultation',
    "legalStage" TEXT,
    "startDate" TEXT,
    "consultationDate" TEXT,
    "contractDate" TEXT,
    "contractAmount" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ClientCase_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ClientCase_operatorId_fkey" FOREIGN KEY ("operatorId") REFERENCES "Employee" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Payment" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "clientId" INTEGER NOT NULL,
    "caseId" INTEGER,
    "amount" INTEGER NOT NULL,
    "date" TEXT NOT NULL,
    "method" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'contract',
    "note" TEXT,
    "recordedById" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Payment_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Payment_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "ClientCase" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Payment_recordedById_fkey" FOREIGN KEY ("recordedById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ClientEvent" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "clientId" INTEGER NOT NULL,
    "caseId" INTEGER,
    "kind" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "authorId" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ClientEvent_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ClientEvent_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "ClientCase" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "ClientEvent_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ClientLink" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "fromId" INTEGER NOT NULL,
    "toId" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "label" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ClientLink_fromId_fkey" FOREIGN KEY ("fromId") REFERENCES "Client" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ClientLink_toId_fkey" FOREIGN KEY ("toId") REFERENCES "Client" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "userId" INTEGER,
    "action" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entityId" INTEGER,
    "detail" JSONB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AuditLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Appointment" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "calendarId" INTEGER NOT NULL,
    "clientId" INTEGER,
    "date" TEXT NOT NULL,
    "start" INTEGER NOT NULL,
    "end" INTEGER NOT NULL,
    "clientName" TEXT NOT NULL,
    "clientPhone" TEXT,
    "phoneKey" TEXT,
    "matter" TEXT,
    "notes" TEXT,
    "status" TEXT NOT NULL DEFAULT 'booked',
    "bookedById" INTEGER NOT NULL,
    "callLogId" INTEGER,
    "cancelReason" TEXT,
    "cancelledAt" DATETIME,
    "cancelledById" INTEGER,
    "clientInformed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Appointment_calendarId_fkey" FOREIGN KEY ("calendarId") REFERENCES "Calendar" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Appointment_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Appointment_bookedById_fkey" FOREIGN KEY ("bookedById") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Appointment_callLogId_fkey" FOREIGN KEY ("callLogId") REFERENCES "CallLog" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Appointment" ("bookedById", "calendarId", "callLogId", "cancelReason", "cancelledAt", "cancelledById", "clientInformed", "clientName", "clientPhone", "createdAt", "date", "end", "id", "matter", "notes", "phoneKey", "start", "status", "updatedAt") SELECT "bookedById", "calendarId", "callLogId", "cancelReason", "cancelledAt", "cancelledById", "clientInformed", "clientName", "clientPhone", "createdAt", "date", "end", "id", "matter", "notes", "phoneKey", "start", "status", "updatedAt" FROM "Appointment";
DROP TABLE "Appointment";
ALTER TABLE "new_Appointment" RENAME TO "Appointment";
CREATE INDEX "Appointment_calendarId_date_idx" ON "Appointment"("calendarId", "date");
CREATE INDEX "Appointment_phoneKey_idx" ON "Appointment"("phoneKey");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "Client_nextCallAt_idx" ON "Client"("nextCallAt");

-- CreateIndex
CREATE INDEX "Client_name_idx" ON "Client"("name");

-- CreateIndex
CREATE INDEX "Client_archivedAt_idx" ON "Client"("archivedAt");

-- CreateIndex
CREATE INDEX "ClientPhone_phoneKey_idx" ON "ClientPhone"("phoneKey");

-- CreateIndex
CREATE INDEX "ClientPhone_clientId_idx" ON "ClientPhone"("clientId");

-- CreateIndex
CREATE INDEX "ClientCase_clientId_idx" ON "ClientCase"("clientId");

-- CreateIndex
CREATE INDEX "ClientCase_operatorId_consultationDate_idx" ON "ClientCase"("operatorId", "consultationDate");

-- CreateIndex
CREATE INDEX "ClientCase_operatorId_contractDate_idx" ON "ClientCase"("operatorId", "contractDate");

-- CreateIndex
CREATE INDEX "Payment_clientId_idx" ON "Payment"("clientId");

-- CreateIndex
CREATE INDEX "Payment_caseId_idx" ON "Payment"("caseId");

-- CreateIndex
CREATE INDEX "ClientEvent_clientId_createdAt_idx" ON "ClientEvent"("clientId", "createdAt");

-- CreateIndex
CREATE INDEX "ClientLink_toId_idx" ON "ClientLink"("toId");

-- CreateIndex
CREATE UNIQUE INDEX "ClientLink_fromId_toId_kind_key" ON "ClientLink"("fromId", "toId", "kind");

-- CreateIndex
CREATE INDEX "AuditLog_entity_entityId_idx" ON "AuditLog"("entity", "entityId");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

