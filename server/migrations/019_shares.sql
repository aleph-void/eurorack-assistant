-- Sharing. Everything a user makes — notes, patches, questions and their
-- answers, racks, uploaded documents — is private to them, which is the right
-- default and the wrong only option: people who patch together want to show
-- each other what they did.
--
-- A share is one row saying "this record of mine may be READ by that user", or
-- by everyone when user_id is NULL. Nothing here grants writing: the owner
-- remains the only one who can change or delete what they made, and revoking a
-- share is deleting the row.
--
-- resource_id is a soft reference — one table cannot carry a foreign key into
-- five others — so the readers join the resource in and skip a share whose
-- record has gone. The delete paths clear their own shares; ids are never
-- reused by a SERIAL, so a row that outlives its record can never come to
-- point at a different one.
CREATE TABLE shares (
  id SERIAL PRIMARY KEY,
  -- 'note' | 'patch' | 'question' | 'rack' | 'document'
  resource_type TEXT NOT NULL,
  resource_id INTEGER NOT NULL,
  owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- The recipient, or NULL for "everyone": a standing share that new users
  -- pick up when they are created, which is what sharing with everyone means.
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per (record, recipient). Postgres treats NULLs as distinct, so this
-- does not constrain the everyone-row; services/sharing.js writes the whole
-- recipient list for a record in one transaction, which is what keeps that one
-- unique.
CREATE UNIQUE INDEX shares_recipient_uidx
  ON shares (resource_type, resource_id, user_id);

-- "What is shared with me" and "who can see this" are the two questions asked.
CREATE INDEX shares_resource_idx ON shares (resource_type, resource_id);
CREATE INDEX shares_user_idx ON shares (user_id, resource_type);
CREATE INDEX shares_owner_idx ON shares (owner_id);
