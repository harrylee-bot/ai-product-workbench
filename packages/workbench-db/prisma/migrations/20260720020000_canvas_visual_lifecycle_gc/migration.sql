-- Candidate scans are frequent and must not turn expired visual cleanup into
-- a full table scan as the short-lived capability table grows.
CREATE INDEX "canvas_visual_capabilities_status_storage_deleted_expires_idx"
  ON "canvas_visual_capabilities" ("status", "storage_deleted_at", "expires_at");
