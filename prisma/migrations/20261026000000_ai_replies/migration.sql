-- The firm's Instagram in the same inbox as its Telegram (TgChat.platform;
-- Instagram's message ids are text: TgMessage.extId), and the AI that answers
-- new people (TgChat.ai*, TgMessage.ai) — services/igInbox.js, services/aiReply.
-- Existing chats stay Telegram. The chat review gets flags (legal answer, wrong
-- price, text that looks pasted) — TgReview.flags.

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_TgChat" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "platform" TEXT NOT NULL DEFAULT 'telegram',
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
    "aiState" TEXT,
    "aiStage" TEXT,
    "aiLead" JSONB,
    "aiNote" TEXT,
    "aiAt" DATETIME,
    "aiPausedUntil" DATETIME,
    "aiDraft" TEXT,
    "aiDraftFor" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "TgChat_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_TgChat" ("aiHidden", "autoLink", "clientId", "connectionId", "createdAt", "firstName", "hidden", "id", "lastInAt", "lastMessageAt", "lastName", "lastOutAt", "phone", "phoneKey", "reviewedAt", "tgUserId", "topic", "updatedAt", "username", "waitingSince") SELECT "aiHidden", "autoLink", "clientId", "connectionId", "createdAt", "firstName", "hidden", "id", "lastInAt", "lastMessageAt", "lastName", "lastOutAt", "phone", "phoneKey", "reviewedAt", "tgUserId", "topic", "updatedAt", "username", "waitingSince" FROM "TgChat";
DROP TABLE "TgChat";
ALTER TABLE "new_TgChat" RENAME TO "TgChat";
CREATE INDEX "TgChat_clientId_idx" ON "TgChat"("clientId");
CREATE INDEX "TgChat_lastMessageAt_idx" ON "TgChat"("lastMessageAt");
CREATE INDEX "TgChat_phoneKey_idx" ON "TgChat"("phoneKey");
CREATE UNIQUE INDEX "TgChat_platform_tgUserId_key" ON "TgChat"("platform", "tgUserId");
CREATE TABLE "new_TgMessage" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "chatId" INTEGER NOT NULL,
    "tgMessageId" INTEGER,
    "extId" TEXT,
    "out" BOOLEAN NOT NULL DEFAULT false,
    "auto" BOOLEAN NOT NULL DEFAULT false,
    "ai" BOOLEAN NOT NULL DEFAULT false,
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
INSERT INTO "new_TgMessage" ("answeredById", "auto", "chatId", "createdAt", "deletedAt", "duration", "editedAt", "fileId", "fileName", "id", "kind", "out", "sentAt", "text", "tgMessageId") SELECT "answeredById", "auto", "chatId", "createdAt", "deletedAt", "duration", "editedAt", "fileId", "fileName", "id", "kind", "out", "sentAt", "text", "tgMessageId" FROM "TgMessage";
DROP TABLE "TgMessage";
ALTER TABLE "new_TgMessage" RENAME TO "TgMessage";
CREATE INDEX "TgMessage_chatId_sentAt_idx" ON "TgMessage"("chatId", "sentAt");
CREATE UNIQUE INDEX "TgMessage_chatId_tgMessageId_key" ON "TgMessage"("chatId", "tgMessageId");
CREATE UNIQUE INDEX "TgMessage_chatId_extId_key" ON "TgMessage"("chatId", "extId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;


-- AlterTable
ALTER TABLE "TgReview" ADD COLUMN "flags" JSONB;
