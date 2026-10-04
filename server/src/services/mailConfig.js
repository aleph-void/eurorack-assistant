// The mail server, as the admin sets it up.
//
// Everything the app sends — a confirmation of an address, a password reset,
// one day a word that a registration is waiting — goes out through one SMTP
// account, and this is where that account is kept: a declared list of
// settings (MAIL_SETTINGS, which is also what the admin page draws), each
// read from and written to the same `app_config` key/value table the rest of
// the configuration lives in, with the one secret among them — the SMTP
// password — encrypted at rest with the key the LLM credentials use, and
// never served back out. `public_url` is here too, because the one thing
// every mail carries is a link back into the app, and the server cannot
// know its own address from behind nginx; the Host header a request arrived
// with is whatever the sender said it was, which is no basis for a link in
// someone's inbox.
//
// services/config.js serves only ITS keys, so the rows written here never
// ride along on GET /api/config.

import { emailProblem, normalizeEmail } from '../auth.js';
import { decryptSecrets, encryptSecrets } from './llmAccounts.js';

export const MAIL_SETTINGS = [
  { key: 'mail_host', label: 'SMTP host', kind: 'text', placeholder: 'smtp.example.com' },
  { key: 'mail_port', label: 'SMTP port', kind: 'number', default: 587 },
  {
    key: 'mail_secure',
    label: 'Encrypted from the first byte (SMTPS, usually port 465)',
    kind: 'boolean',
    default: false,
  },
  { key: 'mail_user', label: 'SMTP username', kind: 'text' },
  { key: 'mail_password', label: 'SMTP password', kind: 'secret' },
  { key: 'mail_from', label: 'From address', kind: 'email', placeholder: 'rack@example.com' },
  {
    key: 'public_url',
    label: 'Public address of this app',
    kind: 'url',
    placeholder: 'https://rack.example.com',
  },
];

export const MAIL_KEYS = MAIL_SETTINGS.map((s) => s.key);

const MAX_HOST_LENGTH = 253;
const MAX_USER_LENGTH = 254;
const MAX_PASSWORD_LENGTH = 1024;

function parseBoolean(value) {
  if (typeof value === 'boolean') return value;
  const text = String(value ?? '').trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(text)) return true;
  if (['false', '0', 'no', 'off', ''].includes(text)) return false;
  return null;
}

// The stored rows, typed. The password comes back decrypted — this is the
// server's own reading, for sending; what the admin sees is mailConfigJson().
export async function getMailConfig(db, { keyOpts = {} } = {}) {
  const rows = await db.models.AppConfig.findAll();
  const stored = {};
  for (const row of rows) if (MAIL_KEYS.includes(row.key)) stored[row.key] = row.value;
  let password = '';
  if (stored.mail_password) {
    try {
      password = String(decryptSecrets(stored.mail_password, keyOpts).password ?? '');
    } catch {
      // A row written under another key is a password nobody has: the admin
      // types it again, and until then the server tries without one.
      password = '';
    }
  }
  const port = Number(stored.mail_port);
  return {
    mail_host: stored.mail_host || '',
    mail_port: Number.isInteger(port) && port > 0 ? port : 587,
    mail_secure: parseBoolean(stored.mail_secure) === true,
    mail_user: stored.mail_user || '',
    mail_password: password,
    mail_from: stored.mail_from || '',
    public_url: stored.public_url || '',
  };
}

// Why nothing can be sent yet, or null when it can.
export function mailConfigProblem(config) {
  if (!config.mail_host) return 'the SMTP host is not set';
  if (!config.mail_from) return 'the From address is not set';
  if (!config.public_url) return 'the public address of this app is not set';
  return null;
}

// The admin's view: every setting but the password, and whether one is kept.
export function mailConfigJson(config) {
  const { mail_password, ...rest } = config;
  return {
    ...rest,
    mail_password_set: mail_password !== '',
    problem: mailConfigProblem(config),
    settings: MAIL_SETTINGS,
  };
}

// Where a link in a mail points. The stored URL has no trailing slash.
export function publicLink(config, path) {
  return `${config.public_url}${path.startsWith('/') ? '' : '/'}${path}`;
}

function cleanValue(key, raw) {
  switch (key) {
    case 'mail_host': {
      const host = String(raw ?? '').trim();
      if (host.length > MAX_HOST_LENGTH || /[\s/@:]/.test(host)) {
        throw new Error('Invalid mail_host: a host name, with no scheme, port or path');
      }
      return host;
    }
    case 'mail_port': {
      const n = Number(raw);
      if (typeof raw === 'boolean' || String(raw).trim() === '' || !Number.isInteger(n) || n < 1 || n > 65535) {
        throw new Error('Invalid mail_port: a port number from 1 to 65535');
      }
      return String(n);
    }
    case 'mail_secure': {
      const flag = parseBoolean(raw);
      if (flag === null) throw new Error('Invalid mail_secure: true or false');
      return String(flag);
    }
    case 'mail_user': {
      const user = String(raw ?? '').trim();
      if (user.length > MAX_USER_LENGTH) throw new Error('Invalid mail_user: too long');
      return user;
    }
    case 'mail_from': {
      const from = normalizeEmail(raw);
      if (from === null) return '';
      const problem = emailProblem(from);
      if (problem) throw new Error(`Invalid mail_from: ${problem}`);
      return from;
    }
    case 'public_url': {
      const text = String(raw ?? '').trim();
      if (text === '') return '';
      let url;
      try {
        url = new URL(text);
      } catch {
        throw new Error('Invalid public_url: must be a full address such as https://rack.example.com');
      }
      if (!['http:', 'https:'].includes(url.protocol) || url.search || url.hash || url.username) {
        throw new Error('Invalid public_url: http or https, with no query, fragment or credentials');
      }
      return url.href.replace(/\/+$/, '');
    }
    default:
      throw new Error(`Unknown mail setting: ${key}`);
  }
}

// Writes the settings given and leaves the rest. The password is the one
// field where "not mentioned" and "blank" differ: undefined keeps the stored
// one, '' removes it, anything else replaces it.
export async function setMailConfig(db, updates, { keyOpts = {} } = {}) {
  const { AppConfig } = db.models;
  const writes = {};
  for (const [key, raw] of Object.entries(updates || {})) {
    if (!MAIL_KEYS.includes(key)) throw new Error(`Unknown mail setting: ${key}`);
    if (key === 'mail_password') {
      const password = String(raw ?? '');
      if (password.length > MAX_PASSWORD_LENGTH) throw new Error('Invalid mail_password: too long');
      writes[key] = password === '' ? '' : encryptSecrets({ password }, keyOpts);
    } else {
      writes[key] = cleanValue(key, raw);
    }
  }
  if (Object.keys(writes).length === 0) throw new Error('Nothing to update');
  for (const [key, value] of Object.entries(writes)) {
    const [updated] = await AppConfig.update({ value }, { where: { key } });
    if (updated === 0) await AppConfig.create({ key, value });
  }
  return getMailConfig(db, { keyOpts });
}
