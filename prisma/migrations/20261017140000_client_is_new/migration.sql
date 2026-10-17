-- Asked when a client is added (2026-10-17): a new client, or one the firm
-- already had and only now writes into Ledger. Only new ones count as new
-- clients. Everyone added before keeps counting as before. Adds a column only.

-- AlterTable
ALTER TABLE "Client" ADD COLUMN "isNew" BOOLEAN NOT NULL DEFAULT true;
