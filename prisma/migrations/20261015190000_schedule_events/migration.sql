-- Payment-schedule changes on a case's timeline were saved as notes; they
-- are a change of their own (kind "schedule", 2026-10-15). Relabels the old
-- ones — no table or column changes.
UPDATE "ClientEvent" SET "kind" = 'schedule' WHERE "kind" = 'note' AND "text" LIKE 'Toʻlov jadvali%';
