-- Recording health: whether the app may read the phone's files (2.3.0+).
ALTER TABLE "SyncLog" ADD COLUMN "filesAccess" BOOLEAN;
