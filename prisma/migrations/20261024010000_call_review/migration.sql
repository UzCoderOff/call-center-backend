-- Calls on Ledger's line turned into text on the server (pbx/transcriber) and
-- reviewed by AI against the firm's call standard (services/callReview.js).
-- Transcript.segments: [{ who: "client" | "staff" | "mix", start, end, text }].
ALTER TABLE "Transcript" ADD COLUMN "segments" JSONB;
-- CallAnalysis: the review's details (criteria, what was good, what to
-- improve, better lines), when the operator was told, and a manager's check.
ALTER TABLE "CallAnalysis" ADD COLUMN "details" JSONB;
ALTER TABLE "CallAnalysis" ADD COLUMN "costUsd" REAL;
ALTER TABLE "CallAnalysis" ADD COLUMN "notifiedAt" DATETIME;
ALTER TABLE "CallAnalysis" ADD COLUMN "feedbackCorrect" BOOLEAN;
ALTER TABLE "CallAnalysis" ADD COLUMN "feedbackNote" TEXT;
ALTER TABLE "CallAnalysis" ADD COLUMN "feedbackById" INTEGER;
ALTER TABLE "CallAnalysis" ADD COLUMN "feedbackAt" DATETIME;
