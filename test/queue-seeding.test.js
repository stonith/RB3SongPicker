const express = require('express');
const request = require('supertest');
const Database = require('../database');
const QueueStore = require('../queue-store');
const { createApiRouter } = require('../api-router');
let db, store, app;
const startCommand = (extra = {}) => ({ commandId: 'start', type: 'start', expectedVersion: 0, sessionId: null, listId: 1, ...extra });
beforeEach(async () => {
  db = new Database(':memory:'); store = new QueueStore(db); await store.initialize();
  await db.promisifyRun("INSERT INTO songs (shortname, title, artist, present) VALUES ('c', 'C', 'Same', 1), ('b', 'B', 'Same', 1), ('a', 'A', 'Same', 1), ('gone', 'Gone', 'Same', 0)");
  await db.promisifyRun("INSERT INTO songlists (id, name) VALUES (1, 'Party'), (2, 'Empty'), (3, 'Unavailable')");
  await db.promisifyRun("INSERT INTO songlist_items VALUES (1, 'a'), (1, 'b'), (1, 'c'), (1, 'gone'), (3, 'gone')");
  app = express(); app.use('/api', createApiRouter({ db }));
});
afterEach(async () => { await db.close(); });

test('search displaying only B still seeds full present membership and reports excluded songs', async () => {
  expect((await request(app).get('/api/songs?listId=1&search=B')).body.songs.map(s => s.shortname)).toEqual(['b']);
  const s = await store.start(startCommand());
  expect(s.session.entries.map(e => e.shortname)).toEqual(['a', 'b', 'c']);
  expect(s.session.excludedShortnames).toEqual(['gone']);
});

test.each(['title', 'artist', 'album', 'origin', 'shortname', 'picks'])('seed and browse share stable %s ordering in both directions', async sort => {
  for (const order of ['asc', 'desc']) {
    const response = await request(app).get(`/api/songs?listId=1&sort=${sort}&order=${order}`);
    const seed = await store.seed({ listId: 1, sort, order });
    expect(seed.entries.map(e => e.shortname)).toEqual(response.body.songs.map(s => s.shortname));
    if (sort === 'artist') expect(seed.entries.map(e => e.shortname)).toEqual(['a', 'b', 'c']);
  }
});

test.each([null, 0, 'all', 999, 2, 3])('rejects All songs, invalid and empty eligible list %s', async listId => {
  await expect(store.start(startCommand({ listId }))).rejects.toMatchObject({ code: expect.stringMatching(/INVALID_LIST|LIST_NOT_FOUND|EMPTY_LIST/) });
  expect((await store.read()).version).toBe(0);
});

test.each([{ sort: 'title; DROP TABLE songs' }, { order: 'sideways' }])('rejects invalid sort/direction %j without mutation', async extra => {
  await expect(store.start(startCommand(extra))).rejects.toMatchObject({ code: 'INVALID_SORT' });
  expect((await store.read()).version).toBe(0);
});

test('oversized full seed and metadata fail explicitly without truncating saved membership', async () => {
  store = new QueueStore(db, { maxEntries: 2 });
  await expect(store.start(startCommand())).rejects.toMatchObject({ code: 'QUEUE_LIMIT' });
  store = new QueueStore(db);
  await db.promisifyRun("UPDATE songs SET title = ? WHERE shortname = 'a'", ['x'.repeat(1001)]);
  await expect(store.start(startCommand())).rejects.toMatchObject({ code: 'INVALID_SNAPSHOT' });
  expect((await store.read()).version).toBe(0);
  expect((await db.promisifyGet('SELECT COUNT(*) AS count FROM songlist_items WHERE list_id = 1')).count).toBe(4);
});

test('browse fallback remains safe and duplicate filtering also uses stable ties', async () => {
  const fallback = await request(app).get('/api/songs?sort=invalid&order=invalid');
  expect(fallback.body.songs.map(s => s.shortname)).toEqual(['a', 'b', 'c']);
  await db.promisifyRun("UPDATE songs SET title = 'Same' WHERE present = 1");
  const duplicates = await request(app).get('/api/songs?listId=1&filterDuplicates=true&sort=artist&order=desc');
  expect(duplicates.body.songs.map(s => s.shortname)).toEqual(['a', 'b', 'c']);
});

test('source rename/deletion and library metadata/availability changes do not alter the session', async () => {
  const snapshot = await store.start(startCommand());
  await db.promisifyRun("UPDATE songlists SET name = 'Renamed' WHERE id = 1");
  await db.promisifyRun('DELETE FROM songlists WHERE id = 1');
  await db.promisifyRun("UPDATE songs SET title = 'Changed', present = 0 WHERE shortname = 'a'");
  expect(await store.read()).toEqual(snapshot);
  expect(snapshot.session.sourceList).toEqual({ id: 1, name: 'Party' });
  expect(snapshot.session.entries[0]).toMatchObject({ shortname: 'a', title: 'A' });
});
