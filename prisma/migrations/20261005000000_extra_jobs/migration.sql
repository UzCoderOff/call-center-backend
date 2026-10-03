-- A person can do more than one job: Employee.job stays the main one and
-- extraJobs lists the others ("coordinator,office"). Two new columns with a
-- default: nobody's jobs change.
ALTER TABLE "Employee" ADD COLUMN "extraJobs" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Position" ADD COLUMN "extraJobs" TEXT NOT NULL DEFAULT '';
