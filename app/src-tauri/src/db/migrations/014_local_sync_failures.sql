CREATE TABLE registry_sync_marker_new (
  registry_id         TEXT    PRIMARY KEY REFERENCES registry(id) ON DELETE CASCADE,
  last_sync_revision  TEXT,
  last_sync_at        TEXT,
  last_sync_status    TEXT    NOT NULL DEFAULT 'never'
                      CHECK (last_sync_status IN ('never','ok','offline','empty','access_required','folder_not_found','folder_unreadable','folder_changed','snapshot_failed')),
  stale               INTEGER NOT NULL DEFAULT 0 CHECK (stale IN (0,1))
);

INSERT INTO registry_sync_marker_new SELECT * FROM registry_sync_marker;
DROP TABLE registry_sync_marker;
ALTER TABLE registry_sync_marker_new RENAME TO registry_sync_marker;
