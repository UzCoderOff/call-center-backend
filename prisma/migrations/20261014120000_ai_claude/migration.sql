-- Ledger AI on Claude (2026-10-14): what Claude read in a client's file, and
-- the suggestions from the weekly look at every open client.
--
-- Only adds columns and a table.

ALTER TABLE "ClientFile" ADD COLUMN "aiAnalysis" JSONB;
ALTER TABLE "ClientFile" ADD COLUMN "aiAnalyzedAt" DATETIME;

CREATE TABLE "AiSuggestion" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "clientId" INTEGER,
    "forUserId" INTEGER,
    "kind" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 2,
    "text" TEXT NOT NULL,
    "why" TEXT,
    "runId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "doneAt" DATETIME,
    "dismissedAt" DATETIME,
    CONSTRAINT "AiSuggestion_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AiSuggestion_forUserId_fkey" FOREIGN KEY ("forUserId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "AiSuggestion_forUserId_doneAt_dismissedAt_idx" ON "AiSuggestion"("forUserId", "doneAt", "dismissedAt");
CREATE INDEX "AiSuggestion_runId_idx" ON "AiSuggestion"("runId");
