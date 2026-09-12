/**
 * Apple Music API helpers.
 *
 * Fetches user playlists and track data via MusicKit JS.
 */

import { getMusicKit, initMusicKit } from './auth.js';

/**
 * Fetch the user's Apple Music library playlists.
 *
 * @returns {Promise<Array<{ id: string, name: string, image: string|null, trackCount: number }>>}
 */
export async function fetchMyPlaylists() {
  const mk = getMusicKit() || await initMusicKit();

  const playlists = [];
  let path = '/v1/me/library/playlists';
  let params = { limit: 100 };
  while (path) {
    const response = await mk.api.music(path, params);
    for (const p of response.data.data) {
      playlists.push({
        id: p.id,
        name: p.attributes.name,
        image: p.attributes.artwork
          ? window.MusicKit.formatArtworkURL(p.attributes.artwork, 300, 300)
          : null,
        trackCount: p.attributes.trackCount || 0,
      });
    }
    path = response.data.next || null;
    params = {}; // `next` already encodes limit/offset
  }
  return playlists;
}

/**
 * Fetch tracks from an Apple Music library playlist.
 *
 * @param {string} playlistId
 * @returns {Promise<Array<{ title: string, artist: string, art: string|null, uri: string }>>}
 */
export async function fetchPlaylistTracks(playlistId) {
  const mk = getMusicKit() || await initMusicKit();

  const tracks = [];
  let path = `/v1/me/library/playlists/${playlistId}/tracks`;
  let params = { limit: 100 };
  while (path) {
    const response = await mk.api.music(path, params);
    for (const t of response.data.data) {
      if (!t.attributes) continue;
      tracks.push({
        title: t.attributes.name,
        artist: t.attributes.artistName,
        art: t.attributes.artwork
          ? window.MusicKit.formatArtworkURL(t.attributes.artwork, 300, 300)
          : null,
        uri: `apple:track:${t.id}`,
      });
    }
    path = response.data.next || null;
    params = {};
  }
  return tracks;
}
