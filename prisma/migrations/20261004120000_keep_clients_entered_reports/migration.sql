-- A client kept out of the automatic archive until a date, and who filled in
-- a report for someone who missed it. Two empty columns: nothing changes.
ALTER TABLE "Client" ADD COLUMN "keepUntil" DATETIME;
ALTER TABLE "Report" ADD COLUMN "enteredById" INTEGER REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
