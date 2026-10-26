const { describeQueue, startQueueDetails } = require('../public/session-queue');
const entry = (id, status = 'pending') => ({ id, shortname: id, title: `Title ${id}`, artist: 'Artist', status });
function view(patch = {}, operation = null, diagnostics = {}) {
  return describeQueue({ version: 2, session: { id: 'session', sourceList: { name: 'Tonight' }, status: 'running', entries: [entry('a'), entry('b')], ...patch }, operation }, diagnostics);
}
test('Start uses entire eligible saved-list count, not browser search results; All songs cannot start', () => {
  expect(startQueueDetails(null, 5)).toMatchObject({ enabled: false });
  expect(startQueueDetails({ id: 1, name: 'Tonight', songCount: 10 }, 8)).toMatchObject({ enabled: true, count: 8 });
  expect(startQueueDetails({ id: 1, name: 'Tonight', songCount: 10 }, 8).text).toMatch(/8.*search.*ignored/i);
  expect(startQueueDetails({ id: 1, songCount: 0 }, 0).enabled).toBe(false);
});
test('running with no accepted screen is waiting, never confirmed selected', () => {
  expect(view().label).toBe('Waiting for song selection');
  expect(view().upcoming.map(e => e.id)).toEqual(['a', 'b']);
});
test('locked current entry says selection requested, excludes upcoming and cannot imply playing', () => {
  expect(view({ lockedEntryId: 'a' })).toMatchObject({ label: 'Selection requested / awaiting start', current: { id: 'a' }, locked: true });
  expect(view({ lockedEntryId: 'a' }).upcoming.map(e => e.id)).toEqual(['b']);
});
test('playing follows an accepted attempt and exposes unexpected identity without consuming pending entry', () => {
  expect(view({ lockedEntryId: 'a', currentAttempt: { entryId: 'a', expected: true, shortname: 'a' } }).label).toBe('Playing');
  const unexpected = view({ status: 'paused', pauseReason: 'Unexpected song: x', currentAttempt: { expected: false, shortname: 'x' } });
  expect(unexpected.label).toMatch(/Paused: Unexpected/);
  expect(unexpected.current.shortname).toBe('x');
  expect(unexpected.upcoming.map(e => e.id)).toEqual(['a', 'b']);
  expect(unexpected.resumeBlocked).toMatch(/gameplay/i);
});
test('ordinary restart stays paused without console restart confirmation; uncertainty blocks Resume', () => {
  const recovered = view({ status: 'paused', pauseReason: 'restart, console state unknown' });
  expect(recovered.label).toMatch(/^Paused: restart/);
  expect(recovered.quarantined).toBe(false);
  expect(recovered.resumeBlocked).toBe('');
  expect(view({ status: 'paused', selectionUncertain: true }).resumeBlocked).toMatch(/Skip or Stop/i);
});
test('unresolved transmission blocks all manual selection independently of stopped session', () => {
  const model = view({ status: 'stopped' }, { id: 'op', status: 'unknown' });
  expect(model.active).toBe(false);
  expect(model.manualBlocked).toMatch(/unresolved console request/i);
  expect(model.quarantined).toBe(true);
  expect(model.warning).toMatch(/restart.*Admin/i);
});
test('Pause during gameplay remains paused, progress counts handled attempts not completed songs', () => {
  const model = view({ status: 'paused', pauseReason: 'Manually paused', lockedEntryId: 'b', entries: [entry('a', 'handled'), entry('b'), entry('c', 'skipped')], currentAttempt: { expected: true, entryId: 'b', shortname: 'b' } });
  expect(model.label).toBe('Paused: Manually paused');
  expect(model.progress).toBe('1 handled attempt · 1 pending · 1 skipped');
  expect(model.current.id).toBe('b');
  expect(model.manualBlocked).toMatch(/Stop the queue/i);
});
test.each(['completed', 'stopped'])('terminal %s never exposes active controls or revives empty queue', status => {
  const model = view({ status, entries: [] });
  expect(model.active).toBe(false);
  expect(model.upcoming).toEqual([]);
  expect(model.manualBlocked).toBe('');
  expect(model.label).toBe(status === 'completed' ? 'Queue complete' : 'Queue stopped');
});
test('storage inhibition is visible and blocks Resume/manual selection without claiming telemetry health', () => {
  const model = view({ status: 'paused' }, null, { inhibited: true, storageError: 'disk full' });
  expect(model.warning).toMatch(/disk full/);
  expect(model.resumeBlocked).toMatch(/storage/i);
  expect(model.manualBlocked).toMatch(/storage/i);
});

// Exercise the real app navigation/rendering without introducing a DOM dependency.
const fs = require('node:fs');
const vm = require('node:vm');
function appHarness() {
  class Element {
    constructor() {
      this.dataset = {}; this.children = []; this.style = {}; this.textContent = ''; this.hidden = false;
      this.disabled = false; this.scrollTop = 0; this.attributes = {}; this.value = '';
      const classes = new Set();
      this.classList = { add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name),
        toggle: (name, enabled) => { const next = enabled ?? !classes.has(name); next ? classes.add(name) : classes.delete(name); return next; } };
    }
    append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } }
    insertBefore(row, before) { row.remove(); row.parent = this; const index = before ? this.children.indexOf(before) : this.children.length; this.children.splice(index, 0, row); }
    remove() { if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; }
    setAttribute(name, value) { this.attributes[name] = value; }
    removeAttribute(name) { delete this.attributes[name]; }
    querySelectorAll() { return []; }
    addEventListener() {}
  }
  const nodes = Object.fromEntries([...fs.readFileSync('public/index.html', 'utf8').matchAll(/id="([^"]+)"/g)].map(match => [match[1], new Element()]));
  const body = new Element();
  const manualButton = new Element();
  body.querySelectorAll = selector => selector === '[data-manual-pick]' ? [manualButton] : [];
  const document = { getElementById: id => nodes[id], querySelector: () => body, querySelectorAll: () => [],
    createElement: () => new Element(), documentElement: { dataset: {} }, activeElement: nodes.searchInput };
  const player = { state: { status: 'idle', song: null }, stop: jest.fn(), clear: jest.fn() };
  const fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ songs: [] }) });
  const context = vm.createContext({ document, SessionQueue: require('../public/session-queue'), QueuePicker: require('../public/queue-picker'), QueuePreviews: require('../public/queue-previews'), PreviewPlayer: function () { return player; },
    fetch, setTimeout: jest.fn(), clearTimeout: jest.fn(), URLSearchParams, console, window: { location: { href: 'http://test/' } } });
  vm.runInContext(fs.readFileSync('public/app.js', 'utf8').replace(/init\(\)\.catch\([^\n]+\);\s*$/, ''), context);
  const run = code => vm.runInContext(code, context);
  const publish = (version, patch = {}, operation = null) => {
    context.nextSnapshot = { version, session: { id: 'session', sourceList: { name: 'Tonight' }, status: 'running', entries: [entry('a'), entry('b')], ...patch }, operation };
    run('queueClient.accept(nextSnapshot); queueClient.synchronized = true; renderQueue();');
  };
  return { nodes, document, manualButton, player, fetch, run, publish, context };
}
test('initial active join opens Queue once; subsequent remote edits preserve Songs/Admin, focus and scroll', () => {
  const app = appHarness(); app.publish(1);
  expect(app.run('state.currentPage')).toBe('queue');
  app.run("setPage('songs')");
  app.nodes.songTableWrapper.scrollTop = 384;
  app.publish(2, { status: 'paused', pauseReason: 'Manually paused' });
  expect(app.run('state.currentPage')).toBe('songs');
  expect(app.nodes.songTableWrapper.scrollTop).toBe(384);
  expect(app.document.activeElement).toBe(app.nodes.searchInput);
  app.run("state.currentPage = 'admin'"); app.publish(3);
  expect(app.run('state.currentPage')).toBe('admin');
});
test('remote Start after an initial empty snapshot never hijacks participant navigation or preview playback', () => {
  const app = appHarness();
  app.run('queueClient.accept({version: 0, session: null, operation: null}); queueClient.synchronized = true; renderQueue();');
  app.player.stop.mockClear(); app.publish(1);
  expect(app.run('state.currentPage')).toBe('songs');
  expect(app.player.stop).not.toHaveBeenCalled();
  expect(app.manualButton.disabled).toBe(true);
});
test('a participant navigation choice while connecting wins over initial join; terminal joins stay in Songs', () => {
  const app = appHarness(); app.run("setPage('songs')"); app.publish(1);
  expect(app.run('state.currentPage')).toBe('songs');
  const terminal = appHarness(); terminal.publish(1, { status: 'completed', entries: [] });
  expect(terminal.run('state.currentPage')).toBe('songs');
  expect(terminal.nodes.queueControls.hidden).toBe(true);
});
test('real render locks requested current, retains keyed upcoming nodes, and disables unsafe Resume', () => {
  const app = appHarness(); app.publish(1, { lockedEntryId: 'a' });
  expect(app.nodes.queueCurrent.hidden).toBe(false);
  expect(app.nodes.queueStatus.textContent).toMatch(/Selection requested/);
  expect(app.nodes.queueUpcoming.children.map(row => row.dataset.entryId)).toEqual(['b']);
  const upcoming = app.nodes.queueUpcoming.children[0];
  app.publish(2, { lockedEntryId: 'a', status: 'paused', selectionUncertain: true });
  expect(app.nodes.queueUpcoming.children[0]).toBe(upcoming);
  expect(app.nodes.queueResumeButton.disabled).toBe(true);
  expect(app.nodes.queueControlHint.textContent).toMatch(/Skip or Stop/);
});
test('Pick and Random are disabled with clear reason during ownership but previews/list editing stay independent', async () => {
  const app = appHarness(); app.publish(1);
  expect(app.nodes.randomButton.disabled).toBe(true);
  expect(app.nodes.queueManualHint.textContent).toMatch(/Stop the queue/);
  await app.run("pickSong('a')"); app.run("pickRandom('any')");
  expect(app.fetch).not.toHaveBeenCalled();
  app.publish(2, { status: 'completed', entries: [] });
  expect(app.nodes.randomButton.disabled).toBe(false);
  expect(app.manualButton.disabled).toBe(false);
});
test('full-list count ignores searched browser rows and Start sends only saved list/current sort', async () => {
  const app = appHarness(); app.publish(1, { status: 'completed', entries: [] });
  app.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ songs: [entry('a'), entry('b'), entry('c')] }) });
  app.run("state.songLists = [{id: 4, name: 'Tonight', songCount: 3}]; state.selectedListId = '4'; state.searchText = 'b'; state.sortBy = 'artist'; state.sortOrder = 'desc';");
  await app.run('loadQueueSeedCount()');
  expect(app.nodes.startQueueButton.textContent).toBe('Start queue (3)');
  expect(app.nodes.queueStartHint.textContent).toMatch(/search and duplicate filters are ignored/);
  app.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ version: 2, session: { id: 'new', sourceList: { name: 'Tonight' }, status: 'running', entries: [entry('a')] }, operation: null }) });
  // Inject a deterministic identity in the VM's client (LAN browsers use getRandomValues).
  app.run("queueClient.fetch = fetch; queueClient.commandId = () => 'start-1'");
  await app.run("runQueueAction('start', { listId: Number(state.selectedListId), sort: state.sortBy, order: state.sortOrder })");
  expect(JSON.parse(app.fetch.mock.calls[1][1].body)).toEqual({ type: 'start', commandId: 'start-1', listId: 4, sort: 'artist', order: 'desc', expectedVersion: 1, sessionId: 'session' });
  expect(app.run('state.currentPage')).toBe('queue');
  expect(app.player.stop).toHaveBeenCalled();
});
test('Stop explains an outstanding console request and cancellation issues no command', async () => {
  const app = appHarness(); app.publish(1, {}, { id: 'op', status: 'transmitted' });
  app.context.confirm = jest.fn().mockReturnValue(false);
  await app.run("runQueueAction('stop')");
  expect(app.context.confirm).toHaveBeenCalledWith(expect.stringMatching(/already-sent.*cannot be withdrawn/));
  expect(app.fetch).not.toHaveBeenCalled();
});
test('a provisional GET cannot consume the one-time initial SSE join decision', () => {
  const app = appHarness();
  app.run('queueClient.accept({version: 0, session: null, operation: null}); renderQueue();');
  app.publish(1);
  expect(app.run('state.currentPage')).toBe('queue');
});
test('real command conflict keeps participant view and explains non-applied action using current snapshot', async () => {
  const app = appHarness(); app.publish(1); app.run("setPage('songs')");
  await Promise.resolve(); await Promise.resolve();
  app.fetch.mockResolvedValueOnce({ ok: false, status: 409, json: async () => ({ code: 'STALE_VERSION', error: 'Another participant changed the queue', snapshot: { version: 8, session: { id: 'session', sourceList: { name: 'Tonight' }, status: 'paused', pauseReason: 'Remote pause', entries: [entry('a')] }, operation: null } }) });
  app.run("queueClient.fetch = fetch; queueClient.commandId = () => 'conflict-1'");
  await app.run("runQueueAction('pause')");
  expect(app.run('queueClient.snapshot.version')).toBe(8);
  expect(app.nodes.queueActionStatus.textContent).toMatch(/Action not applied.*Another participant/);
  expect(app.run('state.currentPage')).toBe('songs');
  expect(app.nodes.queueRetryButton.hidden).toBe(true);
});
test('real lost-response UI exposes Retry, disables fresh commands, and resolves with original identity', async () => {
  const app = appHarness(); app.publish(1);
  app.fetch.mockRejectedValueOnce(new Error('response lost'));
  app.run("queueClient.fetch = fetch; queueClient.commandId = () => 'pause-1'");
  await app.run("runQueueAction('pause')");
  expect(app.nodes.queueActionStatus.textContent).toMatch(/Result unknown/);
  expect(app.nodes.queueRetryButton.hidden).toBe(false);
  expect(app.nodes.queuePauseButton.disabled).toBe(true);
  app.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ version: 2, session: { id: 'session', sourceList: { name: 'Tonight' }, status: 'paused', pauseReason: 'Manually paused', entries: [entry('a')] }, operation: null }) });
  await app.run("runQueueAction('pause', {}, true)");
  expect(app.fetch.mock.calls[1][1].body).toBe(app.fetch.mock.calls[0][1].body);
  expect(app.nodes.queueRetryButton.hidden).toBe(true);
  expect(app.nodes.queueResumeButton.disabled).toBe(false);
});
test('upcoming controls are labelled by independent entry ID and submit complete order without moving locked current', async () => {
  const app = appHarness(); app.publish(1, { lockedEntryId: 'a', entries: [entry('a'), entry('b'), entry('c')] });
  const row = app.nodes.queueUpcoming.children[1];
  expect(row.children[2].children.map(button => button.textContent)).toEqual(['↑', '↓', '−']);
  expect(row.children[2].children.map(button => button.title)).toEqual(['Move up', 'Move down', 'Remove']);
  expect(row.children[2].children.map(button => button.attributes['aria-label'])).toEqual(['Move up: Title c', 'Move down: Title c', 'Remove: Title c']);
  expect(row.children[2].children[0].attributes['aria-label']).toMatch(/Title c/);
  app.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ ...app.context.nextSnapshot, version: 2 }) });
  app.run("queueClient.fetch = fetch; queueClient.commandId = () => 'move-c'");
  await app.run("moveQueueEntry('c', -1)");
  expect(JSON.parse(app.fetch.mock.calls[0][1].body)).toMatchObject({ type: 'reorder', entryIds: ['a', 'c', 'b'] });
});
test('remote dispatch removes edit controls for newly locked entry and stale action is explained, not retargeted', async () => {
  const app = appHarness(); app.publish(1);
  app.publish(2, { lockedEntryId: 'b' });
  expect(app.nodes.queueUpcoming.children.map(row => row.dataset.entryId)).toEqual(['a']);
  await app.run("moveQueueEntry('b', -1)");
  expect(app.fetch).not.toHaveBeenCalled();
  expect(app.nodes.queueActionStatus.textContent).toMatch(/upcoming/i);
});
test('Admin pause policy loads default off and saves only dedicated preference independently', async () => {
  const app = appHarness();
  app.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ pauseAfterAttempt: false }) });
  await app.run('loadQueuePreferences()');
  expect(app.nodes.pauseAfterAttempt.checked).toBe(false);
  app.nodes.pauseAfterAttempt.checked = true;
  app.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ pauseAfterAttempt: true }) });
  await app.run('saveQueuePreferences()');
  expect(app.fetch.mock.calls[1][0]).toBe('/api/queue/preferences');
  expect(JSON.parse(app.fetch.mock.calls[1][1].body)).toEqual({ pauseAfterAttempt: true });
  expect(app.nodes.queuePreferenceStatus.textContent).toMatch(/saved/i);
});
test('conditional Admin recovery is bound to displayed operation, requires actual restart and leaves server authoritative paused', async () => {
  const app = appHarness(); app.publish(1, { status: 'paused', pauseReason: 'restart' });
  expect(app.nodes.queueRecoveryAdminButton.hidden).toBe(true);
  expect(app.nodes.queueRecoverySection.hidden).toBe(true);
  app.publish(2, { status: 'paused' }, { id: 'exact-op', status: 'unknown' });
  expect(app.nodes.queueRecoveryAdminButton.hidden).toBe(false);
  expect(app.nodes.queueConfirmRestartButton.dataset.operationId).toBe('exact-op');
  app.context.confirm = jest.fn().mockReturnValue(true);
  app.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ ...app.context.nextSnapshot, version: 3, operation: null, session: { ...app.context.nextSnapshot.session, status: 'paused', pauseReason: 'Console restarted; Resume after new song-selection evidence' } }) });
  app.run("queueClient.fetch = fetch; queueClient.commandId = () => 'recover'");
  await app.run('confirmConsoleRestarted()');
  expect(app.context.confirm).toHaveBeenCalledWith(expect.stringMatching(/actually restarted.*does not restart/i));
  expect(JSON.parse(app.fetch.mock.calls[0][1].body)).toMatchObject({ type: 'confirm-console-restarted', operationId: 'exact-op', expectedVersion: 2 });
  expect(app.nodes.queueRecoverySection.hidden).toBe(true);
  expect(app.nodes.queueStatus.textContent).toMatch(/^Paused/);
});
test('recovery confirmation retains exact idempotency identity and Admin Retry even if authoritative SSE clears operation', async () => {
  const app = appHarness(); app.publish(1, { status: 'paused' }, { id: 'exact-op', status: 'unknown' });
  app.context.confirm = jest.fn().mockReturnValue(true);
  app.fetch.mockRejectedValueOnce(new Error('response lost'));
  app.run("queueClient.fetch = fetch; queueClient.commandId = () => 'recover-lost'");
  await app.run('confirmConsoleRestarted()');
  app.publish(2, { status: 'paused', pauseReason: 'Console restarted' });
  expect(app.nodes.queueRecoverySection.hidden).toBe(true);
  expect(app.nodes.queueAdminRetryButton.hidden).toBe(false);
  expect(app.nodes.queueAdminActionStatus.textContent).toMatch(/Result unknown/);
  app.fetch.mockResolvedValueOnce({ ok: true, json: async () => app.context.nextSnapshot });
  await app.run('retryQueueAction()');
  expect(app.fetch.mock.calls[1][1].body).toBe(app.fetch.mock.calls[0][1].body);
  expect(app.nodes.queueAdminRetryButton.hidden).toBe(true);
});
test('superseded recovery operation rejection is visible and never silently retries the new operation', async () => {
  const app = appHarness(); app.publish(1, { status: 'paused' }, { id: 'old-op', status: 'unknown' });
  app.context.confirm = jest.fn().mockReturnValue(true);
  app.fetch.mockResolvedValueOnce({ ok: false, status: 409, json: async () => ({ error: 'Confirm only the exact unresolved transmitted operation', snapshot: { ...app.context.nextSnapshot, version: 2, operation: { id: 'new-op', status: 'unknown' } } }) });
  app.run("queueClient.fetch = fetch; queueClient.commandId = () => 'stale-recovery'");
  await app.run('confirmConsoleRestarted()');
  expect(JSON.parse(app.fetch.mock.calls[0][1].body).operationId).toBe('old-op');
  expect(app.nodes.queueConfirmRestartButton.dataset.operationId).toBe('new-op');
  expect(app.nodes.queueRecoveryStatus.textContent).toMatch(/not applied/);
  expect(app.fetch).toHaveBeenCalledTimes(1);
});

test('Admin storage reconciliation is independent of SSE synchronization and reports ongoing failure then paused recovery', async () => {
  const app = appHarness(); app.publish(1, { status: 'paused' });
  app.run("queueClient.diagnostics = { inhibited: true, storageError: 'disk failed' }; queueClient.synchronized = false; renderQueue();");
  expect(app.nodes.queueRecoveryAdminButton.hidden).toBe(false);
  expect(app.nodes.queueStorageRecoverySection.hidden).toBe(false);
  expect(app.nodes.queueReconcileStorageButton.disabled).toBe(false);
  app.fetch.mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({ error: 'disk still failed', diagnostics: { inhibited: true, storageError: 'disk still failed' } }) });
  await app.run('reconcileQueueStorage()');
  expect(app.nodes.queueStorageRecoveryStatus.textContent).toMatch(/disk still failed/);
  expect(app.nodes.queueReconcileStorageButton.disabled).toBe(false);
  app.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ snapshot: { ...app.context.nextSnapshot, version: 2 }, diagnostics: { inhibited: false } }) });
  await app.run('reconcileQueueStorage()');
  expect(app.fetch.mock.calls.map(call => call[0])).toEqual(['/api/queue/storage/reconcile', '/api/queue/storage/reconcile']);
  expect(app.nodes.queueStorageRecoveryStatus.textContent).toMatch(/new song-selection.*Resume/);
  expect(app.nodes.queueStorageRecoverySection.hidden).toBe(true);
  expect(app.run('queueClient.synchronized')).toBe(false);
});
