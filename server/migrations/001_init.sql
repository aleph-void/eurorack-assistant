CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  is_admin BOOLEAN NOT NULL DEFAULT FALSE,
  must_change_password BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  id SERIAL PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE app_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Modules are shared records: the manual and its analysis are found once and
-- reused by every user who has the module. user_modules maps users to the
-- modules in their systems (with their per-user quantity).
CREATE TABLE modules (
  id SERIAL PRIMARY KEY,
  manufacturer TEXT NOT NULL,
  name TEXT NOT NULL,
  manual_status TEXT NOT NULL DEFAULT 'pending',
  analysis_status TEXT NOT NULL DEFAULT 'pending',
  summary TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (manufacturer, name)
);

-- PDF documents on disk (in MANUALS_DIR), mapped to modules. A module can
-- have several: user_id NULL marks the shared auto-found manual, while rows
-- with a user_id are private documents that user attached to their own module
-- instance (invisible to other users).
CREATE TABLE manuals (
  id SERIAL PRIMARY KEY,
  module_id INTEGER NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  original_name TEXT,
  source TEXT NOT NULL DEFAULT 'found',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE user_modules (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  module_id INTEGER NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
  quantity INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, module_id)
);

CREATE TABLE module_components (
  id SERIAL PRIMARY KEY,
  module_id INTEGER NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  voltage_min REAL,
  voltage_max REAL,
  polarity TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Per-user notes. A note can be attached to any number of the user's modules
-- and module components (and reused across them).
CREATE TABLE notes (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT,
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE note_modules (
  note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  module_id INTEGER NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
  PRIMARY KEY (note_id, module_id)
);

CREATE TABLE note_components (
  note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  component_id INTEGER NOT NULL REFERENCES module_components(id) ON DELETE CASCADE,
  PRIMARY KEY (note_id, component_id)
);

CREATE TABLE questions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  prompt TEXT NOT NULL,
  answer TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  answered_at TIMESTAMPTZ
);

CREATE TABLE question_modules (
  question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  module_id INTEGER NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
  PRIMARY KEY (question_id, module_id)
);

CREATE TABLE question_components (
  question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  component_id INTEGER NOT NULL REFERENCES module_components(id) ON DELETE CASCADE,
  PRIMARY KEY (question_id, component_id)
);

CREATE TABLE jobs (
  id SERIAL PRIMARY KEY,
  type TEXT NOT NULL,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  module_id INTEGER REFERENCES modules(id) ON DELETE CASCADE,
  question_id INTEGER REFERENCES questions(id) ON DELETE CASCADE,
  payload TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
