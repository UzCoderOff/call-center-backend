-- CreateTable
CREATE TABLE "User" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "username" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "mustChangePassword" BOOLEAN NOT NULL DEFAULT true,
    "passwordChangedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Employee" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "employeeId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phoneNumber" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "userId" INTEGER,
    "customFields" JSONB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Employee_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CallLog" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "employeeId" INTEGER NOT NULL,
    "deviceCallLogId" TEXT NOT NULL,
    "phoneNumber" TEXT NOT NULL,
    "callType" TEXT NOT NULL,
    "missed" BOOLEAN NOT NULL,
    "callTimestampMs" BIGINT NOT NULL,
    "durationSeconds" INTEGER NOT NULL,
    "recordingFilename" TEXT,
    "recordingPath" TEXT,
    "logIntegrityFlag" TEXT,
    "syncedAtMs" BIGINT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CallLog_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Transcript" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "callLogId" INTEGER NOT NULL,
    "text" TEXT,
    "language" TEXT,
    "provider" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "errorMessage" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Transcript_callLogId_fkey" FOREIGN KEY ("callLogId") REFERENCES "CallLog" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CallAnalysis" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "callLogId" INTEGER NOT NULL,
    "summary" TEXT,
    "whatWentWrong" TEXT,
    "improvementAreas" TEXT,
    "score" INTEGER,
    "model" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "errorMessage" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "CallAnalysis_callLogId_fkey" FOREIGN KEY ("callLogId") REFERENCES "CallLog" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

-- CreateIndex
CREATE UNIQUE INDEX "Employee_employeeId_key" ON "Employee"("employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "Employee_userId_key" ON "Employee"("userId");

-- CreateIndex
CREATE INDEX "CallLog_employeeId_callTimestampMs_idx" ON "CallLog"("employeeId", "callTimestampMs");

-- CreateIndex
CREATE UNIQUE INDEX "CallLog_employeeId_deviceCallLogId_key" ON "CallLog"("employeeId", "deviceCallLogId");

-- CreateIndex
CREATE UNIQUE INDEX "Transcript_callLogId_key" ON "Transcript"("callLogId");

-- CreateIndex
CREATE UNIQUE INDEX "CallAnalysis_callLogId_key" ON "CallAnalysis"("callLogId");
