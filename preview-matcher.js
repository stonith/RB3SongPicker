const { normalize } = require('./preview-store');

function appleUrl(value, audio = false) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    const hosts = audio ? ['itunes.apple.com', 'mzstatic.com', 'apple.com'] : ['music.apple.com', 'itunes.apple.com'];
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
    if (!hosts.some(host => url.hostname === host || (audio && url.hostname.endsWith(`.${host}`)))) return null;
    return url.href;
  } catch { return null; }
}

function titleKey(value) {
  // Remaster labels identify releases, not live/remixed/re-recorded performances.
  return normalize(String(value || '')
    .replace(/[([][^)\]]*\bremaster(?:ed)?\b[^)\]]*[)\]]/gi, '')
    .replace(/\s*[-–—]\s*(?:\d{4}\s+)?remaster(?:ed)?(?:\s+\d{4})?\s*$/gi, ''));
}

function versionKey(value) {
  const text = normalize(value);
  return ['live', 'acoustic', 'remix', 'instrumental', 'karaoke', 'demo', 'tribute', 'radio edit', 're recorded', 'rerecorded']
    .filter(version => ` ${text} `.includes(` ${version} `)).join('|');
}

function matchPreview(song, candidates) {
  const title = titleKey(song.title);
  const artist = normalize(song.artist);
  if (!title || !artist) return { status: 'unavailable' };
  const ranked = [];
  for (const candidate of candidates) {
    if (!candidate || !Number.isSafeInteger(candidate.trackId) || candidate.trackId <= 0) continue;
    const previewUrl = appleUrl(candidate.previewUrl, true);
    const storeUrl = appleUrl(candidate.trackViewUrl);
    if (!previewUrl || !storeUrl || normalize(candidate.artistName) !== artist) continue;
    if (versionKey(song.title) !== versionKey(candidate.trackName)) continue;
    const candidateTitle = titleKey(candidate.trackName);
    if (candidateTitle !== title) continue;
    const albumMatch = normalize(song.album) && normalize(song.album) === normalize(candidate.collectionName);
    ranked.push({ status: 'matched', trackId: candidate.trackId, previewUrl, storeUrl,
      title: candidate.trackName, artist: candidate.artistName, album: candidate.collectionName || '',
      confidence: albumMatch ? 1 : 0.95, identity: `${artist}|${candidateTitle}` });
  }
  ranked.sort((a, b) => b.confidence - a.confidence || a.trackId - b.trackId);
  if (!ranked.length) return { status: 'unavailable' };
  // Equivalent reissues are interchangeable for recognition; never guess between
  // different recording identities if broader matching is added in the future.
  if (ranked[1] && ranked[0].identity !== ranked[1].identity && ranked[0].confidence - ranked[1].confidence < 0.1) {
    return { status: 'ambiguous' };
  }
  const { identity, ...result } = ranked[0];
  return result;
}

module.exports = { matchPreview, appleUrl };
