const { PickerModel } = require('../public/queue-picker');
const { QueueClient, moveEntryOrder, recoveryOperationId, describeDiagnostics } = require('../public/session-queue');
const entry = (id, shortname = id, status = 'pending') => ({ id, shortname, title: shortname, status });
const snapshot = (version = 1) => ({ version, session: { id: 'session', status: 'paused', entries: [entry('a'), entry('b')], sourceList: { name: 'Party' } }, operation: null });
function harness() {
  const fetch = jest.fn(); let id = 0;
  const client = new QueueClient({ fetch, commandId: () => `cmd-${++id}` });
  client.accept(snapshot()); client.synchronized = true;
  const picker = new PickerModel({ client, fetch });
  return { fetch, client, picker };
}
const response = body => ({ ok: true, json: async () => body });
test('picker search/list context uses library API independently and retains all 5,000 results for virtualization', async () => {
  const { picker, fetch } = harness();
  const songs = Array.from({ length: 5000 }, (_, i) => entry(String(i)));
  fetch.mockResolvedValue(response({ songs }));
  await picker.load({ search: 'Song', listId: '4' });
  expect(fetch.mock.calls[0][0]).toBe('/api/songs?sort=title&order=asc&search=Song&listId=4');
  expect(picker.songs).toHaveLength(5000);
  expect(picker.filters).toEqual({ search: 'Song', listId: '4' });
});
test('older search responses cannot replace newer picker results', async () => {
  const { picker, fetch } = harness(); let resolve;
  fetch.mockReturnValueOnce(new Promise(r => { resolve = r; })).mockResolvedValueOnce(response({ songs: [entry('new')] }));
  const old = picker.load({ search: 'old', listId: '' });
  await picker.load({ search: 'new', listId: '' }); resolve(response({ songs: [entry('old')] })); await old;
  expect(picker.songs[0].id).toBe('new');
});
test('confirmed repeated Adds create fresh independent identities and acknowledge without resetting filters', async () => {
  const { picker, fetch } = harness(); picker.filters = { search: 'a', listId: '4' };
  fetch.mockResolvedValueOnce(response(snapshot(2))).mockResolvedValueOnce(response(snapshot(3)));
  await picker.add(entry('a')); await picker.add(entry('a'));
  expect(fetch.mock.calls.map(call => JSON.parse(call[1].body))).toEqual([
    expect.objectContaining({ type: 'add', shortname: 'a', commandId: 'cmd-1', expectedVersion: 1 }),
    expect.objectContaining({ type: 'add', shortname: 'a', commandId: 'cmd-2', expectedVersion: 2 })
  ]);
  expect(picker.filters).toEqual({ search: 'a', listId: '4' });
  expect(picker.feedback).toMatch(/Added a.*Add again.*repeat/i);
});
test('lost Add response exposes unknown row and retries original identity before a new intentional repeat', async () => {
  const { picker, fetch, client } = harness();
  fetch.mockRejectedValueOnce(new Error('lost')).mockResolvedValueOnce(response(snapshot(2))).mockResolvedValueOnce(response(snapshot(3)));
  await picker.add(entry('a'));
  expect(picker.rowState('a')).toMatchObject({ label: 'Result unknown — Retry', retry: true, disabled: false });
  expect(picker.rowState('b').disabled).toBe(true);
  expect(client.pendingCommand.shortname).toBe('a');
  await picker.retry(); await picker.add(entry('a'));
  expect(fetch.mock.calls[1][1].body).toBe(fetch.mock.calls[0][1].body);
  expect(JSON.parse(fetch.mock.calls[2][1].body).commandId).toBe('cmd-2');
});
test('Adding state is visible before return and disconnection disables Retry', async () => {
  const { picker, fetch, client } = harness(); let reject;
  fetch.mockReturnValue(new Promise((_, r) => { reject = r; }));
  const pending = picker.add(entry('a'));
  expect(picker.rowState('a')).toMatchObject({ label: 'Adding…', disabled: true });
  reject(new Error('lost')); await pending; client.synchronized = false;
  expect(picker.rowState('a').disabled).toBe(true);
});
test('conflict applies authoritative snapshot with feedback and preserves picker query/results', async () => {
  const { picker, fetch, client } = harness(); picker.filters.search = 'keep'; picker.songs = [entry('a')];
  fetch.mockResolvedValue({ ok: false, status: 409, json: async () => ({ error: 'Queue changed', snapshot: snapshot(7) }) });
  await picker.add(entry('a'));
  expect(client.snapshot.version).toBe(7); expect(client.pendingCommand).toBe(null);
  expect(picker.feedback).toMatch(/not applied.*Queue changed/i);
  expect(picker.filters.search).toBe('keep'); expect(picker.songs).toHaveLength(1);
});
test.each(['completed', 'stopped'])('terminal %s disables Add rather than implicitly reviving session', status => {
  const { picker, client } = harness(); client.snapshot.session.status = status;
  expect(picker.rowState('a').disabled).toBe(true);
});
test('move swaps only independent upcoming IDs while preserving locked and handled slots', () => {
  const value = snapshot(); value.session.entries = [entry('done', 'a', 'handled'), entry('locked'), entry('b', 'repeat'), entry('c', 'repeat')]; value.session.lockedEntryId = 'locked';
  expect(moveEntryOrder(value, 'c', -1)).toEqual(['done', 'locked', 'c', 'b']);
  expect(value.session.entries.map(e => e.id)).toEqual(['done', 'locked', 'b', 'c']);
  expect(() => moveEntryOrder(value, 'locked', 1)).toThrow(/upcoming/i);
  expect(() => moveEntryOrder(value, 'b', -1)).toThrow(/position/i);
});
test('only exact unresolved transmitted operation exposes restart recovery, never an ordinary paused restart', () => {
  expect(recoveryOperationId(snapshot())).toBe(null);
  expect(recoveryOperationId({ ...snapshot(), operation: { id: 'reserved', status: 'reserved' } })).toBe(null);
  expect(recoveryOperationId({ ...snapshot(), operation: { id: 'exact', status: 'unknown' } })).toBe('exact');
});
test('diagnostics describe listener/source/last observations without heartbeat or age readiness gates', () => {
  const text = describeDiagnostics({ listener: { status: 'listening', bindAddress: '0.0.0.0', port: 21070, sourceAddress: '192.0.2.1', lastObservedAt: 1000 }, evidence: { screen: { name: 'song_select_screen', receivedAt: 1000 } } });
  expect(text).toMatch(/listening.*192\.0\.2\.1/); expect(text).toMatch(/Last observed/i); expect(text).toMatch(/song_select_screen/);
  expect(text).not.toMatch(/connected|heartbeat healthy|too old/i);
});
test('picker library failure is visible, leaves queue mutations independent and can be retried', async () => {
  const { picker, fetch } = harness();
  fetch.mockResolvedValueOnce({ ok: false }).mockResolvedValueOnce(response({ songs: [entry('retry')] }));
  await picker.load({ search: '', listId: '' });
  expect(picker.loading).toBe(false); expect(picker.loadError).toMatch(/Cannot load songs/);
  expect(picker.rowState('a').disabled).toBe(false);
  await picker.load(); expect(picker.loadError).toBe(''); expect(picker.songs[0].id).toBe('retry');
});
test('an accepted Add retry remains available after queue completes without permitting fresh additions', async () => {
  const { picker, fetch, client } = harness();
  fetch.mockRejectedValueOnce(new Error('lost'));
  await picker.add(entry('a'));
  const completed = snapshot(4); completed.session.status = 'completed'; client.accept(completed);
  expect(picker.rowState('a').retry).toBe(true);
  expect(picker.rowState('b').disabled).toBe(true);
  fetch.mockResolvedValueOnce(response(snapshot(2)));
  await picker.retry();
  expect(client.snapshot.version).toBe(4);
  expect(client.snapshot.session.status).toBe('completed');
  expect(picker.rowState('a').disabled).toBe(true);
});
