// One line, one cable: "maths eor > optomix ch1 in".
//
// Once you know your own rack, naming both ends is faster than any number of
// dropdowns — you already know the cable you are about to plug. Each side is
// matched against every (module instance, jack) the direction allows: every
// word you type must appear somewhere in "<manufacturer> <module> <role> —
// <jack>", so you can be as brief as your rack lets you be ("maths eor") and
// as specific as it needs ("doepfer a-180-2 #2 m1").
//
// Nothing is guessed. When a side matches several jacks the caller is handed
// the candidates to show, and nothing is plugged until one of them is the
// only answer.

// "a > b", "a -> b", "a → b".
const SEPARATOR = /\s*(?:->|=>|→|>)\s*/;

export function splitQuickCable(text) {
  const parts = String(text ?? '').split(SEPARATOR);
  return { from: (parts[0] ?? '').trim(), to: parts.slice(1).join(' ').trim(), parts: parts.length };
}

const haystack = (candidate) => `${candidate.module_label} ${candidate.jack_name}`.toLowerCase();

// How well a candidate answers to the words typed. The jack name is what
// makes an end unambiguous, so naming it outright beats matching it loosely,
// and a jack that cannot take the cable loses to one that can.
function score(candidate, tokens) {
  const jack = candidate.jack_name.toLowerCase();
  let points = 0;
  if (tokens.includes(jack)) points += 4;
  else if (tokens.some((t) => jack.startsWith(t))) points += 2;
  else if (tokens.some((t) => jack.includes(t))) points += 1;
  if (candidate.disabled) points -= 3;
  return points;
}

// Every candidate containing all of the typed words, and the single best one
// when there is a single best one.
export function matchEndpoint(text, candidates) {
  const tokens = String(text ?? '')
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  if (tokens.length === 0) return { matches: [], best: null };
  const matches = candidates.filter((c) => {
    const hay = haystack(c);
    return tokens.every((t) => hay.includes(t));
  });
  if (matches.length === 0) return { matches: [], best: null };
  if (matches.length === 1) return { matches, best: matches[0] };
  const scored = matches.map((c) => ({ c, points: score(c, tokens) }));
  const top = Math.max(...scored.map((s) => s.points));
  const winners = scored.filter((s) => s.points === top);
  return { matches, best: winners.length === 1 ? winners[0].c : null };
}

// Resolve a whole line. Returns both ends when the line names exactly one
// cable, and otherwise says which side is the problem and why — the caller
// shows that as you type rather than after you press Enter.
export function parseQuickCable(text, { from: fromCandidates = [], to: toCandidates = [] } = {}) {
  const { from: fromText, to: toText, parts } = splitQuickCable(text);
  const result = { fromText, toText, from: null, to: null, matches: [], error: '' };
  if (!fromText && !toText) return result;
  if (parts < 2 || !toText) {
    result.error = 'Name both ends: source > destination';
    return result;
  }
  const source = matchEndpoint(fromText, fromCandidates);
  const destination = matchEndpoint(toText, toCandidates);
  result.from = source.best;
  result.to = destination.best;

  for (const [side, text_, found] of [
    ['source', fromText, source],
    ['destination', toText, destination],
  ]) {
    if (found.best) continue;
    result.matches = found.matches;
    result.error =
      found.matches.length === 0
        ? `Nothing on the ${side} side matches "${text_}"`
        : `"${text_}" could be ${found.matches.length} different jacks — add a word`;
    return result;
  }
  if (result.from.disabled || result.to.disabled) {
    result.error = result.to.disabled
      ? `"${result.to.jack_name}" on ${result.to.module_label} already has a cable in it`
      : `"${result.from.jack_name}" on ${result.from.module_label} cannot send this cable`;
  }
  return result;
}
