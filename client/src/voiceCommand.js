// "Connect Make Noise Maths out one to 2hp Div clock in" — one sentence, one
// cable.
//
// This is the typed quick-entry line (patchQuickCable.js) with the two things
// speech takes away put back: there is no ">" to split on, and no word is
// spelled the way the manual spells it. So the split is guessed rather than
// read — every "to" in the sentence is tried as the join, both halves are
// scored against the jacks the direction allows, and the reading that explains
// the whole sentence best wins. That also settles the one ambiguity English
// hands you for free here: in "…out one to two hp div…", the first "to" is the
// join and the second is the manufacturer's name.
//
// Nothing is plugged on a maybe. Every answer carries a confidence and the
// runners-up, and the caller is expected to refuse a low one and ask.

import {
  normalizeSpeech,
  speechTokens,
  speechWords,
  tokenForms,
  wordScore,
  DEFAULT_CORRECTIONS,
} from './voiceGrammar.js';

// ---- the shape of a sentence ----

// Dropped from the front: they say what to do, not what to do it to.
const CONNECT_VERBS = new Set([
  'connect',
  'patch',
  'plug',
  'route',
  'send',
  'run',
  'wire',
  'cable',
  'take',
  'hook',
  'link',
  'join',
  'feed',
  'put',
  'go',
  'goes',
  'going',
  'up',
  'from',
]);

const DISCONNECT_VERBS = new Set(['disconnect', 'unplug', 'unpatch', 'remove', 'delete', 'pull']);

// Every word that might be the join. "two" and "too" are in here because a
// recogniser writes all three of these the same way about a third of the time,
// and the scoring is a better judge of which one this was than a rule is.
const JOIN_WORDS = new Set([
  'to',
  'too',
  'two',
  'into',
  'onto',
  'unto',
  'toward',
  'towards',
  'through',
  'thru',
]);

// Said at the end, about the cable rather than its ends.
const MODIFIERS = [
  { flag: 'stacked', words: ['stacked', 'stack', 'stackcable', 'multed', 'mult'] },
  { flag: 'optional', words: ['optional', 'provisional', 'maybe', 'tentative'] },
];

const UNDO_PHRASES = ['undo', 'undo that', 'scratch that', 'take that back', 'oops'];
const CANCEL_PHRASES = ['cancel', 'never mind', 'nevermind', 'forget it', 'stop'];

// ---- scoring one end ----

const tokensOf = (text, corrections) => speechTokens(text, { corrections });

// How much of what was said this jack accounts for. Coverage, not a word
// count: a sentence is only about this jack if nearly every meaningful word in
// it points here.
function scoreCandidate(candidate, spoken, corrections) {
  const meaningful = spoken.filter((t) => t.weight > 0);
  if (meaningful.length === 0) return 0;

  const moduleWords = speechWords(candidate.module_label, { corrections });
  const jackWords = speechWords(candidate.jack_name, { corrections });
  const printed = [...moduleWords, ...jackWords];

  const against = (token, word) => Math.max(...tokenForms(token).map((form) => wordScore(form, word)));

  let earned = 0;
  let jackHits = 0;
  for (const token of meaningful) {
    let best = 0;
    for (const word of printed) best = Math.max(best, against(token, word));
    earned += best;
    if (jackWords.some((word) => against(token, word) >= 0.7)) jackHits += 1;
  }
  let points = earned / meaningful.length;

  // Naming the jack is what separates two ends of the same module, so a
  // sentence that names it outright beats one that only found the module.
  if (jackHits > 0 && jackWords.every((word) => meaningful.some((t) => against(t, word) >= 0.7)))
    points += 0.12;

  // "Out one" on a module whose outputs are unnamed means the first of them.
  const spokenDigits = meaningful.filter((t) => /^\d+$/.test(t.word)).map((t) => t.word);
  const jackDigits = jackWords.filter((word) => /^\d+$/.test(word));
  if (spokenDigits.length && !jackDigits.length && candidate.jack_index) {
    if (spokenDigits.includes(String(candidate.jack_index))) points += 0.1;
  }
  // "Out one" is not "out two". A number that contradicts the panel is the
  // clearest possible signal this is the wrong jack.
  if (spokenDigits.length && jackDigits.length && !jackDigits.some((d) => spokenDigits.includes(d)))
    points -= 0.3;

  // Enough to lose a tie against a jack that is still free, and not enough to
  // lose to a different jack you did not ask for: naming an input that already
  // has a cable in it should be answered with that fact, not with its neighbour.
  if (candidate.disabled) points -= 0.12;
  return points;
}

const MIN_SCORE = 0.6;
const MIN_MARGIN = 0.08;

// The best jack for a phrase, how sure that is, and who came close. `best` is
// only filled in when one candidate is clearly ahead — everything else is
// handed back for the caller to ask about.
export function matchSpokenEndpoint(
  text,
  candidates,
  { corrections = DEFAULT_CORRECTIONS, minScore = MIN_SCORE, minMargin = MIN_MARGIN } = {}
) {
  const spoken = tokensOf(text, corrections);
  const empty = { best: null, confidence: 0, margin: 0, matches: [] };
  if (!spoken.some((t) => t.weight > 0) || !candidates?.length) return empty;

  const scored = candidates
    .map((candidate) => ({ candidate, score: scoreCandidate(candidate, spoken, corrections) }))
    .sort((a, b) => b.score - a.score);

  const top = scored[0];
  const runnerUp = scored[1];
  const margin = runnerUp ? top.score - runnerUp.score : top.score;
  const matches = scored.filter((s) => s.score >= minScore * 0.75).slice(0, 5);
  const clear = top.score >= minScore && margin >= minMargin;
  // A jack that scored perfectly and tied with another one was not understood,
  // however well it scored — confidence has to say so, because it is what the
  // panel checks before plugging anything in.
  const sureness = clear ? top.score : top.score * Math.min(1, margin / minMargin);
  return {
    best: clear ? top.candidate : null,
    confidence: Math.max(0, Math.min(1, sureness)),
    margin,
    matches: matches.map((s) => ({ ...s.candidate, score: s.score })),
  };
}

// ---- reading the sentence ----

const startsWithAny = (words, phrases) =>
  phrases.some((phrase) => {
    const parts = phrase.split(' ');
    return parts.every((part, i) => words[i] === part);
  });

function stripVerbs(words, verbs) {
  let i = 0;
  while (i < words.length && verbs.has(words[i])) i += 1;
  return words.slice(i);
}

function takeModifiers(words) {
  const flags = {};
  let end = words.length;
  let moved = true;
  while (moved && end > 0) {
    moved = false;
    const last = words[end - 1];
    for (const { flag, words: markers } of MODIFIERS) {
      if (markers.includes(last)) {
        flags[flag] = true;
        end -= 1;
        moved = true;
        break;
      }
    }
    // "as a stack", "as optional" — the filler between is not worth a rule.
    if (!moved && end > 0 && ['as', 'a', 'an', 'and'].includes(last) && Object.keys(flags).length) {
      end -= 1;
      moved = true;
    }
  }
  return { words: words.slice(0, end), flags };
}

// Try the sentence as if each join word were the join, and keep the reading
// that explains it best. A split where both ends land unambiguously always
// beats one where they do not, however well the halves happen to score.
function bestSplit(words, context, options) {
  const readings = [];
  for (let i = 0; i < words.length; i += 1) {
    if (!JOIN_WORDS.has(words[i])) continue;
    const fromText = words.slice(0, i).join(' ');
    const toText = words.slice(i + 1).join(' ');
    if (!fromText || !toText) continue;
    const from = matchSpokenEndpoint(fromText, context.from, options);
    const to = matchSpokenEndpoint(toText, context.to, options);
    const resolved = (from.best ? 1 : 0) + (to.best ? 1 : 0);
    readings.push({
      index: i,
      fromText,
      toText,
      from,
      to,
      resolved,
      total: from.confidence + to.confidence,
    });
  }
  if (readings.length === 0) return null;
  readings.sort((a, b) => b.resolved - a.resolved || b.total - a.total || a.index - b.index);
  return readings[0];
}

const describe = (end) => (end ? `${end.module_label} — ${end.jack_name}` : '');

function connectResult(reading, flags, base) {
  const result = { ...base, intent: 'connect', ...flags };
  if (!reading) {
    result.error = 'Say it as one cable — "connect maths out one to optomix channel one in"';
    return result;
  }
  Object.assign(result, {
    fromText: reading.fromText,
    toText: reading.toText,
    from: reading.from.best,
    to: reading.to.best,
    confidence: Math.min(reading.from.confidence, reading.to.confidence),
  });
  for (const [side, found, text] of [
    ['source', reading.from, reading.fromText],
    ['destination', reading.to, reading.toText],
  ]) {
    if (found.best) continue;
    result.options = found.matches;
    result.error = found.matches.length
      ? `Which ${side}? "${text}" could be ${found.matches.length} jacks`
      : `Nothing on the ${side} side sounds like "${text}"`;
    return result;
  }
  if (result.to.disabled) {
    result.error = `"${result.to.jack_name}" on ${result.to.module_label} already has a cable in it`;
  }
  return result;
}

// Read one utterance. `context.from` and `context.to` are the jacks each
// direction allows, `context.cables` the cables already plugged (so they can
// be pulled out again by name).
export function parseVoiceCommand(transcript, context = {}, options = {}) {
  const corrections = { ...DEFAULT_CORRECTIONS, ...(context.corrections || {}) };
  const settings = { ...options, corrections };
  const base = {
    transcript: String(transcript ?? ''),
    intent: 'unknown',
    fromText: '',
    toText: '',
    from: null,
    to: null,
    cable: null,
    options: [],
    stacked: false,
    optional: false,
    confidence: 0,
    error: '',
  };

  // Split on the words as they were said, not as they will be matched. A
  // recogniser writes the join as "to", "too" or "two" more or less at random,
  // and by the time a spoken number has become a digit that choice is gone —
  // so the sentence is cut up first and each half is turned into digits after.
  const words = normalizeSpeech(transcript, { corrections }).split(' ').filter(Boolean);
  base.normalized = speechWords(transcript, { corrections }).join(' ');
  if (words.length === 0) return base;

  if (startsWithAny(words, UNDO_PHRASES)) return { ...base, intent: 'undo', confidence: 1 };
  if (startsWithAny(words, CANCEL_PHRASES)) return { ...base, intent: 'cancel', confidence: 1 };

  if (DISCONNECT_VERBS.has(words[0])) {
    const text = stripVerbs(words, DISCONNECT_VERBS).join(' ');
    const found = matchSpokenEndpoint(text, context.cables || [], settings);
    return {
      ...base,
      intent: 'disconnect',
      fromText: text,
      cable: found.best,
      confidence: found.confidence,
      options: found.matches,
      error: found.best
        ? ''
        : found.matches.length
          ? `Which cable? "${text}" could be ${found.matches.length} of them`
          : `No cable sounds like "${text}"`,
    };
  }

  const { words: body, flags } = takeModifiers(stripVerbs(words, CONNECT_VERBS));
  return connectResult(bestSplit(body, { from: context.from || [], to: context.to || [] }, settings), flags, base);
}

// After "which of these did you mean?", the answer is a number — but so is
// half of every cable in the rack ("maths channel one out"), so a number alone
// is not enough to go on. This only reads an utterance as an answer when it is
// nothing but an answer: short, and with no verb and no join in it. Anything
// longer is the whole cable being said again, and has to be parsed as one.
const ORDINALS = new Map(
  Object.entries({ first: 1, second: 2, third: 3, fourth: 4, fifth: 5, one: 1, two: 2, three: 3, four: 4, five: 5 })
);

export function pickedOption(transcript) {
  const words = normalizeSpeech(transcript).split(' ').filter(Boolean);
  if (words.length === 0 || words.length > 4) return null;
  // A verb means a whole command. So does a join with anything either side of
  // it — but "two" on its own is an answer, not a cable, even though it is
  // spelled like a join.
  if (words.some((word) => CONNECT_VERBS.has(word) || DISCONNECT_VERBS.has(word))) return null;
  if (words.length >= 3 && words.some((word) => JOIN_WORDS.has(word))) return null;
  for (const word of words) {
    if (ORDINALS.has(word)) return ORDINALS.get(word);
    if (/^[1-9]$/.test(word)) return Number(word);
  }
  return null;
}

// A recogniser hands back several readings of the same breath and is often
// wrong about which is best — it is ranking English, not eurorack. Reading all
// of them and keeping the one that names a real cable is the single cheapest
// accuracy win available here.
export function parseBestAlternative(alternatives, context = {}, options = {}) {
  const texts = (alternatives || []).map((a) => (typeof a === 'string' ? a : a?.transcript)).filter(Boolean);
  if (texts.length === 0) return parseVoiceCommand('', context, options);
  let winner = null;
  for (const text of texts) {
    const parsed = parseVoiceCommand(text, context, options);
    const usable = parsed.intent !== 'unknown' && !parsed.error;
    const rank = (usable ? 1 : 0) + parsed.confidence;
    if (!winner || rank > winner.rank) winner = { parsed, rank };
    if (usable && parsed.confidence >= 0.95) break;
  }
  return winner.parsed;
}

export { describe as describeEndpoint };
