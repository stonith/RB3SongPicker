const express = require('express');
const request = require('supertest');
const Database = require('../database');
const PreviewStore = require('../preview-store');
const PreviewWorker = require('../preview-worker');
const { createApiRouter } = require('../api-router');

let db, store, worker, provider, app, xbox;
const song = { shortname: 'queen', title: 'Somebody to Love', artist: 'Queen', album: 'A Day at the Races', origin: 'rb3' };
const clip = { kind: 'song', trackId: 1, trackName: song.title, artistName: song.artist, collectionName: song.album,
  previewUrl: 'https://audio-ssl.itunes.apple.com/clip.m4a', trackViewUrl: 'https://music.apple.com/us/album/1' };
beforeEach(async () => {
  db = new Database(':memory:');
  store = new PreviewStore(db);
  await store.initialize();
  provider = { search: jest.fn().mockResolvedValue([clip]) };
  worker = new PreviewWorker(store, provider);
  xbox = { fetch: jest.fn().mockResolvedValue('raw'), parseSongListResponse: jest.fn().mockReturnValue([song]) };
  app = express();
  app.use(express.json());
  app.use('/api', createApiRouter({ db, configStore: {}, xboxService: xbox, previewStore: store, previewWorker: worker }));
  app.use((error, req, res, next) => res.status(500).json({ error: error.message }));
});
afterEach(async () => { await worker.stop(); await db.close(); });
const refresh = () => request(app).post('/api/songs/refresh').expect(200);
const enable = () => request(app).post('/api/previews').send({ enabled: true, country: 'US' }).expect(200);

test('opt-in, cached previews, repeated refresh and browsing never repeat Apple calls', async () => {
  await refresh();
  await worker.runOnce();
  expect(provider.search).not.toHaveBeenCalled();
  expect((await request(app).get('/api/songs')).body.songs[0].preview).toBeUndefined();
  await enable();
  await worker.runOnce();
  expect(provider.search).toHaveBeenCalledTimes(1);
  await db.promisifyRun("UPDATE picks SET count = 7 WHERE shortname = 'queen'");
  await refresh(); await refresh();
  await worker.runOnce();
  const response = await request(app).get('/api/songs').expect(200);
  expect(response.body.songs[0]).toMatchObject({ picks: 7, preview: { status: 'matched', trackId: 1 } });
  expect(provider.search).toHaveBeenCalledTimes(1);
});

test('validates configuration and does not expose stale matches after a metadata change', async () => {
  for (const settings of [{ enabled: 'true', country: 'US' }, { enabled: true, country: 'ZZ' },
    { enabled: true, country: 'US', negativeDays: 0 }]) {
    await request(app).post('/api/previews').send(settings).expect(400);
  }
  await enable(); await refresh(); await worker.runOnce();
  xbox.parseSongListResponse.mockReturnValue([{ ...song, title: 'Another Song' }]);
  await refresh();
  const response = await request(app).get('/api/songs').expect(200);
  expect(response.body.songs[0].preview).toEqual({ status: 'pending' });
});

test('refresh rollback preserves original data and does not schedule matching', async () => {
  await refresh();
  worker.reconcileNeeded = false;
  await db.promisifyRun(`CREATE TRIGGER fail_refresh BEFORE UPDATE ON songs
    WHEN NEW.title = 'Broken' BEGIN SELECT RAISE(ABORT, 'injected failure'); END`);
  xbox.parseSongListResponse.mockReturnValue([{ ...song, title: 'Broken' }]);
  await request(app).post('/api/songs/refresh').expect(500);
  expect(await db.promisifyGet('SELECT title, present FROM songs')).toEqual({ title: song.title, present: 1 });
  expect(worker.reconcileNeeded).toBe(false);
});

test('visible-row lookup is bounded, cached-only, and does not search Apple', async () => {
  await enable(); await refresh(); await worker.runOnce();
  await request(app).post('/api/previews/lookup').send({ shortnames: Array(201).fill('queen') }).expect(400);
  const response = await request(app).post('/api/previews/lookup').send({ shortnames: ['queen'] }).expect(200);
  expect(response.body.songs).toEqual([{ shortname: 'queen', preview: expect.objectContaining({ status: 'matched' }) }]);
  expect(provider.search).toHaveBeenCalledTimes(1);
  await request(app).post('/api/previews').send({ enabled: false, country: 'US' }).expect(200);
  expect((await request(app).post('/api/previews/lookup').send({ shortnames: ['queen'] })).body.songs[0].preview).toBeNull();
});

test('5000 cached unchanged songs cause zero provider requests after refresh', async () => {
  const songs = Array.from({ length: 5000 }, (_, index) => ({ ...song, shortname: `song${index}` }));
  xbox.parseSongListResponse.mockReturnValue(songs);
  await refresh(); await enable();
  await store.reconcile('US');
  await db.promisifyRun("UPDATE preview_matches SET status = 'matched', result = ?", [JSON.stringify({ status: 'matched', trackId: 1 })]);
  await refresh();
  await worker.runOnce();
  expect(provider.search).not.toHaveBeenCalled();
  expect((await store.status()).counts.matched).toBe(5000);
}, 20000);
