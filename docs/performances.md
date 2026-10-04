# Performances: a video of you playing, shown to everyone

Everything else a user makes here is private until they share it, record by
record, with people they name. A performance runs the other way. It is a video
somebody already PUBLISHED — the recording is on YouTube for the world — and
what they want from this app is the room to show it in: the place where the
people who know what a Maths is can watch it, see what it was played on, read
the patch if the author is willing, and say something back.

- [What a performance is](#what-a-performance-is)
- [Who may do what](#who-may-do-what)
- [Data model](#data-model)
- [API](#api)
- [The pages](#the-pages)
- [Decisions worth knowing](#decisions-worth-knowing)
- [The files](#the-files)

---

## What a performance is

A YouTube link, a title, a description, and two optional things the author
chooses to put beside the video:

- **The modules used** — a list of module records, in the author's order. A
  module record is the shared hardware fact every user who racked it reads, so
  a viewer who has the same module is sent to its page; one who does not sees
  the name.
- **The patch** — one of the author's own patches, shown through the
  performance. Every viewer of the performance can read it exactly as a shared
  patch reads (the picture, the cables, the settings, never the private layout
  of the rack), with no share row anywhere. Clearing it takes that back.

Under it is a conversation: comments, oldest first, each signed by an account.

## Who may do what

| who | may |
| --- | --- |
| any account | read every performance, its patch and its comments; leave a comment |
| anyone with the link | read a PUBLIC performance, its patch and its comments — and nothing else |
| the author | edit the performance: title, text, video, public flag, patch shown, modules listed |
| the author or an admin | delete the performance (its comments go with it) |
| a comment's writer, the performance's author, or an admin | remove that comment |

A visitor with no session leaves no comment, public performance or not: a word
under somebody's performance has to be somebody's word. The LIST of
performances is the room's as well — it takes an account — so a public
performance is reached by its link, which is what the author copies to share
it.

## Data model

Migration `055_performances.js`.

- `performances` — `user_id` (the author), `title`, `description`, `url` (the
  canonical watch URL, rebuilt from the id — never the pasted text), `video_id`
  (the eleven characters YouTube uses), `public`, `patch_id` (a real foreign
  key, `ON DELETE SET NULL`) and `patch_name` snapshotted beside it, so a
  performance whose patch was deleted still says what it played.
- `performance_modules` — `(performance_id, module_id)` with a `position`.
- `performance_comments` — who, on which performance, said what.

Nothing fetches the video. The pasted link goes through the same parser a
module's tutorial videos do (`parseYoutubeId` in `services/videos.js`), and a
link that is not a YouTube video is refused rather than guessed at.

## API

All under `/api/performances`. The two reads of ONE performance take an
optional session (`optionalAuth` in `auth.js`); everything else requires one.

| route | who | what |
| --- | --- | --- |
| `GET /?limit&before&mine` | account | one page, newest first, paged by id like the patch list; `mine=1` narrows to the viewer's own |
| `POST /` | account | `{ url, title, description?, public?, patch_id?, module_ids? }` → the full record |
| `GET /:id` | optional | the record with `owner_username`, `modules` (each with `yours`), `comments` (each with `mine`, `can_delete`), `patch` (`{ id, name, live }` or null). 401 at a private one with no session, 404 for none |
| `GET /:id/patch` | optional | the patch shown, as `GET /api/patches/:id` serves a shared one; 404 when none is shown or it has gone |
| `PUT /:id` | author | any of the create fields; `patch_id: null` withdraws the patch, `module_ids` replaces the list |
| `DELETE /:id` | author or admin | |
| `POST /:id/comments` | account | `{ body }` |
| `DELETE /:id/comments/:commentId` | writer, author or admin | |

Every answer describes a performance through `performanceJson()` and a
comment through `commentJson()` in `services/performances.js`, which is also
where the permission predicates live.

## The pages

- `/performances` — everyone's, newest first, with whose it is, how many
  modules and comments, and whether it is public; under it, the form that
  shares one of yours (`components/performances/PerformanceForm.vue`, which
  reads your patches and modules only once it is opened).
- `/performances/:id` — the player (from `youtubeEmbed.js`, the one place
  that knows the host), the description, the modules, the patch (read only
  when its section is opened — it is a whole patch payload), the comments and
  the box that leaves one, and for the author the same form again, filled in.
  The route is `public: true` in the router: a visitor with no session sees a
  public performance, and at a private one is asked to log in with a redirect
  back.

## Decisions worth knowing

- **The player is the one frame the client shell may hold.** The content
  security policy (`nginx/csp.conf`) names `https://www.youtube-nocookie.com`
  in `frame-src` and nothing else; `server/tests/csp.test.js` holds it to
  exactly that one host. The privacy host sets no tracking cookie until the
  viewer presses play. `client/src/youtubeEmbed.js` builds the URL and holds
  the id to its eleven characters, so nothing user-typed is written into the
  frame's address.
- **No thumbnails.** A list with YouTube's thumbnails would mean naming
  `i.ytimg.com` in `img-src`. The list says who, what and how many instead.
- **The patch is read through the performance, not shared.** `canRead` in
  `services/sharing.js` is untouched; `GET /api/performances/:id/patch` is the
  only door, and a performance's patch therefore never appears on anyone's
  Shared page. Withdrawing it is one field on the performance.
- **A module must be racked by the author to be listed**, the same test a link
  on a module meets: a module record is shared between everyone who racked
  it, and "yours to list" means you did.
- **Editing is the author's alone, deleting is also the admin's.** An admin
  answers for what the whole room shows and may take a performance or a
  comment down, but never puts words in someone's mouth.

## The files

- `server/migrations/055_performances.js`
- `server/src/db/models/performances.js`, wired in `db/models.js` and
  `db/models/associations.js`
- `server/src/services/performances.js` — limits, validation, permissions,
  serializers, loaders
- `server/src/routes/performances.js`, mounted at `/api/performances`
- `server/src/auth.js` — `optionalAuth()`
- `nginx/csp.conf` — `frame-src`
- `client/src/youtubeEmbed.js`
- `client/src/views/PerformancesView.vue`, `PerformanceDetailView.vue`
- `client/src/components/performances/PerformanceForm.vue`
- tests: `server/tests/performances.test.js`, `server/tests/csp.test.js`,
  `client/tests/views/performances.test.js`,
  `client/tests/views/performanceDetail.test.js`,
  `client/tests/performanceFixtures.js`
