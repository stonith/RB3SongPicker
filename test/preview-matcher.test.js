const { matchPreview } = require('../preview-matcher');
const song = { title: 'Somebody to Love', artist: 'Queen', album: 'A Day at the Races' };
const candidate = (overrides = {}) => ({ trackId: 1, trackName: song.title, artistName: song.artist,
  collectionName: song.album, previewUrl: 'https://audio-ssl.itunes.apple.com/clip.m4a',
  trackViewUrl: 'https://music.apple.com/us/album/song/1', ...overrides });

test('accepts normalized titles and remasters, with album as supporting evidence', () => {
  expect(matchPreview(song, [candidate({ trackName: 'Somebody To Love (2011 Remaster)' })]).status).toBe('matched');
  expect(matchPreview({ title: 'Déjà Vu', artist: 'Beyoncé' }, [candidate({ trackName: 'Deja Vu', artistName: 'Beyonce' })]).status).toBe('matched');
  expect(matchPreview(song, [candidate({ collectionName: 'Greatest Hits' })]).status).toBe('matched');
});
test('rejects covers, different recordings, empty metadata and missing or unsafe clips', () => {
  for (const changes of [{ artistName: 'Queen Tribute' }, { trackName: 'Somebody to Love (Live)' },
    { trackName: 'Somebody to Love (Acoustic)' }, { trackName: 'Somebody to Love (Remix)' },
    { previewUrl: null }, { previewUrl: 'javascript:alert(1)' }, { previewUrl: 'https://evil.test/clip' },
    { trackViewUrl: 'https://music.apple.com.evil.test/song' }]) {
    expect(matchPreview(song, [candidate(changes)]).status).toBe('unavailable');
  }
  expect(matchPreview({ ...song, artist: '' }, [candidate()]).status).toBe('unavailable');
});
test('equivalent album reissues are not false ambiguity, but unclear titles are rejected', () => {
  expect(matchPreview(song, [candidate(), candidate({ trackId: 2, collectionName: 'Greatest Hits' })]).trackId).toBe(1);
  expect(matchPreview(song, [candidate({ trackName: 'Somebody to Love Again' })]).status).toBe('unavailable');
});
