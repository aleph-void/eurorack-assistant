// Turning what a rack owner says into words a jack name can be compared with.
//
// Speech gives you one string and no punctuation: "connect make noise maths
// out one to two h p div clock in". Jack names come from manuals and look
// nothing like that — "OUT 1", "Ch1", "V/Oct", "2hp". So both sides are put
// through the same mill before anything is compared: lowercased, split where a
// digit meets a letter, spoken numbers turned into digits, and the handful of
// words that mean the same thing ("output"/"out", "channel"/"ch") folded onto
// one spelling. Normalising both sides identically is the whole trick — it
// means "channel one" and "Ch1" arrive as the same two tokens.
//
// Nothing here knows about racks or cables. It is string work, and it is the
// part worth unit-testing hardest, because every wrong cable starts here.

// ---- spoken numbers ----

const NUMBER_WORDS = new Map(
  Object.entries({
    zero: '0',
    one: '1',
    won: '1',
    two: '2',
    too: '2',
    three: '3',
    four: '4',
    for: '4',
    fore: '4',
    five: '5',
    six: '6',
    seven: '7',
    eight: '8',
    ate: '8',
    nine: '9',
    ten: '10',
    eleven: '11',
    twelve: '12',
    thirteen: '13',
    fourteen: '14',
    fifteen: '15',
    sixteen: '16',
    first: '1',
    second: '2',
    third: '3',
    fourth: '4',
    fifth: '5',
    sixth: '6',
    seventh: '7',
    eighth: '8',
  })
);

// ---- words that mean the same jack ----
//
// Folded onto one spelling so that what you say and what the manual printed
// meet in the middle. Only pairs that are genuinely interchangeable on a front
// panel belong here — anything looser starts joining jacks that are not the
// same jack.
const SYNONYMS = new Map(
  Object.entries({
    output: 'out',
    outputs: 'out',
    outs: 'out',
    out: 'out',
    input: 'in',
    inputs: 'in',
    ins: 'in',
    channel: 'ch',
    chan: 'ch',
    channels: 'ch',
    clock: 'clk',
    clk: 'clk',
    trigger: 'trig',
    trig: 'trig',
    triggers: 'trig',
    gates: 'gate',
    signal: 'sig',
    sig: 'sig',
    left: 'l',
    right: 'r',
    volt: 'v',
    volts: 'v',
    voltage: 'v',
    octave: 'oct',
    octaves: 'oct',
    frequency: 'freq',
    freq: 'freq',
    filter: 'filt',
    resonance: 'res',
    modulation: 'mod',
    amount: 'amt',
    attenuverter: 'attenuator',
    reset: 'rst',
    rst: 'rst',
    envelope: 'env',
    audio: 'aud',
    pitch: 'pitch',
    lowpass: 'lp',
    highpass: 'hp',
    bandpass: 'bp',
    noise: 'noise',
  })
);

// ---- words that carry no jack in them ----
//
// Said out of habit, not to pick anything out. They cost nothing when they go
// unmatched, so "the out jack on maths" is no worse than "maths out".
const STOPWORDS = new Set([
  'the',
  'a',
  'an',
  'my',
  'please',
  'um',
  'uh',
  'er',
  'ah',
  'oh',
  'like',
  'jack',
  'socket',
  'port',
  'on',
  'of',
  'its',
  'that',
  'this',
  'per',
  'number',
  'no',
  'num',
  'module',
]);

// Units that stay welded to the number in front of them, because that is how
// they are printed on the panel: "2hp", "4ms", "1010 music" stays apart.
const WELDED_UNITS = new Set(['hp', 'ms', 'hz', 'khz', 'u']);

// ---- names speech reliably gets wrong ----
//
// A recogniser trained on English has never heard of Mutable Instruments. It
// picks the nearest real word, and it picks the same wrong word every time,
// which makes this fixable with a list. Extend it from config rather than
// editing here — every rack has its own worst offenders.
export const DEFAULT_CORRECTIONS = Object.freeze({
  math: 'maths',
  mats: 'maths',
  moths: 'maths',
  "math's": 'maths',
  plates: 'plaits',
  plait: 'plaits',
  played: 'plaits',
  rings: 'rings',
  wrings: 'rings',
  veil: 'veils',
  vales: 'veils',
  whales: 'veils',
  bales: 'veils',
  marble: 'marbles',
  marvels: 'marbles',
  tides: 'tides',
  tied: 'tides',
  stages: 'stages',
  distinct: 'disting',
  'dis ting': 'disting',
  batoomi: 'batumi',
  batumi: 'batumi',
  'bat oomi': 'batumi',
  ochre: 'ochd',
  ocht: 'ochd',
  octd: 'ochd',
  'mimeo phone': 'mimeophon',
  mimeophone: 'mimeophon',
  'morph a gene': 'morphagene',
  morphogene: 'morphagene',
  'wobble bug': 'wogglebug',
  'waggle bug': 'wogglebug',
  optimix: 'optomix',
  'opto mix': 'optomix',
  'pamela new workout': 'pamelas new workout',
  'pamela is new workout': 'pamelas new workout',
  'quad rax': 'quadrax',
  'zed dsp': 'zdsp',
  'e or': 'eor',
  'end of rise': 'eor',
  'end of cycle': 'eoc',
  'volt per octave': 'v oct',
  'one volt per octave': 'v oct',
  'vee oct': 'v oct',
  'sub harmonicon': 'subharmonicon',
  'zero coast': '0coast',
  'oh coast': '0coast',
  'two hp': '2hp',
  'four ms': '4ms',
  'ten ten music': '1010 music',
  'make noise': 'make noise',
  'mutable instruments': 'mutable instruments',
  'inter modulation': 'intellijel',
  intelligel: 'intellijel',
  'intelli jel': 'intellijel',
  intelligent: 'intellijel',
  dupfer: 'doepfer',
  doughfer: 'doepfer',
  'day fur': 'doepfer',
  'no engineering': 'noise engineering',
  behringer: 'behringer',
  eloquencer: 'eloquencer',
  'metropolis': 'metropolix',
  metropolix: 'metropolix',
});

// ---- the mill ----

const TYPOGRAPHIC = /[‘’‛ʼ]/g;

// Multi-word corrections have to run on the raw string, before it is split
// into tokens, because that is the only place "end of cycle" is three words.
function applyPhraseCorrections(text, corrections) {
  let out = text;
  for (const [wrong, right] of Object.entries(corrections)) {
    if (!wrong.includes(' ')) continue;
    out = out.replace(new RegExp(`\\b${wrong.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g'), right);
  }
  return out;
}

// Lowercase, drop punctuation, and prise apart the places a digit is welded to
// a letter — "ch1" is two tokens, and so is "2hp", so that a spoken "channel
// one" and a spoken "two h p" can both reach them.
export function normalizeSpeech(text, { corrections = DEFAULT_CORRECTIONS } = {}) {
  const cleaned = String(text ?? '')
    .toLowerCase()
    .replace(TYPOGRAPHIC, '')
    .replace(/'/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  return applyPhraseCorrections(cleaned, corrections)
    .replace(/(\d)([a-z])/g, '$1 $2')
    .replace(/([a-z])(\d)/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();
}

// Panels are full of initialisms and people read them out letter by letter:
// "E O R", "V C A", "two H P". A run of single letters is therefore also the
// word they spell, so the run is kept as that word with the letters themselves
// held as alternates — "L R" still finds a jack called "L".
function mergeLetterRuns(tokens) {
  const merged = [];
  for (let i = 0; i < tokens.length; i += 1) {
    let end = i;
    while (
      end < tokens.length &&
      tokens[end].weight > 0 &&
      /^[a-z]$/.test(tokens[end].word)
    )
      end += 1;
    if (end - i >= 2) {
      const letters = tokens.slice(i, end).map((t) => t.word);
      merged.push({ word: letters.join(''), weight: 1, alt: letters });
      i = end - 1;
      continue;
    }
    merged.push(tokens[i]);
  }
  return merged;
}

// The token list both sides of a comparison are reduced to. Weight 0 marks a
// word that was said out of habit: matching it earns nothing and missing it
// costs nothing.
export function speechTokens(text, { corrections = DEFAULT_CORRECTIONS } = {}) {
  const words = normalizeSpeech(text, { corrections }).split(' ').filter(Boolean);
  const tokens = [];
  for (let i = 0; i < words.length; i += 1) {
    let word = corrections[words[i]] || words[i];
    if (NUMBER_WORDS.has(word)) word = NUMBER_WORDS.get(word);
    // "two h p" came in as three words; "2hp" came in as two. Both leave as
    // "2" and "hp", and the unit stays a token of its own so either spelling
    // of the manufacturer lands on the same pair.
    if (/^\d+$/.test(word) && WELDED_UNITS.has(words[i + 1])) {
      tokens.push({ word, weight: 1 });
      tokens.push({ word: words[i + 1], weight: 1 });
      i += 1;
      continue;
    }
    const canonical = SYNONYMS.get(word) || word;
    tokens.push({ word: canonical, weight: STOPWORDS.has(word) ? 0 : 1 });
  }
  return mergeLetterRuns(tokens);
}

// Every spelling of a token worth comparing against — the word itself, plus
// the letters of a spelled-out run.
export const tokenForms = (token) => (token.alt?.length ? [token.word, ...token.alt] : [token.word]);

// The plain word list, with spelled-out runs left as the letters they were, so
// that splitting a sentence still sees every word that was actually said.
export const speechWords = (text, options) =>
  speechTokens(text, options).flatMap((t) => (t.alt?.length ? t.alt : [t.word]));

// ---- how alike two words sound ----

// A deliberately blunt sound key: consonants only, families collapsed, runs
// squeezed. "maths" and "mats" key the same, and so do "plaits" and "plates",
// which is exactly the mistake a recogniser makes. It is crude on purpose —
// anything cleverer starts matching jacks that only rhyme.
const SOUND_FAMILIES = [
  // Digraphs first, or the letters in them get treated separately and "maths"
  // stops sounding like "mats".
  [/ph/g, 'f'],
  [/th/g, 't'],
  [/ch/g, 'k'],
  [/sh/g, 's'],
  [/gh/g, ''],
  [/h/g, ''],
  [/[aeiouyw]/g, ''],
  [/[ckq]/g, 'k'],
  [/[sz]/g, 's'],
  [/[fv]/g, 'f'],
  [/[gj]/g, 'j'],
  [/[dt]/g, 't'],
  [/[bp]/g, 'p'],
  [/[mn]/g, 'n'],
  [/[lr]/g, 'l'],
];

export function soundKey(word) {
  const text = String(word ?? '').toLowerCase();
  if (!text) return '';
  const head = text[0];
  let rest = text.slice(1);
  for (const [pattern, replacement] of SOUND_FAMILIES) rest = rest.replace(pattern, replacement);
  rest = rest.replace(/(.)\1+/g, '$1');
  return head + rest;
}

// Ordinary Levenshtein, returned as a 0..1 likeness so thresholds read the
// same whatever the word length.
export function similarity(a, b) {
  const left = String(a ?? '');
  const right = String(b ?? '');
  if (left === right) return 1;
  if (!left || !right) return 0;
  let previous = Array.from({ length: right.length + 1 }, (_, i) => i);
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + cost);
    }
    previous = current;
  }
  return 1 - previous[right.length] / Math.max(left.length, right.length);
}

// What one spoken word is worth against one printed word. Saying it outright
// beats sounding like it, which beats merely starting the same way — a jack
// called "In" should not win on the strength of being inside "Inject".
export function wordScore(spoken, printed) {
  if (spoken === printed) return 1;
  if (!spoken || !printed) return 0;
  const numeric = /^\d+$/.test(spoken) || /^\d+$/.test(printed);
  // Digits are never nearly-right: "out 1" and "out 2" are different cables.
  if (numeric) return 0;
  if (spoken.length >= 3 && printed.startsWith(spoken)) return 0.86;
  if (printed.length >= 3 && spoken.startsWith(printed)) return 0.82;
  if (spoken.length >= 4 && printed.includes(spoken)) return 0.7;
  const sounds = soundKey(spoken) === soundKey(printed) && soundKey(spoken).length >= 2;
  if (sounds) return 0.78;
  const alike = similarity(spoken, printed);
  return alike >= 0.8 ? alike * 0.8 : 0;
}
