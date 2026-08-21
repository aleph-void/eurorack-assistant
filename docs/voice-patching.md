# Patching by voice

Documenting a patch while you are making it means putting the cable down,
finding the module in a dropdown, finding the jack in another dropdown, and
doing that twice per cable. By the time you are done you have lost the thread of
what you were doing.

This says the cable instead:

> "connect make noise maths out one to 2hp div clock in"

and answers with a tone, so you never have to look at the screen. It lives on
the patch page, above the Cables panel, and it is off until you turn it on.

- [What you can say](#what-you-can-say)
- [How it hears you](#how-it-hears-you)
- [When it listens](#when-it-listens)
- [The key phrase](#the-key-phrase)
- [Which microphone, which speaker](#which-microphone-which-speaker)
- [What the tones mean](#what-the-tones-mean)
- [How a sentence becomes two jack ids](#how-a-sentence-becomes-two-jack-ids)
- [Running it](#running-it)
- [Teaching it your rack's words](#teaching-it-your-racks-words)
- [The files](#the-files)

---

## What you can say

| Said | Done |
| --- | --- |
| connect / patch / plug / route / send **A** to / into **B** | plugs a cable |
| unplug / disconnect **A** | pulls that cable out |
| undo, undo that, scratch that | pulls out the last cable it plugged |
| cancel, never mind | drops the question it just asked |
| …to **B** **stacked** / **as optional** | sets the flag on the new cable |
| one, two, the second one | answers "which of these did you mean?" |
| create connection between **A** and **B** | the key phrase — see below |
| disconnect connection between **A** and **B** | the key phrase, the other way |

Both ends are named the way you would name them to someone stood next to the
case. All of these find the same jack:

```
make noise maths out one       maths channel one out
maths ch 1 out                 the out one jack on maths
```

Say only as much as your rack makes necessary. "maths eor to div clock" is
enough in a rack with one Maths and one Div in it.

## How it hears you

Two recognisers, chosen in the panel.

**Browser (Web Speech API)** — nothing to install, no model to download, and
recognition starts the instant you press the key. It is Chrome, Edge and Safari
only, and it sends your audio to the vendor's servers, which is worth knowing
about in an application you are otherwise self-hosting.

**Local Whisper** — runs entirely on your machine. The first use downloads the
model (tiny is ~40 MB, base ~150 MB); after that it works with the network
unplugged and nothing about your rack leaves the room. Transcription takes about
a second on the tiny model and runs in a worker, so the page stays responsive.
Whisper is also markedly better at module names, because it is not trying quite
so hard to turn what you said into ordinary English.

Start with the browser recogniser. Move to Whisper if the names in your rack
keep coming out wrong, or if you would rather your microphone stayed at home.

## When it listens

A studio is a hard room for this — the rack is making noise and both of your
hands are busy. Pick whichever of these fits your bench:

| Mode | How it works | Good when |
| --- | --- | --- |
| **Push to talk** | hold the space bar (or the on-screen button) while you speak | the default; nothing else can trigger it |
| **Patch mode** | click once to open a session, speak as many cables as you like, click to close | documenting a patch that already exists |
| **Wake word** | always listening, acts only after "patch…" or "hey rack…" | hands completely full |
| **Key phrase** | Whisper listens to the room for "create connection between…", the browser transcribes the cable | hands completely full, and you would rather the always-on listening happened on your own machine |
| **MIDI / footswitch** | a footswitch on the desk arms the microphone | hands completely full, and you have a footswitch |

For MIDI, press **Learn** and then press the switch: the next note or CC it sees
becomes the binding. A note or a CC above 64 arms it, the release disarms it.

Patch mode, wake word and key phrase keep the microphone open, so with Whisper
they use a loudness gate to work out where one command ends and the next
begins. The gate
tracks what this room has been doing rather than a fixed threshold, so a held
chord raises the bar instead of triggering it.

## The key phrase

Wake-word mode leaves whichever recogniser you picked listening to the room all
evening. If that recogniser is the browser's, the room goes to Google. **Key
phrase** mode splits the job in two so it does not have to:

- **Whisper listens**, on this machine, always, and does nothing at all until it
  hears one of your phrases. It is transcribing your studio continuously and
  none of it leaves the building.
- **The browser's recogniser** — faster, and it hands back several readings of
  the same breath, which is the single cheapest accuracy win there is — is
  opened only once the phrase has been heard, and closed again as soon as the
  cable has been said.

Two phrases, each editable, each taking a comma-separated list of spellings:

| Phrase | Means |
| --- | --- |
| **create connection between** *A* and *B* | plugs a cable |
| **disconnect connection between** *A* and *B* | pulls that cable out |

The phrase supplies the verb, so what you say after it is just the two ends:
"create connection between maths out one and 2hp div clock". You can say the
whole thing in one breath — Whisper heard the cable as well as the phrase, and
that transcription is used when the browser's recogniser has nothing to add —
or say the phrase, wait for the blip, and then say the cable, which is the more
accurate of the two. Either way the phrase is matched fuzzily and wherever in
the sentence it lands, so "okay, create connection between…" still works.

The on-screen button is still there in this mode, and holding it is the same as
saying the connect phrase.

Setting the recognition engine to Local Whisper as well makes the whole path
offline, at the cost of running two Whisper instances at once.

## Which microphone, which speaker

A studio has more than one of each, and the system default is usually the wrong
one — the interface that is recording the rack, or the monitors the cues would
get mixed into. Both are chosen under **Microphone and speaker** in the panel,
and both are kept in this browser under your own account: a device id means
nothing on another machine, so none of it is sent to the server.

Device names are blank until the browser has handed over a microphone once —
**Show device names** asks for it, and the list fills in. An interface switched
on mid-session appears by itself, and a device unplugged after being chosen
falls back to the system default rather than failing.

Two limits worth knowing, both the browser's rather than this app's:

- **The browser's own recogniser cannot be pointed at a device.** Web Speech
  opens the system default microphone itself. The choice reaches Local Whisper
  only — which is another reason the key phrase is listened for by Whisper.
- **Choosing an output needs `setSinkId`** (Chrome 110 and up). Where it is
  missing the picker is disabled and the tones play wherever the system sends
  them. Errors read out loud always follow the system output, everywhere:
  speech synthesis has no routing at all.

## What the tones mean

Deliberately far apart, so they are never confused across a room:

| Sound | Meaning |
| --- | --- |
| one short high blip | the microphone is open |
| a rising fifth | the cable is in |
| three level pips | heard you, but it needs one more word |
| a low falling buzz | nothing was plugged |
| a falling fifth | a cable came back out |

There is also **read errors out loud**, off by default, which speaks the
server's refusal — "Clock on 2hp Div already has a cable in it". A beep can
carry the no; only speech can carry the why.

## How a sentence becomes two jack ids

Nothing is plugged on a maybe. The path is deliberately conservative:

1. **Both sides are put through the same mill.** What you said and what the
   manual printed are lowercased, split where a digit meets a letter, spoken
   numbers turned into digits, and interchangeable words folded together. So
   "channel one" and "Ch1" arrive as the same two tokens, and "two h p" and
   "2hp" both arrive as `2 hp`.
2. **Every "to" — and every "and" — is tried as the join.** In "…out one **to** **two** hp div…" the
   first is the join and the second is the manufacturer's name; the reading that
   explains the whole sentence best wins, rather than a rule deciding in advance.
3. **Each half is scored against the jacks that direction allows.** Sources are
   matched only against outputs and mults, destinations only against inputs and
   mults, so half the rack is out of the running before scoring starts. A word
   can match outright, by prefix, by sounding the same ("mats" → "maths"), or by
   being one letter out — but a number never nearly-matches, because "out one"
   and "out two" are different cables.
4. **A clear winner or a question.** If the best jack is not far enough ahead of
   the second best, or is not confident enough on its own, the panel says what it
   thinks it heard and waits. The threshold is a slider.
5. **The server has the last word.** The cable is created through the ordinary
   `POST /api/patches/:id/cables`, so every rule about mults, port kinds and
   inputs that already have a cable in them still applies, and its refusal is
   what you hear.

When the recogniser offers several readings of the same breath, all of them are
parsed and the one that names a real cable wins — it is ranking English, not
eurorack, so it is often wrong about which was best.

## Running it

**HTTPS is required.** Browsers will not hand out a microphone on a plain HTTP
origin other than `localhost`. Use `docker-compose.tls.yml`, or reach the app
over `localhost` while you try it out.

The browser recogniser needs nothing else. Whisper adds `@huggingface/
transformers` to the client bundle — loaded lazily, so a rack owner who never
turns Whisper on never downloads any of it, but it does add about 22 MB of
WebAssembly to `dist/`.

To keep the model weights in-house as well, put the model folder under the
client's `public/` directory and set `VITE_WHISPER_MODEL_PATH` at build time.
Nothing is then fetched from the internet at all.

Settings live in `localStorage` under `eurorack-assistant.voice.<user id>`, per
browser and per account — a studio machine is logged into by more than one
person and a microphone is a personal choice. Settings saved before accounts
were on the key are read once as the starting point for whoever logs in next.

## Teaching it your rack's words

A recogniser trained on English has never heard of Mutable Instruments. It picks
the nearest real word, and it picks the *same* wrong word every time, which makes
it fixable with a list. `DEFAULT_CORRECTIONS` in `client/src/voiceGrammar.js`
holds the common ones — plaits/plates, maths/mats, disting/distinct, batumi,
mimeophon, optomix. Add your own worst offenders there.

Two things also happen for free:

- **Spelled-out letters.** "E O R" and "V C A" are read as the words they spell,
  while the individual letters are kept, so a jack called "L" still answers to
  "L R".
- **Unnamed jacks by number.** "quadrax out one" finds the first output on a
  module whose outputs are printed as 1, 2, 3, 4 — or as nothing at all.

Naming an instance in the patch (the `label` field) also names it for voice, so
a module set up as the bass voice answers to "bass".

## The files

| File | What it does |
| --- | --- |
| `client/src/voiceGrammar.js` | normalisation, spoken numbers, sound-alike keys, the corrections list |
| `client/src/voiceCommand.js` | reads a sentence into an intent and two jacks, with a confidence |
| `client/src/speechInput.js` | one interface over both recognisers |
| `client/src/whisperInput.js` | microphone capture, resampling, the loudness gate |
| `client/src/whisperWorker.js` | transformers.js, off the main thread |
| `client/src/voiceActivation.js` | the five ways of deciding when to listen, and the key phrases |
| `client/src/audioDevices.js` | listing microphones and speakers, and routing the cues to one |
| `client/src/patchSounds.js` | the tones |
| `client/src/components/VoicePatchPanel.vue` | the panel on the patch page |

Every browser API any of these touch is injectable, which is why the tests
(`client/tests/voice*.test.js`, `speechInput.test.js`, `patchSounds.test.js`)
never open a microphone.
