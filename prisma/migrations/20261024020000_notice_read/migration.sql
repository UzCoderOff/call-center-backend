-- The bell on the home page: when the person saw each notification.
ALTER TABLE "Notice" ADD COLUMN "readAt" DATETIME;
