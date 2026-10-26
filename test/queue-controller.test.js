const Database = require('../database');
const QueueStore = require('../queue-store');
const GameState = require('../game-state');
const QueueController = require('../queue-controller');

const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
let db, store, game, controller, transport, response, policy;
const command = async (type, extra = {}) => { const s = await store.read(); return { commandId: `${type}-${s.version}`, type, expectedVersion: s.version, sessionId: s.session?.id || null, ...extra }; };
const act = async (type, extra) => controller.command(await command(type, extra));
const observe = async (type, value) => { controller.observe({ type, value, receivedAt: Date.now() }); await controller.idle(); };
const select = () => observe('SCREEN_NAME', 'song_select_screen');
const begin = async (name = 'a') => { await observe('SONG_SHORTNAME', name); await observe('STATE', 1); };
const end = () => observe('STATE', 0);
const state = () => store.read();
const returned = async () => { response.resolve('OK'); await controller.idle(); };
beforeEach(async () => {
  db = new Database(':memory:'); store = new QueueStore(db); game = new GameState(); policy = false;
  response = deferred(); transport = { selectSong: jest.fn(() => response.promise) };
  controller = new QueueController({ store, gameState: game, xboxService: transport, pauseAfterAttempt: () => policy });
  await controller.initialize();
  await db.promisifyRun("INSERT INTO songs (shortname, title) VALUES ('a', 'A'), ('b', 'B'), ('x', 'X')");
  await db.promisifyRun("INSERT INTO songlists (id, name) VALUES (1, 'Party')");
  await db.promisifyRun("INSERT INTO songlist_items VALUES (1, 'a'), (1, 'b')");
});
afterEach(async () => { await controller.close(); await db.close(); });

test('valid selection immediately dispatches once; HTTP return is not gameplay; end plus new screen advances once', async () => {
  await act('start', { listId: 1 }); await select();
  expect(transport.selectSong).toHaveBeenCalledTimes(1);
  expect((await state()).operation).toMatchObject({ status: 'transmitted', shortname: 'a', opportunityId: expect.any(String) });
  await select(); await observe('STATE', 0); await returned(); await select();
  expect(transport.selectSong).toHaveBeenCalledTimes(1);
  expect((await state()).session.entries[0].status).toBe('pending');
  await begin(); await observe('STATE', 1); await end(); await end();
  expect((await state()).session.entries[0].status).toBe('handled');
  await observe('SCREEN_NAME', 'results_screen'); expect(transport.selectSong).toHaveBeenCalledTimes(1);
  await select(); await select(); expect(transport.selectSong).toHaveBeenCalledTimes(2);
  expect(transport.selectSong.mock.calls.map(c => c[0])).toEqual(['a', 'b']);
  await controller.idle(); expect((await db.promisifyGet("SELECT count FROM picks WHERE shortname = 'a'")).count).toBe(1);
});

test('accepted screen never expires and ALIVE is not readiness', async () => {
  await observe('ALIVE', ''); await act('start', { listId: 1 }); expect(transport.selectSong).not.toHaveBeenCalled();
  await act('pause'); await select(); game.now = () => Date.now() + 864000000; game.expire();
  await act('resume'); expect(transport.selectSong).toHaveBeenCalledTimes(1);
});

test('unexpected X preserves A, blocks Resume during X, and safely retains A after end', async () => {
  await act('start', { listId: 1 }); await select(); await returned(); await begin('x');
  expect((await state()).session).toMatchObject({ status: 'paused', pauseReason: expect.stringContaining('Unexpected') });
  expect((await state()).session.entries[0].status).toBe('pending');
  await expect(act('resume')).rejects.toMatchObject({ code: 'UNSAFE_RESUME' });
  await end(); await select(); expect(transport.selectSong).toHaveBeenCalledTimes(1);
  await act('resume'); expect(transport.selectSong.mock.calls.map(c => c[0])).toEqual(['a', 'a']);
});

test.each([false, true])('attempt policy %s sampled at start; manual pause remains; Resume never replays handled entry', async enabled => {
  policy = enabled; await act('start', { listId: 1 }); await select(); await returned(); await begin();
  policy = !enabled; await end(); await select();
  expect((await state()).session.entries[0].status).toBe('handled');
  if (enabled) { expect((await state()).session.status).toBe('paused'); await act('resume'); }
  expect(transport.selectSong.mock.calls.map(c => c[0])).toEqual(['a', 'b']);
});

test('manual pause tracks gameplay, deferred Skip never interrupts; final end completes', async () => {
  await act('start', { listId: 1 }); await select(); await returned(); await begin(); await act('pause');
  await act('skip'); expect(transport.selectSong).toHaveBeenCalledTimes(1);
  expect((await state()).session.entries[0].status).toBe('pending');
  await end(); await select(); expect((await state()).session).toMatchObject({ status: 'paused' });
  expect((await state()).session.entries[0].status).toBe('skipped');
  await act('resume'); await controller.idle(); await begin('b'); await end();
  expect((await state()).session.status).toBe('completed');
});

test('independent A/A repeats need distinct boundaries and cannot advance from shortname alone', async () => {
  await act('start', { listId: 1 }); const s = await state();
  await act('remove', { entryId: s.session.entries[1].id }); await act('add', { shortname: 'a' });
  await select(); await returned(); await begin(); const first = (await state()).session.currentAttempt.id;
  await observe('SONG_SHORTNAME', 'a'); await select(); expect(transport.selectSong).toHaveBeenCalledTimes(1);
  await end(); await select(); await begin();
  expect((await state()).session.currentAttempt.id).not.toBe(first); await end();
  expect((await state()).session.entries.map(e => e.status)).toEqual(['handled', 'handled']);
  expect((await state()).session.status).toBe('completed');
});

test('missing end / contradictory identity pauses without consuming; Resume is not uncertainty recovery', async () => {
  await act('start', { listId: 1 }); await select(); await returned(); await begin();
  await observe('SONG_SHORTNAME', 'b'); await select();
  expect((await state()).session.status).toBe('paused');
  expect((await state()).session.entries[0].status).toBe('pending');
  await expect(act('resume')).rejects.toMatchObject({ code: 'UNSAFE_RESUME' });
  await act('skip'); await select(); await act('resume');
  expect(transport.selectSong.mock.calls.map(c => c[0])).toEqual(['a', 'b']);
});

test('timeout quarantines across Stop/Start; exact recovery is idempotent, resets evidence, leaves paused', async () => {
  await act('start', { listId: 1 }); await select(); response.reject(new Error('timeout')); await controller.idle();
  const op = (await state()).operation.id;
  expect((await state()).operation.status).toBe('unknown');
  await expect(act('resume')).rejects.toMatchObject({ code: 'UNSAFE_RESUME' });
  await act('stop'); await act('start', { listId: 1 }); await select(); await observe('ALIVE', '');
  expect(transport.selectSong).toHaveBeenCalledTimes(1);
  await expect(act('confirm-console-restarted', { operationId: 'wrong' })).rejects.toMatchObject({ code: 'STALE_OPERATION' });
  const recovery = await command('confirm-console-restarted', { operationId: op });
  const accepted = await controller.command(recovery); await controller.command(recovery);
  expect((await state()).version).toBe(accepted.version); expect((await state()).operation).toBeNull();
  expect((await state()).session.status).toBe('paused'); expect(game.snapshot().canSelect).toBe(false);
  await act('resume'); expect(transport.selectSong).toHaveBeenCalledTimes(1);
  response = deferred(); await select(); expect(transport.selectSong).toHaveBeenCalledTimes(2);
});

test('late exact return clears old quarantine/count once without changing replacement progress', async () => {
  await act('start', { listId: 1 }); await select(); const op = (await state()).operation.id;
  response.reject(new Error('timeout')); await controller.idle(); await act('stop'); await act('start', { listId: 1 });
  const id = (await state()).session.id;
  await controller.reconcileOperation(op, { ok: true }); await controller.reconcileOperation(op, { ok: true });
  expect((await state()).session).toMatchObject({ id, lockedEntryId: null });
  expect((await state()).operation).toBeNull();
  expect((await db.promisifyGet("SELECT count FROM picks WHERE shortname = 'a'")).count).toBe(1);
});

test('Pause/Stop during pending HTTP are ingested; stopped callbacks cannot revive session', async () => {
  await act('start', { listId: 1 }); await select(); await act('pause'); await begin(); await act('stop'); await returned();
  expect((await state()).session.status).toBe('stopped'); expect((await state()).operation).toBeNull();
  expect(transport.selectSong).toHaveBeenCalledTimes(1);
});

test('selected entry cannot edit; skipping final unstarted entry completes after operation return', async () => {
  await act('start', { listId: 1 }); await select(); const [a, b] = (await state()).session.entries;
  await expect(act('remove', { entryId: a.id })).rejects.toMatchObject({ code: 'ENTRY_LOCKED' });
  await act('remove', { entryId: b.id }); await act('skip');
  expect((await state()).session.status).not.toBe('completed'); await returned();
  expect((await state()).session.status).toBe('completed');
});

test('remove all before dispatch completes; removing last upcoming during gameplay does not', async () => {
  await act('start', { listId: 1 }); for (const e of (await state()).session.entries) await act('remove', { entryId: e.id });
  expect((await state()).session.status).toBe('completed'); await select(); expect(transport.selectSong).not.toHaveBeenCalled();
  await act('start', { listId: 1 }); await select(); await returned(); await begin();
  await act('remove', { entryId: (await state()).session.entries[1].id });
  expect((await state()).session.status).toBe('running'); await end(); expect((await state()).session.status).toBe('completed');
});

test('unavailable head pauses instead of skipping', async () => {
  await act('start', { listId: 1 }); await db.promisifyRun("UPDATE songs SET present = 0 WHERE shortname = 'a'"); await select();
  expect((await state()).session).toMatchObject({ status: 'paused', pauseReason: expect.stringContaining('unavailable') });
  expect(transport.selectSong).not.toHaveBeenCalled();
});

test.each(['screen', 'gameplay', 'pause', 'stop'])('%s invalidation during SQLite reservation wait cancels before send', async change => {
  await act('start', { listId: 1 });
  const controlCommand = ['pause', 'stop'].includes(change) ? await command(change) : null;
  const entered = deferred(), release = deferred(); const original = store.transition.bind(store); let first = true;
  jest.spyOn(store, 'transition').mockImplementation(update => original(async (s, db) => {
    await update(s, db); if (first && s.operation) { first = false; entered.resolve(); await release.promise; }
  }));
  controller.observe({ type: 'SCREEN_NAME', value: 'song_select_screen', receivedAt: Date.now() }); await entered.promise;
  let control;
  if (change === 'screen') controller.observe({ type: 'SCREEN_NAME', value: 'results_screen', receivedAt: Date.now() });
  if (change === 'gameplay') { controller.observe({ type: 'SONG_SHORTNAME', value: 'x', receivedAt: Date.now() }); controller.observe({ type: 'STATE', value: 1, receivedAt: Date.now() }); }
  if (controlCommand) control = controller.command(controlCommand).catch(error => {
    expect(error.code).toBe('STALE_VERSION');
  });
  // Let command() register its immediate invalidation before the DB wait ends.
  await Promise.resolve(); await Promise.resolve(); release.resolve(); await controller.idle(); if (control) await control;
  expect(transport.selectSong).not.toHaveBeenCalled(); expect((await state()).operation).toBeNull();
});

test('post-send result/count persistence failure latches inhibition; reconcileStorage retries transaction not HTTP', async () => {
  await act('start', { listId: 1 }); await select();
  await db.promisifyRun("CREATE TRIGGER fail_pick BEFORE INSERT ON picks BEGIN SELECT RAISE(ABORT, 'disk failed'); END");
  await returned(); expect(controller.diagnostics().inhibited).toBe(true);
  expect((await state()).operation.status).toBe('transmitted');
  await act('stop'); await act('start', { listId: 1 }); await select(); expect(transport.selectSong).toHaveBeenCalledTimes(1);
  await db.promisifyRun('DROP TRIGGER fail_pick'); await controller.reconcileStorage();
  expect(controller.diagnostics().inhibited).toBe(false); expect((await state()).operation).toBeNull();
  expect((await db.promisifyGet("SELECT count FROM picks WHERE shortname = 'a'")).count).toBe(1);
});

test('ordinary restart pauses, clears observations, needs no console confirmation; transmitted restart remains quarantined', async () => {
  await act('start', { listId: 1 }); await act('pause'); await controller.close();
  controller = new QueueController({ store, gameState: game, xboxService: transport }); await controller.initialize();
  expect((await state()).session.status).toBe('paused'); expect((await state()).operation).toBeNull();
  await act('resume'); expect(transport.selectSong).not.toHaveBeenCalled(); await select();
  await controller.close(); controller = new QueueController({ store, gameState: game, xboxService: transport }); await controller.initialize();
  await select(); expect((await state()).operation).not.toBeNull();
  await expect(act('resume')).rejects.toMatchObject({ code: 'UNSAFE_RESUME' });
  expect(transport.selectSong).toHaveBeenCalledTimes(1);
});

test('command replay cannot dispatch again or publish historical snapshot as current', async () => {
  const cmd = await command('start', { listId: 1 }); const historical = await controller.command(cmd); await select(); await returned();
  const seen = []; controller.on('snapshot', s => seen.push(s.version));
  expect(await controller.command(cmd)).toEqual(historical); expect(transport.selectSong).toHaveBeenCalledTimes(1);
  expect(seen.every(v => v >= historical.version)).toBe(true);
});

test('burst observations cannot dispatch ahead of unprocessed lifecycle boundaries', async () => {
  await act('start', { listId: 1 });
  for (const [type, value] of [['SONG_SHORTNAME', 'x'], ['STATE', 1], ['STATE', 0], ['SCREEN_NAME', 'song_select_screen']]) {
    controller.observe({ type, value, receivedAt: Date.now() });
  }
  await controller.idle();
  expect(transport.selectSong).not.toHaveBeenCalled();
  expect((await state()).session.status).toBe('paused');
  expect((await state()).session.entries[0].status).toBe('pending');
});

test('accepted end persistence failure inhibits immediately and reconciles boundary once without retransmission', async () => {
  await act('start', { listId: 1 }); await select(); await returned(); await begin();
  await db.promisifyRun("CREATE TRIGGER fail_boundary BEFORE UPDATE ON queue_snapshot BEGIN SELECT RAISE(ABORT, 'boundary disk failed'); END");
  await end(); await select();
  expect(controller.diagnostics().inhibited).toBe(true);
  expect((await state()).session.entries[0].status).toBe('pending');
  await db.promisifyRun('DROP TRIGGER fail_boundary'); await controller.reconcileStorage();
  expect((await state()).session.entries[0].status).toBe('handled');
  expect((await state()).session.status).toBe('paused');
  expect(transport.selectSong).toHaveBeenCalledTimes(1);
  await controller.reconcileStorage();
  expect((await state()).session.entries[0].status).toBe('handled');
});

test('Skip never clears unknown transport quarantine; exact restart recovery ignores superseded callback', async () => {
  await act('start', { listId: 1 }); await select(); const old = (await state()).operation.id;
  response.reject(new Error('timeout')); await controller.idle(); await act('skip'); await select();
  expect((await state()).operation.id).toBe(old); expect(transport.selectSong).toHaveBeenCalledTimes(1);
  await act('confirm-console-restarted', { operationId: old }); await select();
  response = deferred(); await act('resume'); const newer = (await state()).operation.id;
  await controller.reconcileOperation(old, { ok: true }); expect((await state()).operation.id).toBe(newer);
  await expect(act('confirm-console-restarted', { operationId: old })).rejects.toMatchObject({ code: 'STALE_OPERATION' });
  expect(await db.promisifyGet('SELECT count FROM picks')).toBeUndefined();
});

test('selected-but-returned app restart requires explicit Skip, not a console-restart confirmation', async () => {
  await act('start', { listId: 1 }); await select(); await returned(); await controller.close();
  controller = new QueueController({ store, gameState: game, xboxService: transport }); await controller.initialize();
  expect((await state()).operation).toBeNull(); await select();
  await expect(act('resume')).rejects.toMatchObject({ code: 'UNSAFE_RESUME' });
  await expect(act('confirm-console-restarted', { operationId: 'no-operation' })).rejects.toMatchObject({ code: 'STALE_OPERATION' });
  await act('skip'); await act('resume'); expect(transport.selectSong).toHaveBeenCalledTimes(1);
  response = deferred(); await select(); expect(transport.selectSong.mock.calls.map(c => c[0])).toEqual(['a', 'b']);
});

test('listener reset pauses and new evidence plus Resume is sufficient when no unresolved attempt', async () => {
  await act('start', { listId: 1 }); game.reset('listener-error'); await controller.idle();
  expect((await state()).session.status).toBe('paused');
  await act('resume'); expect(transport.selectSong).not.toHaveBeenCalled(); await select();
  expect(transport.selectSong).toHaveBeenCalledTimes(1);
});

test('Skip during unexpected gameplay before any selection targets the pending head at its end', async () => {
  await act('start', { listId: 1 }); await begin('x'); await act('skip');
  expect((await state()).session.entries[0].status).toBe('pending');
  await end(); expect((await state()).session.entries.map(e => e.status)).toEqual(['skipped', 'pending']);
  expect((await state()).session.status).toBe('paused');
  expect(transport.selectSong).not.toHaveBeenCalled();
});

test('failed pre-send durable reservation prevents HTTP and storage recovery cancels unsent lock', async () => {
  await act('start', { listId: 1 });
  await db.promisifyRun("CREATE TRIGGER fail_transmit BEFORE UPDATE ON queue_snapshot WHEN json_extract(NEW.operation_json, '$.status') = 'transmitted' BEGIN SELECT RAISE(ABORT, 'disk failed before send'); END");
  await select(); expect(transport.selectSong).not.toHaveBeenCalled();
  expect(controller.diagnostics().inhibited).toBe(true); expect((await state()).operation.status).toBe('reserved');
  await db.promisifyRun('DROP TRIGGER fail_transmit'); await controller.reconcileStorage();
  expect((await state()).operation).toBeNull(); expect((await state()).session).toMatchObject({ status: 'paused', lockedEntryId: null });
  await act('resume'); expect(transport.selectSong).not.toHaveBeenCalled(); await select(); expect(transport.selectSong).toHaveBeenCalledTimes(1);
});

test('attempt construction and end received during storage failure replay in order with the sampled policy', async () => {
  await act('start', { listId: 1 }); await select(); await returned(); policy = true;
  await db.promisifyRun("CREATE TRIGGER fail_boundaries BEFORE UPDATE ON queue_snapshot BEGIN SELECT RAISE(ABORT, 'disk failed'); END");
  await begin(); policy = false; await end();
  expect(controller.diagnostics().inhibited).toBe(true);
  await db.promisifyRun('DROP TRIGGER fail_boundaries'); await controller.reconcileStorage();
  expect((await state()).session).toMatchObject({ status: 'paused', currentAttempt: null, lockedEntryId: null });
  expect((await state()).session.entries.map(e => e.status)).toEqual(['handled', 'pending']);
  expect(transport.selectSong).toHaveBeenCalledTimes(1);
});

test('known HTTP error return releases transport reservation but retains uncertain entry until explicit Skip', async () => {
  await act('start', { listId: 1 }); await select();
  response.reject(Object.assign(new Error('HTTP 500'), { transportReturned: true })); await controller.idle();
  expect((await state()).operation).toBeNull();
  expect((await state()).session).toMatchObject({ status: 'paused', selectionUncertain: true });
  await expect(act('resume')).rejects.toMatchObject({ code: 'UNSAFE_RESUME' });
  expect(await db.promisifyGet('SELECT count FROM picks')).toBeUndefined();
});

test('timeout does not erase coherent expected gameplay; boundary handles once while independent transport stays quarantined', async () => {
  await act('start', { listId: 1 }); await select(); await begin();
  const op = (await state()).operation.id;
  response.reject(new Error('timeout during gameplay')); await controller.idle(); await end();
  expect((await state()).session.entries[0].status).toBe('handled');
  expect((await state()).operation.id).toBe(op); expect((await state()).session.status).toBe('paused');
  await select(); expect(transport.selectSong).toHaveBeenCalledTimes(1);
  await controller.reconcileOperation(op, { ok: true }); response = deferred(); await act('resume');
  expect(transport.selectSong.mock.calls.map(c => c[0])).toEqual(['a', 'b']);
});

test('initial result read failure retains known return, inhibits dispatch and promptly rejects manual waiter; recovery counts once', async () => {
  const picked = controller.manualPick('a');
  const settled = picked.then(value => ({ value }), error => ({ error }));
  await controller.idle();
  const id = (await state()).operation.id;
  jest.spyOn(store, 'read').mockRejectedValueOnce(new Error('initial read failed'));
  await returned();
  expect(controller.diagnostics()).toMatchObject({ inhibited: true, storageError: 'initial read failed' });
  expect(controller.pendingResults.get(id)).toMatchObject({ ok: true });
  expect(controller.manualWaiters.has(id)).toBe(false);
  expect((await settled).error.message).toBe('initial read failed');
  await expect(controller.manualPick('b')).rejects.toMatchObject({ code: 'SELECTION_CONFLICT' });
  await controller.reconcileStorage(); await controller.reconcileStorage();
  expect(controller.pendingResults.size).toBe(0);
  expect((await state()).operation).toBeNull();
  expect(await db.promisifyAll('SELECT shortname, count FROM picks')).toEqual([{ shortname: 'a', count: 1 }]);
  expect(transport.selectSong).toHaveBeenCalledTimes(1);
});

test('successful read proving retained result obsolete discards it without counting or altering newer reservation', async () => {
  await act('start', { listId: 1 }); await select();
  const id = (await state()).operation.id;
  jest.spyOn(store, 'read').mockRejectedValueOnce(new Error('initial read failed'));
  await returned();
  expect(controller.pendingResults.has(id)).toBe(true);
  await store.transition(s => { s.operation = { ...s.operation, id: 'new-operation' }; });
  await controller.reconcileStorage();
  expect(controller.pendingResults.size).toBe(0);
  expect(controller.diagnostics().inhibited).toBe(false);
  expect((await state()).operation.id).toBe('new-operation');
  expect(await db.promisifyGet('SELECT count FROM picks')).toBeUndefined();
  expect(transport.selectSong).toHaveBeenCalledTimes(1);
});

test.each([false, true])('Start durably adopts known manual gameplay, including Stop/Start=%s, without consuming pending entries', async restart => {
  await begin('x');
  const attempt = game.snapshot().attempt;
  const accepted = await act('start', { listId: 1 });
  expect(accepted.session).toMatchObject({ status: 'paused', currentAttempt: { ...attempt, expected: false, entryId: null } });
  if (restart) {
    await act('stop');
    const replacement = await act('start', { listId: 1 });
    expect(replacement.session.currentAttempt).toMatchObject({ id: attempt.id, expected: false, entryId: null });
  }
  await expect(act('resume')).rejects.toMatchObject({ code: 'UNSAFE_RESUME' });
  const entries = (await state()).session.entries;
  await end(); await select();
  expect((await state()).session).toMatchObject({ status: 'paused', currentAttempt: null, entries });
  expect((await state()).session.selectionUncertain).not.toBe(true);
  expect(entries.map(e => e.status)).toEqual(['pending', 'pending']);
  expect(transport.selectSong).not.toHaveBeenCalled();
  await act('resume');
  expect(transport.selectSong.mock.calls).toEqual([['a']]);
});

test('Start adopts gameplay observed during the seed wait atomically and does not replay the same start as uncertainty', async () => {
  const entered = deferred(), release = deferred();
  const seed = store.seed.bind(store);
  jest.spyOn(store, 'seed').mockImplementation(async command => {
    const result = await seed(command); entered.resolve(); await release.promise; return result;
  });
  const starting = act('start', { listId: 1 });
  await entered.promise;
  controller.observe({ type: 'SONG_SHORTNAME', value: 'x', receivedAt: Date.now() });
  controller.observe({ type: 'STATE', value: 1, receivedAt: Date.now() });
  const attempt = game.snapshot().attempt;
  release.resolve();
  const accepted = await starting; await controller.idle();
  expect(accepted.session).toMatchObject({ status: 'paused', currentAttempt: { id: attempt.id, expected: false, entryId: null } });
  expect((await state()).session.selectionUncertain).not.toBe(true);
  await end(); await select(); await act('resume');
  expect((await state()).session.entries.map(e => e.status)).toEqual(['pending', 'pending']);
  expect(transport.selectSong.mock.calls).toEqual([['a']]);
});
