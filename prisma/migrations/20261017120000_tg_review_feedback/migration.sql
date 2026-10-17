-- The AI review of the clients' Telegram learns from the firm (2026-10-17):
-- the kind of chat (new lead / existing client / not relevant), the facts
-- Ledger gave the AI, and a manager's check of each review. Adds columns
-- only.

-- AlterTable
ALTER TABLE "TgReview" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'lead';
ALTER TABLE "TgReview" ADD COLUMN "facts" JSONB;
ALTER TABLE "TgReview" ADD COLUMN "feedback" TEXT;
ALTER TABLE "TgReview" ADD COLUMN "feedbackKind" TEXT;
ALTER TABLE "TgReview" ADD COLUMN "feedbackNote" TEXT;
ALTER TABLE "TgReview" ADD COLUMN "feedbackById" INTEGER REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "TgReview" ADD COLUMN "feedbackAt" DATETIME;

-- Earlier reviews that said "not about the firm's work".
UPDATE "TgReview" SET "kind" = 'not_relevant' WHERE "relevant" = false;

-- CreateIndex
CREATE INDEX "TgReview_feedbackAt_idx" ON "TgReview"("feedbackAt");
