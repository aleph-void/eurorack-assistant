# Accounts: addresses, confirmation, locking, mail

An account is a username, a password, and — since migration 052 — an email
address. This is what the address is for, how it is proved to be the user's,
how an account is shut, and how the app sends mail at all.

## The address

`users.email` is required and one per account. Every address is lowercased
and trimmed before it is stored or compared (`normalizeEmail()` in
`server/src/auth.js`), so the plain unique index on the column is
case-insensitive in effect. `emailProblem()` beside it is the one place the
shape of an address is judged, loosely — one `@`, something either side, a
dot in the domain — because the real test of an address is whether mail sent
to it arrives.

Accounts that existed before the column have no address to give it. They
were given `<username>@unset.invalid`: `.invalid` is reserved by RFC 2606
and never resolves, `emailProblem()` refuses it, and the account page sees it
and asks for a real one. The admin created by the installer gets the same
placeholder unless `ADMIN_EMAIL` is set when `scripts/create-admin.js` runs.

## Confirmation

An address is a claim until the user follows the link mailed to it. The
flow lives in `server/src/services/emailVerification.js`:

- A random token goes into the link; its SHA-256 hash goes into
  `email_verifications` with the address it was sent to and an expiry
  (24 hours). One outstanding confirmation per user: a new one replaces
  the last.
- `POST /api/auth/verify-email` with the token sets
  `users.email_verified_at`. It takes no session, because the mail is read
  wherever it is read. It fails the same way for a token that is unknown,
  expired, or was sent to an address the account no longer has.
- `POST /api/auth/verify-email/resend` sends the mail again, at most once
  a minute.

Any change of address starts over: the user's own change
(`PUT /api/auth/email`, which takes the current password, because the
recovery address is as good as the password) and the admin's
(`PUT /api/users/:id/email`) both clear `email_verified_at` and mail a new
link. Creating a user (`POST /api/users`) does the same. The change is
recorded whether or not the mail could be sent; every such answer carries
`verification: { sent, problem }` and the page says which.

Pages: `/account/email` (the user's own address, with the resend button),
`/verify-email` (the link's landing page), and the Users page for the admin.

## Locking

Five wrong passwords in a row lock the account they were tried against
(`users.failed_logins`, `locked_at`, `locked_reason = 'failed_logins'`;
migration 053, `server/src/services/accountLock.js`). The admin locks an
account by hand with `PUT /api/users/:id/lock { locked: true }`
(`locked_reason = 'admin'`) and unlocks either kind with `{ locked: false }`,
which also forgets the failures. Nothing unlocks on its own.

A lock is a logout: every session is deleted and every device token
revoked, and the session lookup refuses a locked user besides. A locked
login answers 403 with `code: 'account_locked'` before the password is
looked at, so a guess against a locked account learns nothing; the fifth
wrong guess gets the same answer.

The IP rate limiter in `rateLimit.js` still applies. It slows a guesser
down; the lock stops them. The cost is that anyone who knows a username can
lock it with five bad passwords, after which the admin has to open it again.

## Mail

Everything the app sends goes through `server/src/services/mailer.js`, over
the settings in `server/src/services/mailConfig.js`:

| key | meaning |
| --- | --- |
| `mail_host`, `mail_port`, `mail_secure` | the SMTP server; `mail_secure` is SMTPS from the first byte (port 465), off means STARTTLS when offered |
| `mail_user`, `mail_password` | the SMTP login; the password is encrypted at rest with the LLM credentials' key and never served back |
| `mail_from` | the From address |
| `public_url` | where links in a mail point. Set explicitly because the server sits behind nginx and a Host header is whatever the sender said it was |

They live in the `app_config` table like the rest of the configuration, but
`GET /api/config` never serves them; `GET` / `PUT /api/config/mail` do, with
the password masked as `mail_password_set`. `POST /api/config/mail/test`
sends a test mail to the admin's own address. The page is `/admin/mail`.

`sendMail()` never throws for a mail that did not go: it answers
`{ sent, problem }`, so a change of address is recorded even when the mail
server is down or not yet set up. The transport is nodemailer, loaded on
first use; tests pass a recorder through `createApp(db, { mailImpl })`.
