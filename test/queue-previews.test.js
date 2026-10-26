const { QueuePreviewCache, queuePreviewSongs } = require('../public/queue-previews');
const song = shortname => ({ shortname, title: shortname });
const snapshot = entries => ({ session: { entries, lockedEntryId: null, currentAttempt: null } });

test('collects current and upcoming songs once per shortname, excluding handled history', () => {
  const value = snapshot([{ ...song('a'), status: 'pending' }, { ...song('a'), status: 'pending' }, { ...song('b'), status: 'handled' }]);
  value.session.currentAttempt = { shortname: 'x', entryId: null };
  expect(queuePreviewSongs(value).map(s => s.shortname)).toEqual(['x', 'a']);
});
test('looks up only cached metadata in batches, deduplicates repeats and reuses recent matches', async () => {
  const fetch = jest.fn(async (url, request) => ({ ok: true, json: async () => ({ songs: JSON.parse(request.body).shortnames.map(shortname => ({ shortname, preview: { status: 'matched', previewUrl: 'https://example.test/clip' } })) }) }));
  const cache = new QueuePreviewCache({ fetch, now: () => 100 });
  cache.configure({ enabled: true, country: 'US' });
  const songs = Array.from({ length: 205 }, (_, i) => song(String(i)));
  await cache.refresh([...songs, songs[0]]);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(fetch.mock.calls.every(([url]) => url === '/api/previews/lookup')).toBe(true);
  expect(JSON.parse(fetch.mock.calls[0][1].body).shortnames).toHaveLength(200);
  expect(cache.get('0').status).toBe('matched');
  await cache.refresh(songs); expect(fetch).toHaveBeenCalledTimes(2);
});
test('country change and disabling discard a late response, and disabled previews make no lookup', async () => {
  let resolve;
  const fetch = jest.fn(() => new Promise(done => { resolve = done; }));
  const cache = new QueuePreviewCache({ fetch });
  await cache.refresh([song('a')]); expect(fetch).not.toHaveBeenCalled();
  cache.configure({ enabled: true, country: 'US' });
  const pending = cache.refresh([song('a')]);
  cache.configure({ enabled: false, country: 'GB' });
  resolve({ ok: true, json: async () => ({ songs: [{ shortname: 'a', preview: { status: 'matched' } }] }) });
  await pending; expect(cache.get('a')).toBeUndefined();
});
test('requests songs added while a lookup is in flight without mutating queue entries', async () => {
  let resolve;
  const fetch = jest.fn().mockImplementationOnce(() => new Promise(done => { resolve = done; }))
    .mockResolvedValue({ ok: true, json: async () => ({ songs: [{ shortname: 'b', preview: { status: 'unavailable' } }] }) });
  const cache = new QueuePreviewCache({ fetch }); cache.configure({ enabled: true, country: 'US' });
  const a = song('a'), b = song('b');
  const pending = cache.refresh([a]); cache.refresh([a, b]);
  resolve({ ok: true, json: async () => ({ songs: [{ shortname: 'a', preview: { status: 'matched' } }] }) });
  await pending;
  expect(fetch).toHaveBeenCalledTimes(2); expect(cache.get('b').status).toBe('unavailable');
  expect(a).toEqual(song('a')); expect(b).toEqual(song('b'));
});
test('a slow large lookup does not repeatedly re-fetch earlier batches after TTL expires', async () => {
  let now = 0;
  const fetch = jest.fn(async (url, request) => {
    if (fetch.mock.calls.length > 2) throw new Error('Repeated an earlier batch');
    now += 20000;
    return { ok: true, json: async () => ({ songs: JSON.parse(request.body).shortnames.map(shortname => ({ shortname, preview: { status: 'matched' } })) }) };
  });
  const cache = new QueuePreviewCache({ fetch, now: () => now });
  cache.configure({ enabled: true, country: 'US' });
  await cache.refresh(Array.from({ length: 205 }, (_, i) => song(String(i))));
  expect(fetch).toHaveBeenCalledTimes(2);
});
test('a new storefront lookup follows an obsolete in-flight response without accepting its matches', async () => {
  let resolve;
  const fetch = jest.fn().mockImplementationOnce(() => new Promise(done => { resolve = done; }))
    .mockResolvedValue({ ok: true, json: async () => ({ songs: [{ shortname: 'a', preview: { status: 'matched', previewUrl: 'GB' } }] }) });
  const cache = new QueuePreviewCache({ fetch }); cache.configure({ enabled: true, country: 'US' });
  const old = cache.refresh([song('a')]);
  cache.configure({ enabled: true, country: 'GB' });
  const next = cache.refresh([song('a')]);
  resolve({ ok: true, json: async () => ({ songs: [{ shortname: 'a', preview: { status: 'matched', previewUrl: 'US' } }] }) });
  await old; await next;
  expect(cache.get('a').previewUrl).toBe('GB'); expect(fetch).toHaveBeenCalledTimes(2);
});
test('a failed lookup is retryable and never makes queue selection requests', async () => {
  const fetch = jest.fn().mockResolvedValueOnce({ ok: false }).mockResolvedValueOnce({ ok: true, json: async () => ({ songs: [] }) });
  const cache = new QueuePreviewCache({ fetch }); cache.configure({ enabled: true, country: 'US' });
  await expect(cache.refresh([song('a')])).rejects.toThrow();
  await cache.refresh([song('a')]); expect(cache.get('a').status).toBe('unavailable');
  expect(fetch).toHaveBeenCalledTimes(2);
});
