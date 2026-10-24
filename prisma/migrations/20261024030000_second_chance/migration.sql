-- A thinking caller's day to talk again (and their reminder); a lost caller handed
-- to another operator for a second try (services/callOutcomes.js).
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_CallOutcome" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "phoneKey" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "note" TEXT,
    "employeeId" INTEGER,
    "followUpOn" TEXT,
    "reminderId" INTEGER,
    "secondEmployeeId" INTEGER,
    "secondAt" DATETIME,
    "secondTaskId" INTEGER,
    "createdById" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "CallOutcome_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "CallOutcome_secondEmployeeId_fkey" FOREIGN KEY ("secondEmployeeId") REFERENCES "Employee" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "CallOutcome_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_CallOutcome" ("createdAt", "createdById", "employeeId", "id", "note", "outcome", "phoneKey", "updatedAt") SELECT "createdAt", "createdById", "employeeId", "id", "note", "outcome", "phoneKey", "updatedAt" FROM "CallOutcome";
DROP TABLE "CallOutcome";
ALTER TABLE "new_CallOutcome" RENAME TO "CallOutcome";
CREATE UNIQUE INDEX "CallOutcome_phoneKey_key" ON "CallOutcome"("phoneKey");
CREATE INDEX "CallOutcome_employeeId_createdAt_idx" ON "CallOutcome"("employeeId", "createdAt");
CREATE INDEX "CallOutcome_secondEmployeeId_secondAt_idx" ON "CallOutcome"("secondEmployeeId", "secondAt");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

