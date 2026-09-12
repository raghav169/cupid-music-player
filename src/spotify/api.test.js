import { describe, it, expect } from 'vitest';
import { parsePlaylistUrl } from './api.js';

describe('spotify parsePlaylistUrl', () => {
  it('parses web URLs', () => {
    expect(parsePlaylistUrl('https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M'))
      .toBe('37i9dQZF1DXcBWIGoYBM5M');
  });

  it('parses web URLs with query params', () => {
    expect(parsePlaylistUrl('https://open.spotify.com/playlist/abc123?si=xyz'))
      .toBe('abc123');
  });

  it('parses spotify: URIs', () => {
    expect(parsePlaylistUrl('spotify:playlist:37i9dQZF1DXcBWIGoYBM5M'))
      .toBe('37i9dQZF1DXcBWIGoYBM5M');
  });

  it('rejects non-playlist spotify URLs', () => {
    expect(parsePlaylistUrl('https://open.spotify.com/track/abc123')).toBeNull();
  });

  it('rejects non-spotify URLs and garbage', () => {
    expect(parsePlaylistUrl('https://example.com/playlist/abc')).toBeNull();
    expect(parsePlaylistUrl('not a url')).toBeNull();
    expect(parsePlaylistUrl('')).toBeNull();
    expect(parsePlaylistUrl(null)).toBeNull();
  });
});
