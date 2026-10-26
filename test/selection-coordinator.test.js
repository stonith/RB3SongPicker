const Database = require('../database');
const QueueStore = require('../queue-store');
const GameState = require('../game-state');
const QueueController = require('../queue-controller');
const XboxService = require('../xbox-service');
const SelectionCoordinator = require('../selection-coordinator');
let db, store, controller, transport, resolve, reject;
beforeEach(async () => {
  db = new Database(':memory:'); store = new QueueStore(db);
  transport = { selectSong: jest.fn(() => new Promise((a, b) => { resolve = a; reject = b; })) };
  controller = new QueueController({ store, gameState: new GameState(), xboxService: transport }); await controller.initialize();
  await db.promisifyRun("INSERT INTO songs (shortname, title) VALUES ('a', 'A')");
  await db.promisifyRun("INSERT INTO songlists (id, name) VALUES (1, 'Party')");
  await db.promisifyRun("INSERT INTO songlist_items VALUES (1, 'a')");
});
afterEach(async () => { await controller.close(); await db.close(); });
const cmd = async type => { const s = await store.read(); return { commandId: `${type}-${s.version}`, type, expectedVersion: s.version, sessionId: s.session?.id || null, ...(type === 'start' ? { listId: 1 } : {}) }; };

test('one recorded operation per manual selection; concurrent request conflicts, count increments on successful return only', async () => {
  expect(controller.selection).toBeInstanceOf(SelectionCoordinator);
  const first = controller.manualPick('a'); await controller.idle();
  expect((await store.read()).operation).toMatchObject({ owner: 'manual', status: 'transmitted', shortname: 'a' });
  await expect(controller.manualPick('a')).rejects.toMatchObject({ status: 409 });
  resolve('OK'); await expect(first).resolves.toMatchObject({ shortname: 'a', count: 1 });
  expect(transport.selectSong).toHaveBeenCalledTimes(1);
});

test('running and paused queue own manual Pick, Stop releases only after outstanding transport resolves', async () => {
  await controller.command(await cmd('start'));
  await expect(controller.manualPick('a')).rejects.toMatchObject({ code: 'SELECTION_CONFLICT', status: 409 });
  await controller.command(await cmd('pause'));
  await expect(controller.manualPick('a')).rejects.toMatchObject({ status: 409 });
  await controller.command(await cmd('resume'));
  controller.observe({ type: 'SCREEN_NAME', value: 'song_select_screen', receivedAt: Date.now() }); await controller.idle();
  await controller.command(await cmd('stop'));
  await expect(controller.manualPick('a')).rejects.toMatchObject({ status: 409 });
  resolve('OK'); await controller.idle(); const pick = controller.manualPick('a'); await controller.idle();
  resolve('OK'); await expect(pick).resolves.toMatchObject({ count: 2 });
});

test('manual transport timeout leaves global quarantine and does not count', async () => {
  const pick = controller.manualPick('a'); const assertion = expect(pick).rejects.toThrow('timeout');
  await controller.idle(); reject(new Error('timeout')); await assertion;
  expect((await store.read()).operation.status).toBe('unknown');
  await expect(controller.manualPick('a')).rejects.toMatchObject({ status: 409 });
  expect(await db.promisifyGet('SELECT count FROM picks')).toBeUndefined();
});

test('simultaneous manual and queue start cannot overlap HTTP requests', async () => {
  const start = await cmd('start');
  const pick = controller.manualPick('a');
  await expect(controller.command(start)).rejects.toMatchObject({ code: 'STALE_VERSION' });
  await controller.command(await cmd('start'));
  controller.observe({ type: 'SCREEN_NAME', value: 'song_select_screen', receivedAt: Date.now() }); await controller.idle();
  expect(transport.selectSong).toHaveBeenCalledTimes(1); resolve('OK'); await pick; await controller.idle();
  expect(transport.selectSong).toHaveBeenCalledTimes(2);
});

test('Xbox selectSong uses the shared bounded transport with only escaped shortname', async () => {
  const xbox = new XboxService({ load: () => ({}) }); xbox.fetch = jest.fn().mockResolvedValue('OK');
  await expect(xbox.selectSong('a &b?')).resolves.toBe('OK');
  expect(xbox.fetch).toHaveBeenCalledWith('/jump?shortname=a%20%26b%3F');
});

test('manual pre-send persistence failure never dispatches and recovery cancels its unsent reservation', async () => {
  await db.promisifyRun("CREATE TRIGGER fail_manual_send BEFORE UPDATE ON queue_snapshot WHEN json_extract(NEW.operation_json, '$.status') = 'transmitted' BEGIN SELECT RAISE(ABORT, 'manual disk failed'); END");
  await expect(controller.manualPick('a')).rejects.toThrow('manual disk failed');
  expect(transport.selectSong).not.toHaveBeenCalled(); expect(controller.diagnostics().inhibited).toBe(true);
  await db.promisifyRun('DROP TRIGGER fail_manual_send'); await controller.reconcileStorage();
  expect((await store.read()).operation).toBeNull(); expect(controller.diagnostics().inhibited).toBe(false);
});

test('known manual HTTP error return does not leave unknown-transport quarantine', async () => {
  const pick = controller.manualPick('a'); const assertion = expect(pick).rejects.toThrow('HTTP 500');
  await controller.idle(); reject(Object.assign(new Error('HTTP 500'), { transportReturned: true })); await assertion;
  expect((await store.read()).operation).toBeNull(); expect(await db.promisifyGet('SELECT count FROM picks')).toBeUndefined();
});
