-- Several lawyers: a name on boss/lawyer accounts, and cases assigned to a
-- lawyer account (a LAWYER account sees only those). The User table only
-- gains a column; ClientCase (new in this release, so still empty on
-- deploy) is rebuilt by Prisma to add the link.
-- AlterTable
ALTER TABLE "User" ADD COLUMN "name" TEXT;

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_ClientCase" (
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
    "lawyerId" INTEGER,
    CONSTRAINT "ClientCase_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ClientCase_operatorId_fkey" FOREIGN KEY ("operatorId") REFERENCES "Employee" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "ClientCase_lawyerId_fkey" FOREIGN KEY ("lawyerId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_ClientCase" ("clientId", "consultationDate", "contractAmount", "contractDate", "createdAt", "id", "lawyer", "legalStage", "matter", "number", "operatorId", "startDate", "status", "updatedAt") SELECT "clientId", "consultationDate", "contractAmount", "contractDate", "createdAt", "id", "lawyer", "legalStage", "matter", "number", "operatorId", "startDate", "status", "updatedAt" FROM "ClientCase";
DROP TABLE "ClientCase";
ALTER TABLE "new_ClientCase" RENAME TO "ClientCase";
CREATE INDEX "ClientCase_clientId_idx" ON "ClientCase"("clientId");
CREATE INDEX "ClientCase_operatorId_consultationDate_idx" ON "ClientCase"("operatorId", "consultationDate");
CREATE INDEX "ClientCase_operatorId_contractDate_idx" ON "ClientCase"("operatorId", "contractDate");
CREATE INDEX "ClientCase_lawyerId_idx" ON "ClientCase"("lawyerId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

