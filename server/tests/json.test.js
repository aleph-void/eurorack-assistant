import { describe, it, expect } from 'vitest';
import { extractJsonArray, extractJsonObject } from '../src/services/json.js';

describe('extractJsonArray', () => {
  it('parses a bare JSON array', () => {
    expect(extractJsonArray('[1, 2, 3]')).toEqual([1, 2, 3]);
  });

  it('parses an array inside a code fence', () => {
    const text = 'Here you go:\n```json\n[{"a": 1}]\n```\nThanks!';
    expect(extractJsonArray(text)).toEqual([{ a: 1 }]);
  });

  it('parses an array surrounded by prose', () => {
    const text = 'The modules are: [{"manufacturer": "Make Noise", "module": "Maths"}] hope that helps';
    expect(extractJsonArray(text)).toEqual([{ manufacturer: 'Make Noise', module: 'Maths' }]);
  });

  it('throws when no array is present', () => {
    expect(() => extractJsonArray('no json here')).toThrow(/No JSON array/);
  });
});

describe('extractJsonObject', () => {
  it('parses a bare JSON object', () => {
    expect(extractJsonObject('{"a": 1}')).toEqual({ a: 1 });
  });

  it('parses an object inside a code fence', () => {
    expect(extractJsonObject('```json\n{"pdf_urls": []}\n```')).toEqual({ pdf_urls: [] });
  });

  it('parses an object with nested braces surrounded by prose', () => {
    const text = 'Result: {"a": {"b": 2}, "c": [1]} done.';
    expect(extractJsonObject(text)).toEqual({ a: { b: 2 }, c: [1] });
  });

  it('throws when no object is present', () => {
    expect(() => extractJsonObject('nope')).toThrow(/No JSON object/);
  });
});
