-- The manual as text you can search, rather than a PDF you can only open.
--
-- Every document the app holds is a PDF: the auto-found manual, the product
-- page rendered as a stand-in, and whatever a user attached themselves. That
-- is the right thing to archive and the wrong thing to look something up in —
-- "which of my modules has a gate output that goes to 8V?" is unanswerable
-- against a directory of binaries.
--
-- So each PDF is also extracted to markdown (poppler's pdftotext plus the
-- structure heuristics in services/manualText.js) and stored here, indexed for
-- postgres full-text search. One row per manuals row, not per content hash:
-- the row carries the module and the owner it was extracted for, which is what
-- decides who may search it.
--
-- Visibility follows the manuals table exactly:
--   user_id NULL     — extracted from the shared auto-found manual; every user
--                      may search and read it, like the PDF behind it.
--   user_id <set>    — extracted from a document that user uploaded, and
--                      searchable by that user alone.
CREATE TABLE manual_documents (
  id SERIAL PRIMARY KEY,
  -- The document this text came from. One extraction per document; a manual
  -- replaced by a newer revision takes its text with it (the manuals row is
  -- destroyed and recreated, and this cascades).
  manual_id INTEGER NOT NULL UNIQUE REFERENCES manuals(id) ON DELETE CASCADE,
  -- Denormalized from the manuals row so a search can filter and join without
  -- reaching through it.
  module_id INTEGER NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  -- sha256 of the PDF the text was read out of, so a document can be matched
  -- back to the file in MANUALS_DIR.
  hash TEXT NOT NULL,
  -- What the document is called at the top of the markdown ("Make Noise
  -- Maths", or "Make Noise Maths — cheat sheet" for an upload).
  title TEXT,
  content TEXT NOT NULL,
  pages INTEGER,
  chars INTEGER NOT NULL DEFAULT 0,
  -- How the text was obtained; 'pdftotext' is the only extractor today.
  source TEXT NOT NULL DEFAULT 'pdftotext',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX manual_documents_module_idx ON manual_documents (module_id);
CREATE INDEX manual_documents_user_idx ON manual_documents (user_id);
CREATE INDEX manual_documents_hash_idx ON manual_documents (hash);

-- The search index proper. A functional index rather than a stored tsvector
-- column: the same expression appears verbatim in the search query
-- (routes/manuals.js), which is what lets the planner use this index, and it
-- keeps the table free of a generated column the ORM would have to know about.
CREATE INDEX manual_documents_fts_idx
  ON manual_documents USING GIN (to_tsvector('english', content));
