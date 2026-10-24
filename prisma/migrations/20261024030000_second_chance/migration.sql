-- A thinking caller's day to talk again (and their reminder); a lost caller handed
-- to another operator for a second try (services/callOutcomes.js). Columns added
-- in place: the table isn't rebuilt.
ALTER TABLE "CallOutcome" ADD COLUMN "followUpOn" TEXT;
ALTER TABLE "CallOutcome" ADD COLUMN "reminderId" INTEGER;
ALTER TABLE "CallOutcome" ADD COLUMN "secondEmployeeId" INTEGER CONSTRAINT "CallOutcome_secondEmployeeId_fkey" REFERENCES "Employee" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CallOutcome" ADD COLUMN "secondAt" DATETIME;
ALTER TABLE "CallOutcome" ADD COLUMN "secondTaskId" INTEGER;
CREATE INDEX "CallOutcome_secondEmployeeId_secondAt_idx" ON "CallOutcome"("secondEmployeeId", "secondAt");
