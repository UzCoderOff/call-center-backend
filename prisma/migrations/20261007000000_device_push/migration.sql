-- The Google push address of each phone's Ledger app. Two empty columns.
ALTER TABLE "Device" ADD COLUMN "fcmToken" TEXT;
ALTER TABLE "Device" ADD COLUMN "fcmTokenAt" DATETIME;
