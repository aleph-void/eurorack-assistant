import { describe, it, expect } from 'vitest';
import {
  normalizeSpeech,
  speechTokens,
  speechWords,
  soundKey,
  similarity,
  wordScore,
} from '../src/voiceGrammar.js';

describe('normalizeSpeech', () => {
  it('lowercases and drops punctuation', () => {
    expect(normalizeSpeech('Connect Maths, out 1!')).toBe('connect maths out 1');
  });

  it('prises apart a digit welded to a letter, both ways', () => {
    expect(normalizeSpeech('2hp Div')).toBe('2 hp div');
    expect(normalizeSpeech('Ch1 Signal')).toBe('ch 1 signal');
  });

  it('fixes the phrases a recogniser reliably mishears', () => {
    expect(normalizeSpeech('end of cycle')).toBe('eoc');
    expect(normalizeSpeech('volt per octave')).toBe('v oct');
  });

  it('survives nothing at all', () => {
    expect(normalizeSpeech(undefined)).toBe('');
    expect(normalizeSpeech('   ')).toBe('');
  });
});

describe('speechTokens', () => {
  const words = (text) => speechTokens(text).map((t) => t.word);

  it('turns spoken numbers into digits', () => {
    expect(words('channel one')).toEqual(['ch', '1']);
    expect(words('out four')).toEqual(['out', '4']);
  });

  it('reads "two hp" the way the panel is printed', () => {
    expect(words('two hp div')).toEqual(['2', 'hp', 'div']);
    expect(words('2hp div')).toEqual(['2', 'hp', 'div']);
  });

  it('folds interchangeable words onto one spelling', () => {
    expect(words('output')).toEqual(['out']);
    expect(words('input')).toEqual(['in']);
    expect(words('clock')).toEqual(['clk']);
  });

  it('gives habit words no weight', () => {
    const tokens = speechTokens('the out jack on maths');
    expect(tokens.filter((t) => t.weight > 0).map((t) => t.word)).toEqual(['out', 'maths']);
  });

  it('joins spelled-out letters into the word they spell, keeping the letters', () => {
    const tokens = speechTokens('e o r');
    expect(tokens).toHaveLength(1);
    expect(tokens[0].word).toBe('eor');
    expect(tokens[0].alt).toEqual(['e', 'o', 'r']);
    expect(speechWords('e o r')).toEqual(['e', 'o', 'r']);
  });

  it('does not join a single letter to nothing', () => {
    expect(words('v oct')).toEqual(['v', 'oct']);
  });
});

describe('sounding alike', () => {
  it('keys the mistakes a recogniser makes onto the real word', () => {
    expect(soundKey('maths')).toBe(soundKey('mats'));
    expect(soundKey('plaits')).toBe(soundKey('plates'));
  });

  it('keeps different jacks apart', () => {
    expect(soundKey('signal')).not.toBe(soundKey('trigger'));
  });

  it('measures likeness between 0 and 1', () => {
    expect(similarity('maths', 'maths')).toBe(1);
    expect(similarity('maths', 'moths')).toBeGreaterThan(0.7);
    expect(similarity('maths', 'plaits')).toBeLessThan(0.6);
    expect(similarity('', 'maths')).toBe(0);
  });
});

describe('wordScore', () => {
  it('rewards saying it outright above sounding like it', () => {
    expect(wordScore('eor', 'eor')).toBe(1);
    expect(wordScore('mats', 'maths')).toBeGreaterThan(0.5);
    expect(wordScore('mats', 'maths')).toBeLessThan(1);
  });

  it('never treats one number as nearly another', () => {
    expect(wordScore('1', '2')).toBe(0);
    expect(wordScore('1', '1')).toBe(1);
    expect(wordScore('11', '1')).toBe(0);
  });

  it('will not match a jack on one shared letter', () => {
    expect(wordScore('in', 'oscillator')).toBe(0);
  });
});
