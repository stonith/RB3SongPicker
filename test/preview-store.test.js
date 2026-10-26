const Database = require('../database');
const PreviewStore = require('../preview-store');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

describe('persistent preview storage', () => {
  let db, store;
  beforeEach(async () => {
    db = new Database(':memory:');
    await db.ready;
    store = new PreviewStore(db);
    await store.initialize();
  });
  afterEach(async () => { await db.close(); });
  const song = (name = 'one') => db.promisifyRun(
    'INSERT INTO songs (shortname, title, artist, album) VALUES (?, ?, ?, ?)', [name, 'Song', 'Artist', 'Album']);

  test('unchanged refresh timestamps never requeue successful matches', async () => {
    await song();
    await store.reconcile('US', 100);
    const job = await store.nextJob('US', 100);
    await store.complete(job, { status: 'matched', trackId: 1, previewUrl: 'https://audio-ssl.itunes.apple.com/clip.m4a' }, 100);
    await db.promisifyRun("UPDATE songs SET updated_at = datetime('now')");
    await store.reconcile('US', 999999999999);
    expect(await store.nextJob('US', 999999999999)).toBeUndefined();
    expect((await store.status(100)).counts.matched).toBe(1);
  });

  test('changes, storefronts, missing songs and negative expiry are handled independently', async () => {
    await song();
    await store.reconcile('US', 100);
    let job = await store.nextJob('US', 100);
    await store.complete(job, { status: 'unavailable' }, 100);
    await store.reconcile('US', 101);
    expect(await store.nextJob('US', 101)).toBeUndefined();
    await store.reconcile('US', 100 + store.negativeTtl);
    expect(await store.nextJob('US', 100 + store.negativeTtl)).toBeDefined();
    await db.promisifyRun("UPDATE songs SET present = 0");
    expect(await store.nextJob('US', 999999999999)).toBeUndefined();
    await db.promisifyRun("UPDATE songs SET present = 1, title = 'Changed'");
    await store.reconcile('US', 200);
    expect((await store.nextJob('US', 200)).title).toBe('Changed');
    await store.reconcile('GB', 200);
    expect(await store.nextJob('GB', 200)).toBeDefined();
  });

  test('duplicate enqueue is idempotent, stale completions are discarded and cached searches shared', async () => {
    await song();
    await song('two');
    await store.reconcile('US', 100);
    await store.reconcile('US', 100);
    expect((await store.status(100)).counts.pending).toBe(2);
    const job = await store.nextJob('US', 100);
    await store.cacheSearch(job.search_key, [], 100);
    expect(await store.cachedSearch(job.search_key, 101)).toEqual([]);
    await db.promisifyRun("UPDATE songs SET title = 'Changed' WHERE shortname = ?", [job.shortname]);
    await store.complete(job, { status: 'matched', trackId: 5 }, 200);
    expect((await store.status(200)).counts.matched || 0).toBe(0);
  });

  test('file-backed restart recovers interrupted jobs without losing timing, matches, or existing app data', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rb3-preview-store-'));
    const filename = path.join(directory, 'songs.sqlite');
    let persistent;
    try {
      persistent = new Database(filename);
      await persistent.ready;
      let storage = new PreviewStore(persistent);
      await storage.initialize();
      await persistent.promisifyRun("INSERT INTO songs (shortname, title, artist) VALUES ('one', 'Song', 'Artist'), ('two', 'Other', 'Artist')");
      await persistent.promisifyRun("INSERT INTO picks VALUES ('one', 8)");
      await persistent.promisifyRun("INSERT INTO songlists (name) VALUES ('Party')");
      await persistent.promisifyRun("INSERT INTO songlist_items VALUES (1, 'one')");
      await persistent.setSetting('showExportCsvButton', 'true');
      await storage.reconcile('US', 100);
      const job = await storage.nextJob('US', 100);
      await storage.markProcessing(job);
      await storage.reserveRequest(123456);
      await storage.cooldown(234567);
      await storage.cacheSearch(job.search_key, [], 100);
      await persistent.close();
      persistent = new Database(filename);
      storage = new PreviewStore(persistent);
      await storage.initialize();
      expect((await storage.status(100)).counts.retry).toBe(1);
      expect(await storage.timing()).toMatchObject({ next_request_at: 123456, cooldown_until: 234567 });
      expect(await storage.cachedSearch(job.search_key, 101)).toEqual([]);
      expect((await persistent.promisifyGet('SELECT count FROM picks')).count).toBe(8);
      expect((await persistent.promisifyGet('SELECT COUNT(*) AS count FROM songlist_items')).count).toBe(1);
      expect(await persistent.getSetting('showExportCsvButton')).toBe('true');
    } finally {
      if (persistent) await persistent.close();
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  test('database transaction rollback and exclusive writes isolate worker activity', async () => {
    await song();
    let release;
    const blocked = new Promise(resolve => { release = resolve; });
    let entered;
    const started = new Promise(resolve => { entered = resolve; });
    const transaction = db.transaction(async () => {
      await db.promisifyRun("UPDATE songs SET title = 'Temporary'");
      entered();
      await blocked;
      throw new Error('rollback');
    });
    await started;
    const write = db.promisifyRun("INSERT INTO settings VALUES ('outside', 'preserved')");
    release();
    await expect(transaction).rejects.toThrow('rollback');
    await write;
    expect((await db.promisifyGet('SELECT title FROM songs')).title).toBe('Song');
    expect(await db.getSetting('outside')).toBe('preserved');
  });
});
