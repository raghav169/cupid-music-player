import { describe, it, expect } from 'vitest';
import { computeGuestActions, sameTrack } from './sync.js';

const host = (over = {}) => ({
  track: { title: 'Song', artist: 'Artist', videoId: 'abc' },
  position: 30,
  isPlaying: true,
  sentAt: 1000,
  ...over,
});

const guest = (over = {}) => ({
  track: { title: 'Song', artist: 'Artist', videoId: 'abc' },
  currentTime: 30,
  isPlaying: true,
  duration: 200,
  ...over,
});

describe('sameTrack', () => {
  it('prefers videoId/uri/file over title match', () => {
    expect(sameTrack({ videoId: 'a' }, { videoId: 'a' })).toBe(true);
    expect(sameTrack({ videoId: 'a' }, { videoId: 'b' })).toBe(false);
    expect(sameTrack({ uri: 'u1' }, { uri: 'u1' })).toBe(true);
    expect(sameTrack({ file: 'x.mp3' }, { file: 'x.mp3' })).toBe(true);
  });
  it('falls back to title+artist', () => {
    expect(sameTrack({ title: 'S', artist: 'A' }, { title: 'S', artist: 'A' })).toBe(true);
    expect(sameTrack({ title: 'S', artist: 'A' }, { title: 'S', artist: 'B' })).toBe(false);
  });
});

describe('computeGuestActions', () => {
  it('loads the host track when songs differ', () => {
    const a = computeGuestActions(host(), guest({ track: { title: 'Other' } }), 1000);
    expect(a.loadTrack?.title).toBe('Song');
    expect(a.playing).toBe(true);
  });

  it('no-ops when in sync', () => {
    // guest at 30 + 0.5s elapsed since send → expected 30.5, guest at 30.4
    const a = computeGuestActions(host(), guest({ currentTime: 30.4 }), 1500);
    expect(a).toEqual({ loadTrack: null, seek: null, playing: null });
  });

  it('seeks when drift exceeds tolerance', () => {
    const a = computeGuestActions(host(), guest({ currentTime: 28 }), 1500);
    expect(a.seek).toBeCloseTo(30.5);
  });

  it('accounts for elapsed time when host is playing', () => {
    // 2s elapsed since host sent position=30 → expected 32
    const a = computeGuestActions(host(), guest({ currentTime: 30 }), 3000);
    expect(a.seek).toBeCloseTo(32);
  });

  it('does not extrapolate when host is paused', () => {
    const a = computeGuestActions(
      host({ isPlaying: false }),
      guest({ isPlaying: false, currentTime: 28 }),
      99999,
    );
    expect(a.seek).toBeCloseTo(30); // fixed position, no time added
  });

  it('forces play/pause to match host', () => {
    const a = computeGuestActions(host({ isPlaying: false }), guest(), 1000);
    expect(a.playing).toBe(false);
  });
});
