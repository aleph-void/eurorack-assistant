# AR glasses: a feasibility assessment

Could this app drive a pair of augmented reality glasses that look at the rack,
recognise the module you are stood in front of, draw its jacks where the real
jacks are, and write down each cable as you patch it?

Short answer: **the plumbing is nearly free, the recognition is real work with a
good chance of succeeding, and fully automatic cable tracking is the part that
does not hold up.** The three are worth separating, because they are three
different projects with three different risk profiles, and only the third one is
in doubt.

The target hardware is the **Xreal One Pro**, and that choice settles more of
the design than it looks. It is a display rather than an AR computer: no camera,
no world tracking, all compute on a host it is plugged into. That sounds like a
limitation and is mostly an escape — it pushes the camera off your head and onto
the case, which removes the two hardest problems below and improves the third.
Section "The hardware" is the argument.

This document is an assessment, not a plan of record. It says what the codebase
already gives such a feature, what would have to be built, what the hardware can
actually do, and where the accuracy ceiling sits.

- [The three problems](#the-three-problems)
- [1. Plumbing: mostly already here](#1-plumbing-mostly-already-here)
- [2. Recognising the module and the panel](#2-recognising-the-module-and-the-panel)
- [3. Tracking the cables](#3-tracking-the-cables)
- [The hardware: Xreal One Pro](#the-hardware-xreal-one-pro)
- [What would have to be built](#what-would-have-to-be-built)
- [Effort, in the order I would do it](#effort-in-the-order-i-would-do-it)
- [Risks worth stating up front](#risks-worth-stating-up-front)
- [Verdict](#verdict)

---

## The three problems

| | What it means | Feasibility |
| --- | --- | --- |
| **Transport** | A headset links itself to an account, holds a connection, reads a patch, writes a cable | **Easy.** The oscilloscope integration is the same shape and most of it generalises |
| **Recognition** | Which module am I looking at, where is its plate in the frame, where is each jack on screen | **Feasible.** Planar target tracking against a closed set — the well-behaved end of computer vision. On a fixed camera it reduces further, to a one-time calibration. The reference images are the risk, not the algorithm |
| **Cable tracking** | Which two jacks did that cable just join | **Not to the standard this app needs, unattended.** Feasible as a *proposal* the user confirms; not as a silent writer of truth |

The third row is the one to argue about, and section 3 argues it.

---

## 1. Plumbing: mostly already here

The oscilloscope work built, in general form, nearly everything a headset needs
to talk to this server. `docs/oscilloscope-protocol.md` is the template, and the
code behind it is not scope-specific:

- **Linking.** `services/deviceAuth.js` is a complete RFC 8628 device grant:
  code pair, 8-character user code in an unambiguous alphabet, browser approval
  from a logged-in session, refreshable bearer tokens hashed at rest, revocation
  from the device list. A headset with no keyboard is exactly the client that
  grant was invented for — it shows a code, you type it into the phone or
  laptop you already have open.
- **Connection.** `/api/devices/ws` (`ws.js`) authenticates the upgrade with the
  bearer token and carries a 12 MB max payload — already sized for images rather
  than control messages.
- **Addressing and state.** `deviceHub.js` keeps the live connections per user,
  normalises whatever the device announced about itself, matches replies to
  requests by id, times out, and cuts off sockets when a token is revoked. It
  deliberately knows nothing about WebSockets, so it is drivable from tests.
- **Telling the browser.** The event bus publishes `kind: 'device'` events to
  the user's own browser sockets, which is how a page would light up when the
  glasses connect and how a proposed cable would arrive on screen.
- **Storing pictures.** `services/captures.js` is the pattern for images a
  device supplies: content-addressed by sha256, written to a temp name and renamed, and
  deleted only once nothing references the bytes.

Four things genuinely have to change, and they are all small and all
identifiable:

1. **The device scope is hardcoded.** `ws.js:21` is
   `export const DEVICE_SCOPE = 'oscilloscope'` and `ws.js:84` gates every
   device upgrade on it. A second kind of device needs the check to become
   per-client (or per-path), plus an `ar` scope and an `oauth_clients` row in a
   **new** migration — migration 013 has been applied and the repo's rule is
   that an applied migration is never edited.
2. **The hub only speaks browser-to-device.** `handleMessage` understands
   `hello`, `state`, `result` and `error`, and returns false for anything else;
   `request()` goes outward and waits for an answer. AR is the other direction —
   the glasses have something to say that nobody asked for ("I think a cable
   just went into MATHS CH1"). That is one new `event` case that publishes on
   the bus, and it fits the existing shape cleanly.
3. **The REST API takes session cookies only.** `requireAuth` (`auth.js:141`)
   reads the session cookie and nothing else; `getDeviceTokenUser` is used in
   exactly one place, the WebSocket upgrade. A headset that wants to `POST` a
   cable currently cannot. Either route every write through the socket, or add a
   narrow `requireDeviceOrSession` gated on scope and applied only to the patch
   cable routes. That second option widens the API's auth surface from "a
   browser session" to "a bearer token", which is a security review of its own,
   not a refactor.
4. **The patch payload is too heavy for a headset.** CLAUDE.md is explicit that
   a whole-studio patch is seconds of server work and megabytes on the wire —
   `routes/patches/core.js:253` passes `describe: false` for exactly that
   reason. Glasses need a lean read: jack ids, names, types, marker fractions,
   and the cables currently in the patch. That is a new serializer over data
   that already exists, not new data.

Nothing in this list is research. Call it a fortnight, and it is useful on its
own — the same protocol would serve a phone app, a foot-pedal, or a second
screen on the bench.

---

## 2. Recognising the module and the panel

This is where the project is unusually well placed, and it is worth being
precise about why.

### What the database already knows

Most AR projects of this kind start by building a model of the thing they are
looking at. Here it is already built, and built in the right coordinates:

- **A picture of every module's front plate**, content-addressed, and already
  *cut down to the plate itself* on arrival (`panelTrim.js`, `panelPlate.js`) —
  so the stored image is the target, with no backdrop to match against.
- **Every component's position as a fraction of that image**
  (`module_panels` / placements, migration 016), carrying the component's
  `type`, so a marker is already coloured and already knows whether it is an
  input, an output or a knob.
- **The panel's true width in HP**, which turns a fraction into millimetres and
  gives the tracker a metric scale — the thing a monocular camera otherwise
  cannot recover.
- **The rack's physical arrangement** (`rack_rows` / `rack_row_modules`, and
  `panelWidth()` on the client), so the modules either side of the one in view
  are known before a single pixel is examined.
- **Which holes are not patch points.** `isPatchPoint()`
  (`panelLayout.js:61`) already excludes ribbon headers, USB and memory-card
  slots, so the overlay will not invite you to patch into a card slot.

Consequence: once you have a homography from the camera frame to the stored
panel image, every jack's screen position falls straight out of the fractions
already in the database. No new geometry model, no new labelling pass, no
per-module tuning. That is a large head start.

### Why the recognition itself is tractable

A eurorack panel is close to the ideal target for planar tracking. It is flat,
rigid, mounted coplanar with its neighbours, densely silkscreened (texture is
what feature matching eats), and — crucially — **the candidate set is closed and
small**. This is not open-set recognition against every module ever made; it is
"which of the 34 modules in this user's rack is this", with a strong spatial
prior from the rack layout and from the previous frame. Classic local-feature
matching (ORB/AKAZE, or a learned matcher if the budget allows) plus RANSAC for
the homography is a solved-shape problem at that scale, and it runs at frame
rate on a phone-class SoC.

### The real risk: the reference images are not photographs of *this* rack

The stored panel is whatever the panel job found — a manufacturer's product
render, a retailer's shot, a ModularGrid picture, or, when nothing was found, a
**panel this app drew itself** from the manual's layout description. A drawn
panel has no texture to match and cannot serve as a visual reference at all.
Even a real product shot is a different revision, a different faceplate colour
option, a different silkscreen, studio-lit, and unscuffed.

The mitigation is an **enrolment sweep**: once per rack, the user walks the
camera along the case and the app stores its own reference frames of the actual
hardware, matched to the known layout. This is worth doing regardless — it also
recovers the rack-to-camera geometry, gives per-unit appearance, and is the
natural moment to confirm the layout is what the database thinks it is. It is
additional scope, and it should be planned in from the start rather than
discovered later.

Other honest failure modes: two of the same module in one case (the layout prior
resolves it, a lone close-up does not); dark studios with blown-out LEDs; matte
black panels with little texture; and a case mid-patch where cables occlude a
third of every plate.

### What in the repo transfers, and what does not

- `panelSnap.js` **transfers conceptually and is the most valuable prior art
  here.** It already finds jacks and knobs as *circular features* — a dark hole
  ringed by a bright nut, a dark cap on a bright plate — scores candidates,
  charges them for travel, and forbids two markers claiming the same hole. That
  is precisely the detector an AR pipeline needs for refining marker positions
  against the real hardware, and the millimetre-denominated constants
  (`SNAP_RADIUS_MM`, `SEARCH_MM`, `DRAG_PENALTY`) survive the change of camera.
- `panelPlate.js` **does not transfer.** It finds the plate by peeling away a
  uniform backdrop, which is what a product shot has and a photograph of a rack
  emphatically does not — there the "backdrop" is more modules. Locating the
  plate in a live frame is the tracker's job, not this function's.
- **The LLM path must not be reused.** `backend.analyzeImage()` shells out to
  `claude -p` or `codex exec` through the job queue, staging the file into a
  per-call jail. That is minutes-scale, subscription-metered work. It is the
  right tool for labelling an enrolment sweep or filling in a module with no
  panel — and completely wrong for anything per-frame. Any AR feature needs a
  new local vision pipeline; there is no shortcut through the queue.

---

## 3. Tracking the cables

This is the part that does not survive contact with the bench, at least not in
the form "and it automatically records the patch while you work".

### Why it is hard, specifically

- **A patch cable is the worst-case visual target.** Thin, specular, brightly
  coloured, and deformable into a different catenary every time you touch it. It
  crosses other cables of the same colour constantly.
- **The two ends are rarely in one field of view.** A cable runs 30–80 cm across
  a case; the interesting event is a *pair* of endpoints, and a head-mounted
  camera at working distance sees one of them.
- **The moment of insertion is the moment of maximum occlusion.** Your hand, the
  plug barrel and your forearm are between the camera and the jack precisely
  while the thing you want to observe happens.
- **A miss is not neutral.** The patch is this app's source of truth: it feeds
  the flow tracer, the questions, the export. A silently wrong cable corrupts
  every answer downstream, and the user has no reason to suspect it. An
  auto-tracker that is 85% right is *worse* than no tracker, because the 15% is
  invisible.

### The shape that does work

Do not track cables. Track **jack occupancy**, and infer the pairing.

1. With the homography you already have, sample each jack's neighbourhood in the
   rectified panel and classify it against its known empty appearance. A plugged
   jack is a plug barrel and a colour where a dark hole used to be — a local,
   cheap, reasonably robust test, and one the existing circular-feature scoring
   is already halfway to.
2. When jack **X** becomes occupied and jack **Y** becomes occupied within the
   same short window, propose the cable X↔Y.
3. **Let the existing rules do the pruning.** `cableProblem()`
   (`routes/patches/helpers.js:184`) already knows about outputs versus inputs,
   one cable per input, mult groups, switch sections, bridged pairs and port
   kinds. A large share of nonsensical proposals is rejected for free, by code
   that is already tested.
4. **Propose, do not write.** The cable appears as a pending suggestion the user
   accepts or corrects.

Point 4 is not a hedge — it is the pattern this project already chose. Voice
patching (`docs/voice-patching.md`) is the same problem: capture a cable
hands-free, accept that the capture is ambiguous, resolve the ambiguity with a
question and a tone rather than by guessing. AR should join that flow rather
than invent a second one, and the machinery is reusable almost verbatim:
`voicePatchTarget.js` already registers "the patch currently on screen" with the
jack and cable lists handed over as lazy functions, and the two-tap patching
gesture in `PatchDiagram.vue` (`patchFrom`) is exactly the interaction a
gaze-and-pinch maps onto.

### A fixed camera changes this materially

Everything above assumes the camera is on your head, moving. The hardware
section argues for mounting it on the case instead, and that is worth revisiting
here, because occupancy detection is where a static viewpoint pays best:

- The geometry never changes, so the patch of pixels belonging to a given jack
  is the same patch of pixels all evening. No per-frame homography, no drift.
- You have a **known-empty reference** — the frame taken when the patch was
  cleared — so "is something in this hole" becomes differencing against a
  picture of that same hole empty, under the same light, from the same angle.
  That is a far stronger signal than classifying a jack in isolation.
- **Both ends of a cable are usually in frame**, because the camera sees the
  whole case rather than the 47 cm your head is pointed at. Pair inference stops
  depending on you happening to look at both jacks.
- Your hands still occlude, but only in passing. A static camera can simply wait
  for the view to settle and then compare, which a moving one cannot.

The pessimism in this section is aimed at head-mounted capture. Under a fixed
camera I would revise the expectation upward — enough that phase 2 below is
worth attempting rather than merely worth prototyping. It does not change the
conclusion about writing cables unattended: better odds are still odds, and the
patch is still what every answer is derived from.

What you should expect from this, honestly: good precision on a case you are
working slowly and deliberately across, degrading as the patch gets dense and
the hands get fast. A hard number is not available without a labelled test set
recorded off a real rack — and building that set is itself part of the work, not
something to skip.

---

## The hardware: Xreal One Pro

The target is the **Xreal One Pro**, and choosing it settles the architecture —
in a way that turns out to help.

### What the device is

It is an **optical see-through display**, not a self-contained AR computer.
Micro-OLED, 1080p per eye, around 57° diagonal field of view, an on-board X1
chip that holds a virtual screen still in 3DoF, and a USB-C DisplayPort input.
Everything else — the compute, the storage, the app — lives on whatever host is
plugged into it: an Android phone with DisplayPort alt mode, a Beam Pro, a
laptop, a mini PC under the bench.

Two consequences follow immediately, and they are the whole assessment:

- **There is no camera in the glasses.** The One series dropped the cameras the
  Light had. A camera means the clip-on **Xreal Eye** accessory, or a camera
  somewhere else entirely.
- **There is no 6DoF world tracking of its own.** The X1's 3DoF anchoring keeps
  a floating screen from swimming when you turn your head. It does not know
  where your rack is, and it is not a substitute for tracking one.

Neither is a problem. Both are decisions the design has to actually make rather
than inherit.

### The registration problem this creates

This is the one genuinely new technical constraint, and it is worth being blunt
about it because it kills the obvious design.

On a passthrough headset, the world you see *is* a camera frame, so an overlay
drawn on that frame stays glued to the hardware no matter how late it is —
latency shows up as a laggy world, not as a marker sliding off a jack. An
optical see-through display has no such luck. The real panel arrives at your eye
at the speed of light; the overlay arrives after exposure, transfer to the host,
detection, render and DisplayPort. That round trip is realistically 60–150 ms.
Tight registration wants under about 20.

So **drawing rings exactly on the physical jacks, from a head-mounted camera,
will smear off target every time you move your head**, and no amount of tuning
in the vision pipeline fixes a latency budget. Plan around it rather than
against it.

Worth knowing while planning the display side: at 50 cm — arm's length from the
case — a ~57° diagonal image covers roughly 47 × 27 cm, which is about 90HP wide
and two 3U rows tall. Enough for a row-pair of a small case, nowhere near a
studio.

### The move: put the camera on the case, not on your face

Because the glasses are a display and the compute is on a host anyway, nothing
requires the camera to be on your head. Mount it looking at the rack — a webcam
clamped above the case, a phone on a desk arm — and let the glasses be the
screen showing what it sees.

This is not a consolation prize. It removes the two hardest problems in this
entire document at once, and improves the third:

- **The registration problem disappears.** The overlay is a virtual screen, not
  a world-locked annotation. Head-locked content is precisely what these glasses
  are good at, and it is immune to motion-to-photon latency.
- **Module recognition collapses from a tracking loop to a one-time
  calibration.** A fixed camera has a fixed homography onto each panel. Solve it
  once at enrolment; it stays valid until the camera or the rack moves. Section
  2's per-frame matching, its lighting sensitivity and its two-identical-modules
  ambiguity all stop being real-time concerns.
- **Cable tracking gets materially easier** — see the note in section 3. A
  static viewpoint turns occupancy detection into background differencing
  against a known-empty reference, which is a far stronger signal than anything
  a moving head-mounted camera can offer.

What you give up is gaze: a fixed camera does not know which module you are
looking at. In practice that is answered by asking (point, tap, or say it — the
voice grammar already parses module names), or later by adding the Eye purely as
a "what am I looking at" sensor while the fixed camera keeps doing the real
work.

### The go/no-go item to verify first

If you do want the Xreal Eye in the design — for gaze, or because a fixed camera
is impractical in your room — **verify that third-party code can read its frames
in real time, on your host, before planning anything around it.** The Eye is
marketed for capture (photos, video, spatial video); a marketed capture
accessory and an SDK-exposed live frame source are not the same thing, and NRSDK
support for it may be host-specific or Unity-specific. Xreal's own developer
documentation is the authority, and this document is not it.

The fixed-camera design deliberately does not depend on the answer. That is the
main reason to prefer it: a USB webcam has no SDK questions at all.

### Which host

Any of these work; pick on where the vision runs comfortably:

| Host | Notes |
| --- | --- |
| **Mini PC / laptop under the bench** | The easy choice. Real CPU/GPU for the vision, a USB webcam plugs straight in, no mobile SDK, and the glasses are a second monitor. Recommended for the prototype |
| **Android phone / Beam Pro** | Portable, and the natural home if the Eye is ever used. More SDK surface, less compute |
| **The existing web client** | The overlay UI can be a page in this app rendered on the glasses' virtual screen. The *vision* still has to run natively beside it — see the WebXR note below |

Since the glasses present as a display, a large part of the UI can simply be the
Vue client on a virtual screen. That is a real saving. What cannot live in the
browser is the detection: WebXR gives pose, not raw camera frames, on most
platforms, and here you do not want its pose anyway.

---

## What would have to be built

New, in rough dependency order:

- A migration adding an `ar` scope and an `oauth_clients` row, and generalising
  the device scope check in `ws.js`.
- A device-initiated `event` message in `deviceHub.js`, published on the bus.
- A lean patch read for constrained clients (jacks, positions, live cables),
  beside the existing serializers rather than inside them.
- Either a scoped bearer-token path into the cable routes, or cable writes over
  the socket. The former is cleaner for the client and needs a security review.
- Storage for a rack's enrolment frames and its known-empty reference — the
  `captures.js` content-addressed pattern applies directly.
- A pending-cable concept: something proposed, shown, confirmed or dismissed.
  This is genuinely new domain surface and should be designed once for both AR
  and voice.
- The host app itself: camera capture, one-time rack calibration, occupancy
  classification, and the overlay drawn on the glasses' virtual screen — the
  bulk of the work, and the part that lives outside this repo. The overlay UI
  can largely be the existing Vue client on that screen; the vision cannot.
- A protocol document beside `docs/oscilloscope-protocol.md`, in the same shape.
  That document existing is a good sign for this feature: the project already
  knows how to specify an outboard client.

---

## Effort, in the order I would do it

Ranges are engineer-weeks for someone comfortable in both halves. They assume
the client app is written by the same person, which is optimistic.

| Phase | What lands | Weeks | Risk |
| --- | --- | --- | --- |
| **0. Protocol** | Scope, device events, lean patch read, cable writes, docs. A headset — or anything — can read a patch and write a cable | 1–2 | Low. Only the auth widening needs care |
| **1. See it** | Camera on the case, one-time rack calibration, the live view on the glasses with every jack named and typed from the stored fractions. No writing yet | 3–6 | Medium-low on a fixed camera. Reference-image quality is the variable |
| **2. Suggest it** | Jack occupancy by differencing against the empty reference, pair inference, proposals validated by `cableProblem()`, confirm-or-correct in the existing UI | 5–10 | Medium. Needs a labelled test set off a real rack |
| **3. Trust it** | Unattended, unconfirmed cable recording | — | **Not recommended.** See section 3 |

Phase 1 is worth having even if phase 2 never ships: the case in front of you,
on a screen you are already wearing, with every jack named, typed and coloured
from the manual the app already read — that is a useful bench instrument on its
own, it needs no writes at all, and it uses data that is already in the
database. If the appetite is for one phase, that is the one.

The estimates came down from the head-mounted version. A fixed camera removes
the per-frame tracking loop and the registration budget, which were the two
places the schedule could have run away.

---

## Risks worth stating up front

- **Reference images.** The single largest technical unknown. Some modules have
  a drawn panel rather than a photograph and cannot be matched at all until the
  enrolment sweep gives them one.
- **Auth surface.** Letting bearer tokens write patches is a real change in the
  security posture. It is the correct design, and it deserves its own review.
- **Silent wrongness.** A tracker that writes cables unattended corrupts the
  data the whole app reasons from, invisibly. Every design above pushes towards
  proposals for this reason.
- **Payload weight.** A studio patch is megabytes. Anything on a headset needs
  the lean read, and needs deltas rather than polling.
- **The Xreal Eye's SDK.** If the design ever depends on the clip-on camera,
  confirm that third-party code can read its frames live on your host before
  building on it. The fixed-camera design is preferred partly because it makes
  the answer irrelevant.
- **Optical see-through registration.** Drawing on the physical jacks from a
  head-mounted camera is a latency problem, not a vision problem, and it is not
  solvable at 60–150 ms. The virtual-screen design sidesteps it; anything that
  drifts back towards world-locked markers walks into it again.
- **Scope creep into vision research.** The enrolment sweep, the occupancy
  classifier and the test set are each a project. They are not optional, and
  they are where the time actually goes.

---

## Verdict

**Yes to detecting the module and the panel, and drawing on it.** The data model
is already the hard half of that problem, and it is in the right shape. On a
fixed camera, recognition is a calibration step rather than a tracking loop.

**Yes to noticing cables, as suggestions.** The existing legality rules make the
suggestions much better than raw vision would be, and the voice patching feature
already established that a hands-free capture with a confirmation step is the
right trade in this app.

**No to automatic, unconfirmed cable tracking.** Not because it cannot be
approximated, but because the patch is the thing every answer is derived from,
and a wrong cable recorded silently is a worse outcome than no cable recorded at
all.

**And a caution about the shape of it.** The One Pro is a screen, so resist
designing for annotations pinned to real jacks: that is the one thing this
hardware genuinely cannot do well, and every hour spent fighting the latency
budget is an hour not spent on the part that works. A camera on the case and the
case redrawn on the glasses gets you nearly everything, on hardware that is
suited to it.

The plumbing is a fortnight. The seeing is a month or two. The rest is honest
about what it does not know.
