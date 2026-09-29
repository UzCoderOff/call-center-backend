-- The fourth daily-report choice: automatic numbers AND a report form to
-- fill in (people whose calls are counted but who do other work too).
-- Plain ADD COLUMNs, so the staff and position tables are not rebuilt;
-- everyone starts with it off — nothing changes until it's switched on.

-- AlterTable
ALTER TABLE "Employee" ADD COLUMN "alsoForm" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Position" ADD COLUMN "alsoForm" BOOLEAN NOT NULL DEFAULT false;
