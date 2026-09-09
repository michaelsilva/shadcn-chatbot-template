-- #7: track whether an asset's R2 object has actually been verified to
-- exist yet. 'pending' assets (created for a presigned-upload intent, or
-- while a provider ingestion copy is in flight) are not usable until
-- finalized. Existing/future directly-created assets default to
-- 'finalized' to preserve #6's behavior for callers that already have
-- bytes in hand (e.g. document extraction content assets).

ALTER TABLE assets ADD COLUMN upload_state TEXT NOT NULL DEFAULT 'finalized';

CREATE INDEX assets_upload_state_idx ON assets (upload_state);
