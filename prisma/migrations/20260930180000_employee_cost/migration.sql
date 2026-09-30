-- What each person costs per month, for the performance page. A new table:
-- nothing existing changes.
CREATE TABLE "EmployeeCost" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "employeeId" INTEGER NOT NULL,
    "fromMonth" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "note" TEXT,
    "setById" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EmployeeCost_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "EmployeeCost_setById_fkey" FOREIGN KEY ("setById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "EmployeeCost_employeeId_fromMonth_key" ON "EmployeeCost"("employeeId", "fromMonth");
