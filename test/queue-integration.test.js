const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');
const { harness, FakeListener } = require('./queue-test-helpers.cjs');
let h;
afterEach(async () => { if (h) await h.close(); h = null; });
const act = async (type, extra) => request(h.app).post('/api/queue/commands').send(await h.command(type, extra)).expect(200);

test('browser-independent execution: valid screen immediately selects, tracks attempts once and exhausts', async () => {
  h = await harness(); await act('start', { listId: 1 }); h.router.close();
  await h.observe('SCREEN_NAME', 'song_select_screen'); await h.observe('SCREEN_NAME', 'song_select_screen');
  expect(h.xbox.selectSong).toHaveBeenCalledTimes(1);
  for (const name of ['a', 'b']) {
    await h.observe('SONG_SHORTNAME', name); await h.observe('STATE', 1); await h.observe('STATE', 0);
    await h.observe('STATE', 0); await h.observe('SCREEN_NAME', 'song_select_screen');
  }
  expect(h.xbox.selectSong.mock.calls).toEqual([['a'], ['b']]);
  expect((await h.runtime.store.read()).session.status).toBe('completed');
  expect(await h.db.promisifyAll('SELECT shortname, count FROM picks ORDER BY shortname')).toEqual([{ shortname: 'a', count: 1 }, { shortname: 'b', count: 1 }]);
});

test('listener bind failure keeps browsing usable and diagnostics visible; recovery needs Resume and new evidence', async () => {
  h = await harness({ createListener: config => {
    const listener = new FakeListener(config); listener.start = async () => { listener.fail(); return false; }; return listener;
  } });
  await request(h.app).get('/api/songs').expect(200);
  const diagnostic = (await request(h.app).get('/api/queue/diagnostics').expect(200)).body;
  expect(diagnostic.listener).toMatchObject({ status: 'error', error: 'EADDRINUSE' });
  await act('start', { listId: 1 }); expect(h.xbox.selectSong).not.toHaveBeenCalled();
  h.runtime.listener.fail(); await h.runtime.controller.idle();
  expect((await h.runtime.store.read()).session.status).toBe('paused');
});

test('runtime listener error invalidates evidence and shutdown inhibits dispatch before closing resources', async () => {
  h = await harness(); await act('start', { listId: 1 }); await act('pause');
  await h.observe('SCREEN_NAME', 'song_select_screen'); h.runtime.listener.fail(); await h.runtime.controller.idle();
  expect(h.runtime.game.snapshot().canSelect).toBe(false);
  await act('resume'); expect(h.xbox.selectSong).not.toHaveBeenCalled();
  await h.runtime.close(); await h.observe('SCREEN_NAME', 'song_select_screen');
  expect(h.runtime.listener.status).toBe('stopped'); expect(h.xbox.selectSong).not.toHaveBeenCalled();
});

test.each([false, true])('real SQLite restart with unresolved transmitted=%s stays paused without automatic selection', async transmitted => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rb3-queue-restart-'));
  const filename = path.join(directory, 'songs.sqlite');
  try {
    h = await harness({ filename });
    if (transmitted) h.xbox.selectSong.mockReturnValue(new Promise(() => {}));
    await act('start', { listId: 1 });
    if (transmitted) await h.observe('SCREEN_NAME', 'song_select_screen');
    const oldOperation = (await h.runtime.store.read()).operation;
    await h.close(); h = null;
    h = await harness({ filename });
    const snapshot = (await request(h.app).get('/api/queue')).body;
    expect(snapshot.session.status).toBe('paused'); expect(snapshot.operation?.id || null).toBe(oldOperation?.id || null);
    await h.observe('SCREEN_NAME', 'song_select_screen'); expect(h.xbox.selectSong).not.toHaveBeenCalled();
    if (transmitted) {
      await request(h.app).post('/api/queue/commands').send(await h.command('resume')).expect(409);
      await act('confirm-console-restarted', { operationId: oldOperation.id });
      await act('resume'); expect(h.xbox.selectSong).not.toHaveBeenCalled();
      await h.observe('SCREEN_NAME', 'song_select_screen');
    } else { await act('resume'); }
    expect(h.xbox.selectSong).toHaveBeenCalledTimes(1);
  } finally {
    if (h) await h.close(); h = null; fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('composed server initializes recovery before listen and gracefully closes SSE, UDP, worker and DB', async () => {
  const http = require('node:http');
  const { createApplication } = require('../server');
  h = await harness();
  const previewStore = { initialize: jest.fn().mockResolvedValue(), decorate: songs => songs };
  const previewWorker = { start: jest.fn(), stop: jest.fn().mockResolvedValue() };
  // The harness runtime is already initialized; use a spy to assert application ordering.
  const initialize = jest.spyOn(h.runtime, 'initialize');
  const application = createApplication({ db: h.db, configStore: h.configStore, xboxService: h.xbox,
    previewStore, previewWorker, queueRuntime: h.runtime });
  const server = await application.listen(0);
  if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
  let stream;
  try {
    expect(initialize).toHaveBeenCalledTimes(1); expect(previewWorker.start).toHaveBeenCalledTimes(1);
    const received = new Promise((resolve, reject) => {
      stream = http.get(`http://127.0.0.1:${server.address().port}/api/queue/events`, response => {
        expect(response.headers['content-type']).toBe('text/event-stream');
        response.once('data', chunk => resolve(chunk.toString())); response.resume();
      }); stream.on('error', reject);
    });
    expect(await received).toContain('event: snapshot');
    await application.close(); await application.close();
    expect(server.listening).toBe(false); expect(previewWorker.stop).toHaveBeenCalledTimes(1);
    expect(h.runtime.controller.closed).toBe(true); expect(h.runtime.listener.status).toBe('stopped');
    expect(h.router.updates.clients.size).toBe(0);
  } finally {
    stream?.destroy(); await application.close();
    // Application owns database disposal; don't close it again in the harness.
    h.router.close(); fs.rmSync(path.dirname(h.configStore.configPath), { recursive: true, force: true }); h = null;
  }
});

test('validated decoder/listener packets alone drive immediate dispatch; wrong source never establishes evidence', async () => {
  const { EventEmitter } = require('node:events');
  const { Rb3Events } = require('../rb3-events');
  let socket;
  h = await harness({ createListener: config => new Rb3Events(config, { createSocket: () => {
    socket = new EventEmitter(); socket.bind = () => socket.emit('listening');
    socket.close = callback => { socket.emit('close'); callback?.(); }; return socket;
  } }) });
  await act('start', { listId: 1 });
  const payload = Buffer.from('song_select_screen');
  const packet = Buffer.alloc(8 + payload.length);
  packet.writeUInt32BE(0x52423345); packet[5] = 9; packet[6] = payload.length; payload.copy(packet, 8);
  socket.emit('message', packet, { address: '192.0.2.99' }); await h.runtime.controller.idle();
  expect(h.xbox.selectSong).not.toHaveBeenCalled();
  socket.emit('message', packet, { address: h.configStore.load().xboxIp }); await h.runtime.controller.idle();
  expect(h.xbox.selectSong).toHaveBeenCalledTimes(1);
});

test('server accepts bounded full-entry reorder commands above Express default 100 KB', async () => {
  const { createApplication } = require('../server');
  h = await harness();
  await h.db.promisifyRun(`WITH RECURSIVE names(n) AS (VALUES(1) UNION ALL SELECT n + 1 FROM names WHERE n < 3000)
    INSERT INTO songs (shortname, title) SELECT 'large-' || n, 'Song ' || n FROM names`);
  await h.db.promisifyRun("INSERT INTO songlists (id, name) VALUES (2, 'Large list')");
  await h.db.promisifyRun("INSERT INTO songlist_items SELECT 2, shortname FROM songs WHERE shortname LIKE 'large-%'");
  const application = createApplication({ db: h.db, configStore: h.configStore, xboxService: h.xbox,
    previewStore: { initialize: async () => {} }, previewWorker: { stop: async () => {} }, queueRuntime: h.runtime });
  try {
    await application.initialize();
    await request(application.app).post('/api/queue/commands').send(await h.command('start', { listId: 2 })).expect(200);
    const s = await h.runtime.store.read();
    const command = await h.command('reorder', { entryIds: s.session.entries.map(e => e.id).reverse() });
    expect(Buffer.byteLength(JSON.stringify(command))).toBeGreaterThan(100 * 1024);
    await request(application.app).post('/api/queue/commands').send(command).expect(200);
    expect((await h.runtime.store.read()).session.entries[0].id).toBe(command.entryIds[0]);
  } finally {
    await application.close(); h.router.close();
    fs.rmSync(path.dirname(h.configStore.configPath), { recursive: true, force: true }); h = null;
  }
});

test('storage reconciliation API replays known return and lifecycle backlog once, reports ongoing failure, never redispatches', async () => {
  h = await harness();
  let returned;
  h.xbox.selectSong.mockImplementation(() => new Promise(resolve => { returned = resolve; }));
  await act('start', { listId: 1 }); await h.observe('SCREEN_NAME', 'song_select_screen');
  await h.db.promisifyRun("CREATE TRIGGER fail_storage BEFORE UPDATE ON queue_snapshot BEGIN SELECT RAISE(ABORT, 'storage still failed'); END");
  returned('OK'); await h.runtime.controller.idle();
  await h.observe('SONG_SHORTNAME', 'a'); await h.observe('STATE', 1); await h.observe('STATE', 0);
  const failed = await request(h.app).post('/api/queue/storage/reconcile').send({}).expect(503);
  expect(failed.body).toMatchObject({ code: 'STORAGE_UNAVAILABLE', diagnostics: { inhibited: true } });
  expect(failed.body.error).toMatch(/storage still failed/);
  expect(h.xbox.selectSong).toHaveBeenCalledTimes(1);
  await h.db.promisifyRun('DROP TRIGGER fail_storage');
  const recovered = (await request(h.app).post('/api/queue/storage/reconcile').send({}).expect(200)).body;
  expect(recovered.diagnostics).toMatchObject({ inhibited: false, evidence: { canSelect: false } });
  expect(recovered.snapshot).toMatchObject({ operation: null, session: { status: 'paused', currentAttempt: null, lockedEntryId: null } });
  expect(recovered.snapshot.session.entries.map(e => e.status)).toEqual(['handled', 'pending']);
  await request(h.app).post('/api/queue/storage/reconcile').send({}).expect(200);
  expect(await h.db.promisifyAll('SELECT shortname, count FROM picks')).toEqual([{ shortname: 'a', count: 1 }]);
  await act('resume'); expect(h.xbox.selectSong).toHaveBeenCalledTimes(1);
  await h.observe('SCREEN_NAME', 'song_select_screen'); expect(h.xbox.selectSong.mock.calls).toEqual([['a'], ['b']]);
});

test('storage reconciliation API guards recovery read errors and cannot clear unknown transport quarantine', async () => {
  h = await harness();
  h.xbox.selectSong.mockRejectedValue(new Error('timeout'));
  await act('start', { listId: 1 }); await h.observe('SCREEN_NAME', 'song_select_screen');
  const operation = (await h.runtime.store.read()).operation;
  h.runtime.controller.inhibit(new Error('transient disk failure'));
  const read = jest.spyOn(h.runtime.store, 'read').mockRejectedValue(new Error('read still failed'));
  const failed = await request(h.app).post('/api/queue/storage/reconcile').send({}).expect(503);
  expect(failed.body).toMatchObject({ code: 'STORAGE_UNAVAILABLE', error: 'read still failed', diagnostics: { inhibited: true } });
  read.mockRestore();
  const recovered = (await request(h.app).post('/api/queue/storage/reconcile').send({}).expect(200)).body;
  expect(recovered.snapshot.operation).toEqual(operation);
  expect(recovered.snapshot.session.status).toBe('paused');
  await request(h.app).post('/api/queue/commands').send(await h.command('resume')).expect(409);
  await act('stop'); await request(h.app).post('/api/songs/a/pick').expect(409);
  expect(h.xbox.selectSong).toHaveBeenCalledTimes(1);
});
