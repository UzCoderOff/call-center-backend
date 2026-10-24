-- "Listens to calls" switch (boss and lawyer accounts): sees the client calls
-- going on right now on Ledger's line and may listen to them live
-- (src/services/pbx/live.js). The DEVELOPER always may.
ALTER TABLE "User" ADD COLUMN "hearsCalls" BOOLEAN NOT NULL DEFAULT false;
