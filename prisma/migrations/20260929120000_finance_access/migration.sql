-- Who sees money (the "Moliya" switch) and ending old sessions after a
-- password reset. Written as plain ADD COLUMNs (instead of Prisma's
-- copy-the-whole-table form) so the live User table is never rebuilt.
-- Everyone starts with the switch off: the DEVELOPER turns it on for the
-- head of the firm after deploying (see DEPLOY.md).

-- AlterTable
ALTER TABLE "User" ADD COLUMN "seesFinance" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "User" ADD COLUMN "sessionsValidAfter" DATETIME;

-- CreateIndex
CREATE INDEX "CallLog_callTimestampMs_idx" ON "CallLog"("callTimestampMs");
