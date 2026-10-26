const request = require('supertest');
const { EventEmitter } = require('node:events');
const { harness } = require('./queue-test-helpers.cjs');
const { QueueUpdates } = require('../queue-router');
let h;
beforeEach(async () => { h = await harness(); });
afterEach(async () => { await h.close(); });
const act = async (type, extra) => request(h.app).post('/api/queue/commands').send(await h.command(type, extra)).expect(200);

test('full list seed and shared edits are independent; lost Add retry returns historical receipt without rollback', async () => {
  expect((await request(h.app).get('/api/queue').expect(200)).body).toEqual({ version: 0, session: null, operation: null });
  await act('start', { listId: 1, sort: 'title', order: 'desc' });
  const add = await h.command('add', { shortname: 'a' });
  const accepted = (await request(h.app).post('/api/queue/commands').send(add).expect(200)).body;
  expect(accepted.session.entries.map(e => e.shortname)).toEqual(['b', 'a', 'a']);
  await act('reorder', { entryIds: accepted.session.entries.map(e => e.id).reverse() });
  await act('pause'); await act('skip');
  const current = (await request(h.app).get('/api/queue').expect(200)).body;
  expect(current.session.status).toBe('paused'); expect(current.session.entries[0].status).toBe('skipped');
  expect((await request(h.app).post('/api/queue/commands').send(add).expect(200)).body).toEqual(accepted);
  expect((await request(h.app).get('/api/queue')).body).toEqual(current);
  expect(await h.db.promisifyAll('SELECT shortname FROM songlist_items ORDER BY shortname')).toEqual([{ shortname: 'a' }, { shortname: 'b' }]);
});

test('stale revision/session and active Start return authoritative snapshots', async () => {
  const start = await h.command('start', { listId: 1 }); await act('start', { listId: 1 });
  for (const cmd of [{ ...start, commandId: 'stale' }, await h.command('start', { listId: 1 }),
    { ...await h.command('pause'), sessionId: 'wrong' }]) {
    const response = await request(h.app).post('/api/queue/commands').send(cmd).expect(409);
    expect(response.body.snapshot).toEqual(await h.runtime.store.read()); expect(response.body.code).toBeTruthy();
  }
  expect(h.xbox.selectSong).not.toHaveBeenCalled();
});

test.each([null, {}, { type: 'nonsense' }, { type: 'pause', commandId: 'bad', expectedVersion: 0, sessionId: null, unexpected: true }])('malformed command %j is rejected', async command => {
  await request(h.app).post('/api/queue/commands').send(command).expect(400);
  expect((await h.runtime.store.read()).version).toBe(0);
});

test('invalid list/sort, unavailable Add and locked edits do not mutate or select', async () => {
  for (const extra of [{ listId: 0 }, { listId: 999 }, { listId: 1, sort: 'sql' }]) {
    await request(h.app).post('/api/queue/commands').send(await h.command('start', extra)).expect(400);
  }
  await act('start', { listId: 1 });
  await request(h.app).post('/api/queue/commands').send(await h.command('add', { shortname: 'missing' })).expect(400);
  await h.observe('SCREEN_NAME', 'song_select_screen');
  const s = await h.runtime.store.read();
  await request(h.app).post('/api/queue/commands').send(await h.command('remove', { entryId: s.session.lockedEntryId })).expect(409);
  expect(h.xbox.selectSong).toHaveBeenCalledTimes(1);
});

test('manual Pick including Random eventual Pick shares ownership and counts exactly once', async () => {
  await request(h.app).post('/api/songs/a/pick').expect(200, { shortname: 'a', count: 1 });
  expect(h.xbox.fetch).not.toHaveBeenCalled(); await act('start', { listId: 1 });
  for (const status of ['running', 'paused']) {
    if (status === 'paused') await act('pause');
    const result = await request(h.app).post('/api/songs/b/pick').expect(409);
    expect(result.body).toMatchObject({ code: 'SELECTION_CONFLICT', snapshot: expect.any(Object) });
  }
  expect(h.xbox.selectSong).toHaveBeenCalledTimes(1);
});

test('recovery is operation-bound, idempotent and separate from Resume', async () => {
  h.xbox.selectSong.mockRejectedValue(new Error('timeout'));
  await act('start', { listId: 1 }); await h.observe('SCREEN_NAME', 'song_select_screen');
  const s = await h.runtime.store.read(); expect(s.operation.status).toBe('unknown');
  await request(h.app).post('/api/queue/commands').send(await h.command('confirm-console-restarted', { operationId: 'wrong' })).expect(409);
  const cmd = await h.command('confirm-console-restarted', { operationId: s.operation.id });
  const confirmed = (await request(h.app).post('/api/queue/commands').send(cmd).expect(200)).body;
  expect(confirmed).toMatchObject({ operation: null, session: { status: 'paused', lockedEntryId: null } });
  expect(h.runtime.game.snapshot().canSelect).toBe(false);
  expect((await request(h.app).post('/api/queue/commands').send(cmd).expect(200)).body).toEqual(confirmed);
  await act('resume'); expect(h.xbox.selectSong).toHaveBeenCalledTimes(1);
});

function connection(blocked = false) {
  const req = new EventEmitter(), res = new EventEmitter();
  res.setHeader = jest.fn(); res.flushHeaders = jest.fn(); res.write = jest.fn(() => !blocked);
  res.end = jest.fn(() => res.emit('close')); res.destroy = jest.fn();
  return { req, res };
}
const snapshots = res => res.write.mock.calls.map(([text]) => text).filter(text => text.startsWith('event: snapshot'));
test('SSE two clients, reconnect and historical replay use only current monotonic snapshots', async () => {
  const a = connection(), b = connection();
  await h.router.updates.subscribe(a.req, a.res); await h.router.updates.subscribe(b.req, b.res);
  const start = await h.command('start', { listId: 1 });
  await request(h.app).post('/api/queue/commands').send(start).expect(200);
  await act('add', { shortname: 'a' });
  const s = await h.runtime.store.read(); await act('reorder', { entryIds: s.session.entries.map(e => e.id).reverse() });
  await act('pause'); await act('skip');
  await request(h.app).post('/api/queue/commands').send(start).expect(200);
  expect(snapshots(a.res)).toEqual(snapshots(b.res));
  const versions = snapshots(a.res).map(text => JSON.parse(text.split('data: ')[1]).version);
  expect(versions).toEqual([...versions].sort((x, y) => x - y));
  expect(versions.at(-1)).toBe((await h.runtime.store.read()).version);
  a.res.emit('close'); b.res.emit('close');
  const c = connection(); await h.router.updates.subscribe(c.req, c.res);
  expect(snapshots(c.res)).toHaveLength(1); expect(snapshots(c.res)[0]).toContain(`"version":${versions.at(-1)}`);
  c.res.emit('close'); expect(h.router.updates.clients.size).toBe(0);
});

test('SSE registration/read race is serialized; bounded slow clients never block controls; close disposes', async () => {
  const updates = new QueueUpdates(h.runtime, { maxClients: 2, keepaliveMs: 100000 });
  const slow = connection(true), fast = connection(), excess = connection();
  try {
    const first = updates.subscribe(slow.req, slow.res);
    const mutation = h.runtime.controller.command(await h.command('start', { listId: 1 }));
    await first; await mutation;
    expect(slow.res.end).toHaveBeenCalled(); expect(slow.res.destroy).toHaveBeenCalled();
    await updates.subscribe(fast.req, fast.res);
    expect(snapshots(fast.res)[0]).toContain('"status":"running"');
    const other = connection(); await updates.subscribe(other.req, other.res);
    await updates.subscribe(excess.req, excess.res); expect(excess.res.statusCode).toBe(503);
    await act('pause'); updates.close(); expect(updates.clients.size).toBe(0); expect(fast.res.end).toHaveBeenCalled();
  } finally { updates.close(); }
});

test('expired Start receipt cannot revive or roll back a replacement session', async () => {
  const start = await h.command('start', { listId: 1 });
  await request(h.app).post('/api/queue/commands').send(start).expect(200);
  await act('stop'); await act('start', { listId: 1 });
  const latest = await h.runtime.store.read();
  await h.db.promisifyRun('DELETE FROM queue_command_receipts WHERE command_id = ?', [start.commandId]);
  const response = await request(h.app).post('/api/queue/commands').send(start).expect(409);
  expect(response.body).toMatchObject({ code: 'STALE_VERSION', snapshot: latest });
});

test('SSE aborted subscription, backpressure drain, keepalive and write errors dispose without changing evidence', async () => {
  const updates = new QueueUpdates(h.runtime, { keepaliveMs: 20 });
  const aborted = connection(), healthy = connection(true);
  try {
    const pending = updates.subscribe(aborted.req, aborted.res); aborted.req.emit('aborted'); await pending;
    expect(aborted.res.write).not.toHaveBeenCalled();
    await updates.subscribe(healthy.req, healthy.res);
    healthy.res.write.mockReturnValue(true); healthy.res.emit('drain');
    const before = h.runtime.game.snapshot();
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(healthy.res.write.mock.calls.some(([frame]) => frame === ': keepalive\n\n')).toBe(true);
    expect(h.runtime.game.snapshot()).toEqual(before);
    healthy.res.write.mockImplementation(() => { throw new Error('closed'); });
    await act('start', { listId: 1 }); expect(updates.clients.size).toBe(0);
  } finally { updates.close(); }
});

test('Stop/replacement cannot release transmitted quarantine; stale confirmation and command ID misuse reject', async () => {
  h.xbox.selectSong.mockReturnValue(new Promise(() => {}));
  await act('start', { listId: 1 }); await h.observe('SCREEN_NAME', 'song_select_screen');
  const operation = (await h.runtime.store.read()).operation;
  const confirmation = await h.command('confirm-console-restarted', { operationId: operation.id });
  await act('stop');
  await request(h.app).post('/api/songs/x/pick').expect(409);
  await act('start', { listId: 1 });
  await request(h.app).post('/api/queue/commands').send(confirmation).expect(409);
  expect((await h.runtime.store.read()).operation.id).toBe(operation.id);
  const correct = await h.command('confirm-console-restarted', { operationId: operation.id });
  await request(h.app).post('/api/queue/commands').send(correct).expect(200);
  const misuse = await request(h.app).post('/api/queue/commands').send({ ...correct, operationId: 'superseded' }).expect(409);
  expect(misuse.body.code).toBe('COMMAND_MISMATCH');
  expect((await h.runtime.store.read()).session.status).toBe('paused');
  expect(h.xbox.selectSong).toHaveBeenCalledTimes(1);
});

test('SSE initial read failure releases subscription and leaves an unsent response for API error handling', async () => {
  const client = connection();
  const read = jest.spyOn(h.runtime.store, 'read').mockRejectedValueOnce(new Error('SQLite unavailable'));
  await expect(h.router.updates.subscribe(client.req, client.res)).rejects.toThrow('SQLite unavailable');
  expect(h.router.updates.clients.size).toBe(0);
  expect(client.res.write).not.toHaveBeenCalled();
  expect(client.res.end).not.toHaveBeenCalled();
  read.mockRestore();
});
