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

  const response = await mk.api.music('/v1/me/library/playlists', {
    limit: 100,
  });

  return response.data.data.map((p) => ({
    id: p.id,
    name: p.attributes.name,
    image: p.attributes.artwork
      ? window.MusicKit.formatArtworkURL(p.attributes.artwork, 300, 300)
      : null,
    trackCount: p.attributes.trackCount || 0,
  }));
}

/**
 * Fetch tracks from an Apple Music library playlist.
 *
 * @param {string} playlistId
 * @returns {Promise<Array<{ title: string, artist: string, art: string|null, uri: string }>>}
 */
export async function fetchPlaylistTracks(playlistId) {
  const mk = getMusicKit() || await initMusicKit();

  const response = await mk.api.music(`/v1/me/library/playlists/${playlistId}/tracks`, {
    limit: 100,
  });

  return response.data.data
    .filter((t) => t.attributes)
    .map((t) => ({
      title: t.attributes.name,
      artist: t.attributes.artistName,
      art: t.attributes.artwork
        ? window.MusicKit.formatArtworkURL(t.attributes.artwork, 300, 300)
        : null,
      uri: `apple:track:${t.id}`,
    }));
}
