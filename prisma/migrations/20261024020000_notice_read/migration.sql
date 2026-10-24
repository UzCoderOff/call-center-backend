-- The bell on the home page: when the person saw each notification.
ALTER TABLE "Notice" ADD COLUMN "readAt" DATETIME;
-- What came before the bell counts as seen: nobody starts with 99+.
UPDATE "Notice" SET "readAt" = "createdAt";
