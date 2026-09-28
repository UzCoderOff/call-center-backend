-- Automatic daily reports (src/services/autoReport.js). Written by hand as
-- plain ADD COLUMNs: nothing is copied or dropped.
ALTER TABLE "Employee" ADD COLUMN "autoReport" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Position" ADD COLUMN "autoReport" BOOLEAN NOT NULL DEFAULT false;

-- From now on call-center staff (their calls are collected) get automatic
-- reports instead of filling in a form. Their report form stays set, so
-- switching it off in Team brings the form back.
UPDATE "Employee" SET "autoReport" = true WHERE "collectCalls" = true;
UPDATE "Position" SET "autoReport" = true WHERE "collectCalls" = true;
