import { describe, it, expect } from 'vitest';
import { parsePlaylistUrl } from './api.js';

describe('youtube parsePlaylistUrl', () => {
  it('parses playlist URLs', () => {
    expect(parsePlaylistUrl('https://www.youtube.com/playlist?list=PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf'))
      .toBe('PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf');
  });

  it('parses music.youtube.com URLs', () => {
    expect(parsePlaylistUrl('https://music.youtube.com/playlist?list=OLAK5uy_abc'))
      .toBe('OLAK5uy_abc');
  });

  it('parses watch URLs with a list param', () => {
    expect(parsePlaylistUrl('https://youtu.be/dQw4w9WgXcQ?list=PLabc123def456'))
      .toBe('PLabc123def456');
  });

  it('accepts bare playlist IDs with known prefixes', () => {
    expect(parsePlaylistUrl('PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf'))
      .toBe('PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf');
    expect(parsePlaylistUrl('LLaaaaaaaaaaa')).toBe('LLaaaaaaaaaaa');
  });

  it('rejects bare IDs without a playlist prefix', () => {
    expect(parsePlaylistUrl('dQw4w9WgXcQxxxxx')).toBeNull();
  });

  it('rejects URLs without a list param and garbage', () => {
    expect(parsePlaylistUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBeNull();
    expect(parsePlaylistUrl('not a url')).toBeNull();
    expect(parsePlaylistUrl('')).toBeNull();
    expect(parsePlaylistUrl(null)).toBeNull();
  });
});
