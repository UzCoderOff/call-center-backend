-- Per-person monthly targets on any measure (Natijalar). A new table:
-- nothing existing changes.
CREATE TABLE "Target" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "employeeId" INTEGER NOT NULL,
    "metric" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "fromMonth" TEXT NOT NULL,
    "setById" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Target_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Target_setById_fkey" FOREIGN KEY ("setById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "Target_employeeId_metric_fromMonth_key" ON "Target"("employeeId", "metric", "fromMonth");
