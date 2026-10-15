-- Clients writing to the firm's Telegram account (Telegram Business, the
-- Ledger bot connected to it as its chatbot): the chats, their messages and
-- the AI review of them (beta) — seen in Ledger (src/services/tgInbox.js,
-- tgReview.js). New tables only.

-- CreateTable
CREATE TABLE "TgChat" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "tgUserId" TEXT NOT NULL,
    "firstName" TEXT,
    "lastName" TEXT,
    "username" TEXT,
    "phone" TEXT,
    "phoneKey" TEXT,
    "clientId" INTEGER,
    "autoLink" BOOLEAN NOT NULL DEFAULT true,
    "connectionId" TEXT,
    "hidden" BOOLEAN NOT NULL DEFAULT false,
    "aiHidden" BOOLEAN NOT NULL DEFAULT false,
    "topic" TEXT,
    "reviewedAt" DATETIME,
    "lastMessageAt" DATETIME,
    "lastInAt" DATETIME,
    "lastOutAt" DATETIME,
    "waitingSince" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "TgChat_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "TgMessage" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "chatId" INTEGER NOT NULL,
    "tgMessageId" INTEGER NOT NULL,
    "out" BOOLEAN NOT NULL DEFAULT false,
    "auto" BOOLEAN NOT NULL DEFAULT false,
    "kind" TEXT NOT NULL DEFAULT 'text',
    "text" TEXT,
    "fileId" TEXT,
    "fileName" TEXT,
    "duration" INTEGER,
    "sentAt" DATETIME NOT NULL,
    "editedAt" DATETIME,
    "deletedAt" DATETIME,
    "answeredById" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TgMessage_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "TgChat" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "TgMessage_answeredById_fkey" FOREIGN KEY ("answeredById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "TgReview" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "chatId" INTEGER NOT NULL,
    "operatorId" INTEGER,
    "upToMessageId" INTEGER NOT NULL,
    "relevant" BOOLEAN NOT NULL,
    "topic" TEXT,
    "outcome" TEXT NOT NULL,
    "potential" TEXT,
    "score" INTEGER NOT NULL,
    "summary" TEXT,
    "lossReason" TEXT,
    "good" JSONB,
    "improve" JSONB,
    "betterReply" TEXT,
    "model" TEXT NOT NULL,
    "costUsd" REAL NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TgReview_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "TgChat" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "TgReview_operatorId_fkey" FOREIGN KEY ("operatorId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "TgChat_tgUserId_key" ON "TgChat"("tgUserId");

-- CreateIndex
CREATE INDEX "TgChat_clientId_idx" ON "TgChat"("clientId");

-- CreateIndex
CREATE INDEX "TgChat_lastMessageAt_idx" ON "TgChat"("lastMessageAt");

-- CreateIndex
CREATE INDEX "TgChat_phoneKey_idx" ON "TgChat"("phoneKey");

-- CreateIndex
CREATE INDEX "TgMessage_chatId_sentAt_idx" ON "TgMessage"("chatId", "sentAt");

-- CreateIndex
CREATE UNIQUE INDEX "TgMessage_chatId_tgMessageId_key" ON "TgMessage"("chatId", "tgMessageId");

-- CreateIndex
CREATE INDEX "TgReview_chatId_createdAt_idx" ON "TgReview"("chatId", "createdAt");

-- CreateIndex
CREATE INDEX "TgReview_operatorId_createdAt_idx" ON "TgReview"("operatorId", "createdAt");

