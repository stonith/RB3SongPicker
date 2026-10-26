const Database = require('../database');
const PreviewStore = require('../preview-store');
const PreviewWorker = require('../preview-worker');

describe('preview worker pacing and recovery', () => {
  let db, store, provider, worker, now, starts;
  beforeEach(async () => {
    now = 100000;
    starts = [];
    db = new Database(':memory:');
    store = new PreviewStore(db);
    await store.initialize();
    await store.configure({ enabled: true, country: 'US', negativeDays: 30 });
    provider = { search: jest.fn(async () => { starts.push(now); return []; }) };
    worker = new PreviewWorker(store, provider, { now: () => now, random: () => 0 });
  });
  afterEach(async () => { await worker.stop(); await db.close(); });
  async function songs(count = 3, same = false) {
    await db.transaction(async () => {
      for (let i = 0; i < count; i++) await db.promisifyRun(
        'INSERT INTO songs (shortname, title, artist) VALUES (?, ?, ?)', [String(i).padStart(3, '0'), same ? 'Song' : `Song ${i}`, 'Artist']);
    });
    await store.reconcile('US', now);
  }
  test('spaces every request by 3.5 seconds and respects pause', async () => {
    await songs();
    await worker.runOnce();
    await worker.runOnce();
    expect(starts).toEqual([100000]);
    now += 3499; await worker.runOnce();
    expect(starts).toHaveLength(1);
    now++; await worker.runOnce();
    expect(starts).toEqual([100000, 103500]);
    await store.configure({ enabled: false, country: 'US', negativeDays: 30 });
    now += 3500; await worker.runOnce();
    expect(starts).toHaveLength(2);
  });
  test('identical searches reuse cached candidates with zero additional calls', async () => {
    await songs(3, true);
    for (let i = 0; i < 3; i++) await worker.runOnce();
    expect(starts).toHaveLength(1);
    expect((await store.status(now)).counts.unavailable).toBe(3);
  });
  test('provider-wide Retry-After survives worker restart and affects unrelated jobs', async () => {
    await songs();
    provider.search.mockImplementationOnce(async () => {
      starts.push(now);
      throw Object.assign(new Error('limited'), { status: 429, retryAfterMs: 120000 });
    });
    await worker.runOnce();
    worker = new PreviewWorker(store, provider, { now: () => now, random: () => 0 });
    now += 119999; await worker.runOnce();
    expect(starts).toHaveLength(1);
    now++; await worker.runOnce();
    expect(starts).toHaveLength(2);
    expect(await store.cachedSearch('missing', now)).toBeNull();
  });
  test('concurrent ticks do not duplicate requests; outage is not cached as no-match', async () => {
    await songs();
    provider.search.mockRejectedValueOnce(new Error('network down'));
    await Promise.all([worker.runOnce(), worker.runOnce(), worker.runOnce()]);
    expect(provider.search).toHaveBeenCalledTimes(1);
    expect((await store.status(now)).counts.retry).toBe(1);
    expect((await store.status(now)).counts.unavailable).toBeUndefined();
  });
  test('restart never refills the normal request budget', async () => {
    await songs();
    await worker.runOnce();
    worker = new PreviewWorker(store, provider, { now: () => now, random: () => 0 });
    now += 3499; await worker.runOnce();
    expect(provider.search).toHaveBeenCalledTimes(1);
    now++; await worker.runOnce();
    expect(provider.search).toHaveBeenCalledTimes(2);
  });
  test('metadata changed during a provider request cannot publish a stale match', async () => {
    await songs(1);
    let resolveSearch, entered;
    const started = new Promise(resolve => { entered = resolve; });
    provider.search.mockImplementationOnce(() => {
      entered();
      return new Promise(resolve => { resolveSearch = resolve; });
    });
    const tick = worker.runOnce();
    await started;
    await db.promisifyRun("UPDATE songs SET title = 'Changed'");
    resolveSearch([{ trackId: 1, trackName: 'Song 0', artistName: 'Artist',
      previewUrl: 'https://audio-ssl.itunes.apple.com/clip.m4a', trackViewUrl: 'https://music.apple.com/us/album/1' }]);
    await tick;
    expect((await store.status(now)).counts.matched || 0).toBe(0);
    expect((await store.decorate(await db.promisifyAll('SELECT * FROM songs')))[0].preview).toEqual({ status: 'pending' });
  });
  test('pausing mid-request retains reusable candidates but does not publish new matches', async () => {
    await songs(1);
    let resolveSearch, entered;
    const started = new Promise(resolve => { entered = resolve; });
    provider.search.mockImplementationOnce(() => {
      entered();
      return new Promise(resolve => { resolveSearch = resolve; });
    });
    const tick = worker.runOnce();
    await started;
    await store.configure({ enabled: false, country: 'US', negativeDays: 30 });
    resolveSearch([]);
    await tick;
    expect((await store.status(now)).counts.retry).toBe(1);
    await store.configure({ enabled: true, country: 'US', negativeDays: 30 });
    await worker.runOnce();
    expect(provider.search).toHaveBeenCalledTimes(1);
    expect((await store.status(now)).counts.unavailable).toBe(1);
  });
  test('a transient completion failure recovers the processing job and reuses the fetched cache', async () => {
    await songs(1);
    jest.spyOn(store, 'complete').mockRejectedValueOnce(new Error('temporary database failure'));
    await expect(worker.runOnce()).rejects.toThrow('temporary database failure');
    expect((await store.status(now)).counts.retry).toBe(1);
    await worker.runOnce();
    expect(provider.search).toHaveBeenCalledTimes(1);
    expect((await store.status(now)).counts.unavailable).toBe(1);
  });
  test('album edits reuse candidate cache, and switching back to a matched storefront needs no search', async () => {
    await songs(1);
    provider.search.mockResolvedValue([{ trackId: 1, trackName: 'Song 0', artistName: 'Artist',
      previewUrl: 'https://audio-ssl.itunes.apple.com/clip.m4a', trackViewUrl: 'https://music.apple.com/us/album/1' }]);
    await worker.runOnce();
    await db.promisifyRun("UPDATE songs SET album = 'Compilation'");
    worker.requestReconcile();
    await worker.runOnce();
    expect((await store.status(now)).counts.matched).toBe(1);
    await store.configure({ enabled: true, country: 'GB', negativeDays: 30 });
    worker.requestReconcile(); await worker.runOnce();
    await store.configure({ enabled: true, country: 'US', negativeDays: 30 });
    worker.requestReconcile(); now += 3500; await worker.runOnce();
    expect(provider.search).toHaveBeenCalledTimes(1);
  });
  test('rolling request budget holds for a large queue', async () => {
    await songs(40);
    for (let i = 0; i < 150; i++) { await worker.runOnce(); now += 1000; }
    expect(starts.length).toBe(38);
    for (const start of starts) expect(starts.filter(value => value >= start && value < start + 60000).length).toBeLessThanOrEqual(18);
  });
});
