import { describe, it, expect } from 'vitest';
import { parseLrc, activeLyricIndex } from './lrc.js';

describe('parseLrc', () => {
  it('parses timed lines in order', () => {
    const lrc = '[00:10.00]first\n[00:05.50]zeroth\n[01:02.34]later';
    expect(parseLrc(lrc)).toEqual([
      { time: 5.5, text: 'zeroth' },
      { time: 10, text: 'first' },
      { time: 62.34, text: 'later' },
    ]);
  });

  it('expands multiple timestamps on one line', () => {
    const lrc = '[00:10.00][00:20.00]repeated chorus';
    expect(parseLrc(lrc)).toEqual([
      { time: 10, text: 'repeated chorus' },
      { time: 20, text: 'repeated chorus' },
    ]);
  });

  it('skips metadata tags and untimed lines', () => {
    const lrc = '[ti:Song Title]\n[ar:Artist]\nplain text line\n[00:01.00]real lyric';
    expect(parseLrc(lrc)).toEqual([{ time: 1, text: 'real lyric' }]);
  });

  it('keeps empty lyric text (instrumental breaks)', () => {
    expect(parseLrc('[00:10.00]')).toEqual([{ time: 10, text: '' }]);
  });

  it('returns [] for empty/garbage input', () => {
    expect(parseLrc('')).toEqual([]);
    expect(parseLrc(null)).toEqual([]);
    expect(parseLrc('no timestamps here')).toEqual([]);
  });
});

describe('activeLyricIndex', () => {
  const lines = [
    { time: 5, text: 'a' },
    { time: 10, text: 'b' },
    { time: 20, text: 'c' },
  ];

  it('returns -1 before the first line', () => {
    expect(activeLyricIndex(lines, 0)).toBe(-1);
    expect(activeLyricIndex(lines, 4.99)).toBe(-1);
  });

  it('returns the last line at or before t', () => {
    expect(activeLyricIndex(lines, 5)).toBe(0);
    expect(activeLyricIndex(lines, 15)).toBe(1);
    expect(activeLyricIndex(lines, 100)).toBe(2);
  });

  it('handles empty lines', () => {
    expect(activeLyricIndex([], 10)).toBe(-1);
  });
});
