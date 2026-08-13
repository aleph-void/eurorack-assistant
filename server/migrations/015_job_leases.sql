-- Job leases. A 'running' row used to be a promise nobody kept: when the
-- server process died mid-job (a deploy recreating the container is enough)
-- the row stayed 'running' forever, its module stayed 'analyzing' forever, and
-- the dedupe guards in the worker refused to queue the work again.
-- The worker now stamps a lease on every job it claims and refreshes
-- heartbeat_at while it works, so a job whose heartbeat has gone quiet can be
-- told apart from one that is genuinely still running, and put back.

ALTER TABLE jobs ADD COLUMN started_at TIMESTAMPTZ;
ALTER TABLE jobs ADD COLUMN heartbeat_at TIMESTAMPTZ;
ALTER TABLE jobs ADD COLUMN worker_id TEXT;

CREATE INDEX jobs_status_heartbeat_idx ON jobs (status, heartbeat_at);
