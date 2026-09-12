/**
 * LRC parser + active-line lookup.
 *
 * Handles: [mm:ss.xx] timestamps, multiple timestamps per line, metadata
 * tags ([ti:][ar:] etc. are skipped since they lack a time pattern),
 * malformed/untimed lines.
 */

const TIME_RE = /\[(\d+):(\d+(?:\.\d+)?)\]/g;

export function parseLrc(text) {
  if (!text) return [];
  const lines = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const matches = [...raw.matchAll(TIME_RE)];
    if (!matches.length) continue;
    const lyric = raw.replace(TIME_RE, '').replace(/\[[^\]]*\]/g, '').trim();
    for (const m of matches) {
      lines.push({ time: parseInt(m[1], 10) * 60 + parseFloat(m[2]), text: lyric });
    }
  }
  return lines.sort((a, b) => a.time - b.time);
}

/**
 * Index of the line currently being sung — the last line with
 * time <= currentTime. -1 before the first line.
 */
export function activeLyricIndex(lines, currentTime) {
  let lo = 0, hi = lines.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].time <= currentTime) { ans = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return ans;
}
