# AR glasses: a feasibility assessment

Could this app drive a pair of augmented reality glasses that look at the rack,
recognise the module you are stood in front of, draw its jacks where the real
jacks are, and write down each cable as you patch it?

Short answer: **the plumbing is nearly free, the recognition is real work with a
good chance of succeeding, and fully automatic cable tracking is the part that
does not hold up.** The three are worth separating, because they are three
different projects with three different risk profiles, and only the third one is
in doubt.

Two devices are under consideration — the **Xreal One Pro** and the **RayNeo
X3 Pro** — and they are opposites: a large bright display with no camera and no
compute, against a standalone computer with cameras and a much smaller window to
draw in. The hardware section compares them. The conclusion there is the one
worth carrying into everything else: **whichever glasses you buy, the camera
that watches the patch should be on the case, not on your face.** That single
decision removes the two hardest problems below and improves the third, and it
is what the estimates assume.

This document is an assessment, not a plan of record. It says what the codebase
already gives such a feature, what would have to be built, what the hardware can
actually do, and where the accuracy ceiling sits.

- [The three problems](#the-three-problems)
- [1. Plumbing: mostly already here](#1-plumbing-mostly-already-here)
- [2. Recognising the module and the panel](#2-recognising-the-module-and-the-panel)
- [3. Tracking the cables](#3-tracking-the-cables)
- [The hardware: two candidates](#the-hardware-two-candidates)
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
  device supplies: content-addressed by sha256, written to a temp name and then
  renamed, and deleted only once nothing references the bytes.

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

## The hardware: two candidates

Two devices are on the table, and they are opposites. The Xreal One Pro is a
**display** with no camera and no compute; the RayNeo X3 Pro is a **standalone
computer with cameras** and a much smaller window to draw in. Which one to buy
depends on which half of this feature you care about, and the honest answer is
that the cable-tracking half wants neither of them holding the camera.

| | **Xreal One Pro** | **RayNeo X3 Pro** |
| --- | --- | --- |
| Optics | Birdbath, micro-OLED | Waveguide, micro-LED |
| Field of view | ~57° diagonal — large | Waveguide-typical, roughly 25–30° — small |
| Brightness | Moderate; fine in a studio | Very high (marketed ~2,500 nits to the eye) |
| Compute | **None.** A host drives it over USB-C DisplayPort | **On board.** Snapdragon AR1 Gen 1, standalone Android |
| Camera | **None.** The clip-on Eye, or nothing | **Yes**, plus the sensors for gesture and spatial features |
| Pose | 3DoF anchoring of a virtual screen (X1 chip) | 6DoF-class tracking on device |
| Weight / tether | Light, but tethered to a host | ~76 g and free-standing |
| Developer story | Mature, and the fixed-camera design needs no SDK at all | Younger, China-first; the go/no-go unknown |

### What each one makes possible

**The One Pro cannot do a world-locked overlay, and that is not a tuning
problem.** On a passthrough headset the world you see *is* a camera frame, so an
overlay drawn on it stays glued no matter how late it is. An optical see-through
display has no such luck: the real panel arrives at your eye at the speed of
light and the overlay arrives after exposure, transfer to the host, detection,
render and DisplayPort — realistically 60–150 ms, against a budget of about 20.
Markers drawn on physical jacks smear off target on every head turn. What the
One Pro is genuinely good at is a large, bright, stable virtual screen.

**The X3 Pro can plausibly do what the One Pro cannot.** Not because optical
see-through stopped being optical see-through — the same physics applies — but
because standalone changes the loop. Camera, compute, pose and display are all
on one device with no host hop, and on-device pose at display rate is what makes
**late-stage reprojection** possible: recognise the panel at 10–15 Hz, then
re-project that result from the IMU every frame. That is the standard trick for
holding an overlay still under head motion, and it needs exactly the low-latency
pose a standalone has and a tethered display does not. Plausible is not easy —
budget real time for it — but it is on the table.

**What the X3 Pro charges for that is window and headroom.** At 50 cm — arm's
length from the case — a ~57° image covers roughly 47 × 27 cm, about 90HP and
two 3U rows. A ~30° image covers something nearer 23 × 13 cm: **about 46HP and a
single row**. You would be looking at one module and its neighbours, not a case.
And an AR1 Gen 1 in a 76 g frame has a thermal budget measured in minutes of
sustained vision work, not hours of it — continuous frame-rate CV will throttle
and will eat the battery. Anything running all evening has to be duty-cycled, or
offloaded.

Offloading suits this codebase unusually well, as it happens: the device
protocol already exists, and `ws.js` already sizes the device socket at 12 MB
because a rendered waveform had to fit. Keyframes to the server, recognition on
the server, results back — the same shape the oscilloscope already uses. It
costs a WiFi round trip, which rules it out for the reprojection loop and is
completely fine for "which module am I looking at".

### It still does not want to hold the camera for cable tracking

This is the part that does not change with the device, and it is worth repeating
because the X3 Pro's cameras make it tempting to put everything on your face.

Occupancy detection wants a **static viewpoint**: fixed geometry, a known-empty
reference frame of each jack under the same light from the same angle, both ends
of a cable in view at once, and the freedom to wait for your hands to leave and
then compare. A head-mounted camera has none of those, on any hardware. It sees
where you happen to be looking, from wherever you happen to be standing, and the
one moment it most needs to observe is the moment your own hand is in the way.

So the recommendation from the previous section survives the change of device:
**camera on the case for the patch tracking**, glasses for the display. The X3
Pro simply adds a second, genuinely useful thing on top — it knows which module
you are looking at, which the fixed camera never will.

### The hybrid, and what it needs from the hub

The best version of this uses both, and the existing plumbing nearly supports it
already: the fixed camera answers *what is patched*, and the glasses answer
*what am I looking at* and draw the result. `deviceHub.js` already keeps a set
of connections per user, so two devices of different kinds connect happily
today.

One real gap: `hub.pick()` returns the **most recently connected** device when
the caller does not name one. With a single oscilloscope that is a sensible
default; with a scope, a bench camera and a pair of glasses on one account it is
a coin toss. Picking by `client_id` or by scope, rather than by recency, is a
small change and a necessary one before there is more than one kind of device.

### The go/no-go item, for either device

Both candidates have exactly one question that decides everything, and it is the
same question: **can third-party code get live camera frames?**

- **Xreal**: only via the clip-on Eye, which is marketed as a capture accessory.
  A capture accessory and an SDK-exposed live frame source are not the same
  thing, and support may be host- or Unity-specific.
- **RayNeo**: the X3 Pro is Android and has the cameras, so the question is
  developer-programme access to them — frames *and* pose — on a device that
  launched China-first with a younger SDK and documentation to match.

Verify against the vendor's own developer documentation before committing
either. And note what the fixed-camera design is really buying you: a USB webcam
raises neither question. That is a reason to build phase 1 that way even if you
intend to add the glasses' own camera later.

### Which host, if it is the Xreal

| Host | Notes |
| --- | --- |
| **Mini PC / laptop under the bench** | The easy choice. Real CPU/GPU for the vision, a USB webcam plugs straight in, no mobile SDK, and the glasses are a second monitor. Recommended for the prototype |
| **Android phone / Beam Pro** | Portable, and the natural home if the Eye is ever used. More SDK surface, less compute |
| **The existing web client** | The overlay UI can be a page in this app rendered on the glasses' virtual screen. The *vision* still has to run natively beside it |

Since the glasses present as a display, a large part of the UI can simply be the
Vue client on a virtual screen. That is a real saving on the Xreal, and a real
constraint on the RayNeo, where the app is an Android app and the browser is not
where any of this lives. What cannot live in the browser either way is the
detection: WebXR gives pose, not raw camera frames, on most platforms.

---

## What would have to be built

New, in rough dependency order:

- A migration adding an `ar` scope and an `oauth_clients` row, and generalising
  the device scope check in `ws.js`.
- A device-initiated `event` message in `deviceHub.js`, published on the bus.
- Addressing a device by kind rather than by recency: `hub.pick()` currently
  answers with the most recently connected device, which is right for one
  oscilloscope and a coin toss once a bench camera and a pair of glasses share
  an account.
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
- **Camera access on whichever glasses you buy.** Xreal's clip-on Eye is
  marketed as a capture accessory, not an SDK frame source; the RayNeo's cameras
  are right there but sit behind a younger, China-first developer programme.
  Confirm live frame access — and pose, if you want reprojection — before
  building on either. The fixed-camera design is preferred partly because it
  makes both answers irrelevant.
- **Thermals and battery, if it is the RayNeo.** Sustained frame-rate vision in
  a 76 g standalone frame is minutes of budget, not hours. Duty-cycle it, or
  offload the recognition to the server over the device socket that already
  exists.
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

**And a caution about the shape of it, whichever device you pick.** On the One
Pro, annotations pinned to real jacks are the one thing the hardware genuinely
cannot do — a tethered optical see-through display cannot hide its own latency —
so designing for them wastes the schedule on a budget that will not close. On
the X3 Pro they are plausible, via reprojection off on-device pose, and they are
still not where the value is: a ~30° window shows one module, and the cable
tracking wants a static camera regardless. Put the camera on the case, redraw
the case on the glasses, and treat a world-locked overlay as something the
RayNeo might earn later rather than something either device starts with.

The plumbing is a fortnight. The seeing is a month or two. The rest is honest
about what it does not know.
