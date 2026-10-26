const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('../database');
const QueueStore = require('../queue-store');

let db, store;
const command = (type, snapshot, extra = {}, id = `${type}-${snapshot.version}`) => ({
  commandId: id, type, expectedVersion: snapshot.version, sessionId: snapshot.session?.id || null, ...extra
});
beforeEach(async () => {
  db = new Database(':memory:');
  store = new QueueStore(db);
  await store.initialize();
  await db.promisifyRun("INSERT INTO songs (shortname, title) VALUES ('a', 'A'), ('b', 'B'), ('c', 'C')");
  await db.promisifyRun("INSERT INTO songlists (id, name) VALUES (1, 'Party')");
  await db.promisifyRun("INSERT INTO songlist_items VALUES (1, 'a'), (1, 'b')");
});
afterEach(async () => { await db.close(); });
const start = async () => store.start(command('start', await store.read(), { listId: 1 }));

test('repeat additions are independent; reorder/remove never change saved membership', async () => {
  let s = await start();
  s = await store.add(command('add', s, { shortname: 'c' }));
  s = await store.add(command('add', s, { shortname: 'c' }));
  const ids = s.session.entries.map(e => e.id);
  expect(new Set(ids).size).toBe(4);
  s = await store.reorder(command('reorder', s, { entryIds: [ids[3], ids[0], ids[1], ids[2]] }));
  s = await store.remove(command('remove', s, { entryId: ids[2] }));
  expect(s.session.entries.map(e => e.id)).toEqual([ids[3], ids[0], ids[1]]);
  expect(await db.promisifyAll('SELECT shortname FROM songlist_items ORDER BY shortname')).toEqual([{ shortname: 'a' }, { shortname: 'b' }]);
});

test('receipt replay precedes revision check and cannot duplicate an Add', async () => {
  const s = await start();
  const add = command('add', s, { shortname: 'c' }, 'lost-response');
  const accepted = await store.add(add);
  expect(await store.add({ ...add })).toEqual(accepted);
  await expect(store.add({ ...add, shortname: 'a' })).rejects.toMatchObject({ code: 'COMMAND_MISMATCH' });
  const newer = await store.add(command('add', accepted, { shortname: 'c' }));
  expect(newer.session.entries.filter(e => e.shortname === 'c')).toHaveLength(2);
  expect(await store.add(add)).toEqual(accepted);
  expect((await store.read()).version).toBe(newer.version);
});

test('concurrent edits accept one version and reject the other with authoritative state', async () => {
  const s = await start();
  const results = await Promise.allSettled(['a', 'b'].map(shortname => store.add(command('add', s, { shortname }, shortname))));
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  const rejected = results.find(r => r.status === 'rejected').reason;
  expect(rejected.code).toBe('STALE_VERSION');
  expect(rejected.snapshot).toEqual(await store.read());
});

test('locked entries and handled entries cannot be removed or reordered', async () => {
  let s = await start();
  s = await store.transition(snapshot => { snapshot.session.lockedEntryId = snapshot.session.entries[0].id; });
  const [a, b] = s.session.entries.map(e => e.id);
  await expect(store.remove(command('remove', s, { entryId: a }))).rejects.toMatchObject({ code: 'ENTRY_LOCKED' });
  await expect(store.reorder(command('reorder', s, { entryIds: [b, a] }))).rejects.toMatchObject({ code: 'INVALID_ORDER' });
  s = await store.transition(snapshot => { snapshot.session.lockedEntryId = null; snapshot.session.entries[0].status = 'handled'; });
  await expect(store.remove(command('remove', s, { entryId: a }))).rejects.toMatchObject({ code: 'ENTRY_LOCKED' });
});

test.each([
  ['remove', { entryId: 'missing' }, 'ENTRY_NOT_FOUND'],
  ['reorder', { entryIds: [] }, 'INVALID_ORDER'],
  ['reorder', { entryIds: ['duplicate', 'duplicate'] }, 'INVALID_ORDER'],
  ['add', { shortname: 'missing' }, 'SONG_UNAVAILABLE']
])('invalid %s is atomic', async (type, payload, code) => {
  const s = await start();
  await expect(store[type](command(type, s, payload))).rejects.toMatchObject({ code });
  expect(await store.read()).toEqual(s);
  expect((await db.promisifyGet('SELECT COUNT(*) AS count FROM queue_command_receipts')).count).toBe(1);
});

test('snapshot and receipt roll back together on interrupted acceptance', async () => {
  const s = await start();
  await db.promisifyRun("CREATE TRIGGER fail_receipt BEFORE INSERT ON queue_command_receipts BEGIN SELECT RAISE(ABORT, 'interrupted'); END");
  await expect(store.add(command('add', s, { shortname: 'c' }))).rejects.toThrow('interrupted');
  expect(await store.read()).toEqual(s);
  expect((await db.promisifyGet('SELECT COUNT(*) AS count FROM queue_command_receipts')).count).toBe(1);
});

test('bounded entries/requests fail explicitly; expired receipts cannot replay stale commands', async () => {
  store = new QueueStore(db, { maxEntries: 2, maxReceipts: 1, receiptTtlMs: 10, now: () => 0 });
  const s = await start();
  await expect(store.add(command('add', s, { shortname: 'c' }))).rejects.toMatchObject({ code: 'QUEUE_LIMIT' });
  await expect(store.add(command('add', s, { shortname: 'x'.repeat(1001) }))).rejects.toMatchObject({ code: 'INVALID_COMMAND' });
  const remove = command('remove', s, { entryId: s.session.entries[0].id });
  const newer = await store.remove(remove);
  expect((await db.promisifyGet('SELECT COUNT(*) AS count FROM queue_command_receipts')).count).toBe(1);
  store.now = () => 11;
  await expect(store.remove(remove)).rejects.toMatchObject({ code: 'STALE_VERSION' });
  expect(await store.read()).toEqual(newer);
});

test('singleton versions span terminal and replacement sessions; receipts survive replacement', async () => {
  const initial = await store.read();
  const cmd = command('start', initial, { listId: 1 });
  const s = await store.start(cmd);
  await expect(store.start(command('start', s, { listId: 1 }))).rejects.toMatchObject({ code: 'SESSION_ACTIVE' });
  const stopped = await store.transition(snapshot => { snapshot.session.status = 'stopped'; });
  await expect(store.add(command('add', stopped, { shortname: 'c' }))).rejects.toMatchObject({ code: 'SESSION_TERMINAL' });
  const replacement = await store.start(command('start', stopped, { listId: 1 }));
  expect(replacement.version).toBe(stopped.version + 1);
  expect(replacement.session.id).not.toBe(s.session.id);
  expect(await store.start(cmd)).toEqual(s);
});

test('controller transitions atomically retain operations independent of session replacement', async () => {
  let s = await start();
  s = await store.transition(async (snapshot, transaction) => {
    snapshot.operation = { id: 'op-1', transmitted: true, sessionId: snapshot.session.id };
    snapshot.session.status = 'stopped';
    await transaction.promisifyRun("INSERT INTO picks VALUES ('a', 1)");
  });
  s = await store.start(command('start', s, { listId: 1 }));
  expect(s.operation).toMatchObject({ id: 'op-1', transmitted: true });
  expect(await db.promisifyGet("SELECT count FROM picks WHERE shortname = 'a'")).toEqual({ count: 1 });
});

test('real SQLite restart restores edits paused, preserves locks/operation and never revives terminal state', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-store-'));
  const filename = path.join(dir, 'queue.sqlite');
  await db.close();
  db = new Database(filename); store = new QueueStore(db); await store.initialize();
  await db.promisifyRun("INSERT INTO songs (shortname) VALUES ('a')");
  await db.promisifyRun("INSERT INTO songlists (id, name) VALUES (1, 'Party')");
  await db.promisifyRun("INSERT INTO songlist_items VALUES (1, 'a')");
  let s = await start();
  s = await store.add(command('add', s, { shortname: 'a' }));
  s = await store.transition(snapshot => {
    snapshot.session.lockedEntryId = snapshot.session.entries[0].id;
    snapshot.operation = { id: 'op-1', transmitted: true };
  });
  await db.close(); db = new Database(filename); store = new QueueStore(db); await store.initialize();
  const restored = await store.read();
  expect(restored.version).toBe(s.version + 1);
  expect(restored.session).toMatchObject({ status: 'paused', pauseReason: 'restart, console state unknown', entries: s.session.entries, lockedEntryId: s.session.lockedEntryId });
  expect(restored.operation).toEqual(s.operation);
  await store.transition(snapshot => { snapshot.session.status = 'completed'; });
  await db.close(); db = new Database(filename); store = new QueueStore(db); await store.initialize();
  expect((await store.read()).session.status).toBe('completed');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('ordinary restart pauses progress without inventing an unresolved console operation', async () => {
  const s = await start();
  store = new QueueStore(db);
  await store.initialize();
  const restored = await store.read();
  expect(restored.operation).toBeNull();
  expect(restored.session.status).toBe('paused');
  expect(restored.session.revision).toBe(s.session.revision + 1);
});

test('start defaults and key order normalize to the same receipt, including across recovery', async () => {
  const cmd = command('start', await store.read(), { listId: 1 });
  const accepted = await store.start(cmd);
  await store.initialize();
  expect(await store.start({ listId: 1, order: 'ASC', sort: 'TITLE', ...cmd })).toEqual(accepted);
  expect((await store.read()).session.status).toBe('paused');
});

test('wrong target session conflicts, even with the correct singleton version', async () => {
  const s = await start();
  await expect(store.add({ ...command('add', s, { shortname: 'c' }), sessionId: 'old-session' }))
    .rejects.toMatchObject({ code: 'STALE_SESSION', snapshot: s });
  expect(await store.read()).toEqual(s);
});

test('oversized command JSON and unknown fields reject without writing receipts', async () => {
  const s = await start();
  await expect(store.reorder(command('reorder', s, { entryIds: Array(10000).fill('x'.repeat(200)) })))
    .rejects.toMatchObject({ code: 'INVALID_COMMAND' });
  await expect(store.add(command('add', s, { shortname: 'c', search: 'ignored?' })))
    .rejects.toMatchObject({ code: 'INVALID_COMMAND' });
  expect(await store.read()).toEqual(s);
});

test('once-only pick recording and operation reconciliation roll back with snapshot failure', async () => {
  const s = await start();
  await db.promisifyRun("CREATE TRIGGER fail_snapshot BEFORE UPDATE ON queue_snapshot BEGIN SELECT RAISE(ABORT, 'snapshot unavailable'); END");
  await expect(store.transition(async (snapshot, transaction) => {
    snapshot.operation = { id: 'op-1', transmitted: true };
    await transaction.promisifyRun("INSERT INTO picks VALUES ('a', 1)");
  })).rejects.toThrow('snapshot unavailable');
  expect(await store.read()).toEqual(s);
  expect(await db.promisifyGet("SELECT count FROM picks WHERE shortname = 'a'")).toBeUndefined();
});

test('current attempt entry remains locked even if the selection lock was cleared', async () => {
  let s = await start();
  s = await store.transition(snapshot => { snapshot.session.currentAttempt = { id: 'attempt', entryId: snapshot.session.entries[0].id }; });
  await expect(store.remove(command('remove', s, { entryId: s.session.entries[0].id })))
    .rejects.toMatchObject({ code: 'ENTRY_LOCKED' });
});
