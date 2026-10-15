-- Cash: who took the money (Kassa, src/services/cash.js) when it isn't
-- whoever recorded the payment — an operator records the fee, the client
-- pays the boss or the lawyer in the office. Adds a column only.

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN "cashHolderId" INTEGER REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "Payment_cashHolderId_idx" ON "Payment"("cashHolderId");
