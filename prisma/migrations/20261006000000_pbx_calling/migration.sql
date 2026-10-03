-- Ledger's own phone line: who has calling on, their extension, and where a
-- call came from. Only adds: no table is rebuilt, nobody's calls change
-- (every existing call is "phone").
ALTER TABLE "Employee" ADD COLUMN "pbxCalling" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "PbxExtension" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "employeeId" INTEGER NOT NULL,
    "ext" TEXT NOT NULL,
    "ha1Enc" TEXT,
    "secretDeviceId" INTEGER,
    "secretIssuedAt" DATETIME,
    "canCallOut" BOOLEAN NOT NULL DEFAULT true,
    "lastWakeAt" DATETIME,
    "wakeFailStreak" INTEGER NOT NULL DEFAULT 0,
    "restingUntil" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "PbxExtension_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "PbxExtension_employeeId_key" ON "PbxExtension"("employeeId");
CREATE UNIQUE INDEX "PbxExtension_ext_key" ON "PbxExtension"("ext");

ALTER TABLE "CallLog" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'phone';
ALTER TABLE "CallLog" ADD COLUMN "pbxCallId" TEXT;
ALTER TABLE "CallLog" ADD COLUMN "pbxDetail" JSONB;
CREATE UNIQUE INDEX "CallLog_pbxCallId_key" ON "CallLog"("pbxCallId");
