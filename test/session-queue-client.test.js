const { QueueClient } = require('../public/session-queue');
const snapshot = (version, status = 'running', id = 'session') => ({ version, session: { id, status, entries: [] }, operation: null });
const response = (body, ok = true, status = 200) => ({ ok, status, json: async () => body });
function setup() {
  const sources = [];
  class Events {
    constructor(url) { this.url = url; this.handlers = {}; this.close = jest.fn(); sources.push(this); }
    addEventListener(name, handler) { this.handlers[name] = handler; }
    emit(name, value) { this.handlers[name]?.({ data: JSON.stringify(value) }); }
  }
  const fetch = jest.fn().mockResolvedValue(response(snapshot(1)));
  const change = jest.fn();
  const client = new QueueClient({ fetch, EventSource: Events, commandId: () => 'command-1', onChange: change });
  return { client, fetch, change, sources };
}
test('initial GET displays state but only a stream snapshot enables shared edits', async () => {
  const { client, sources } = setup();
  await client.connect();
  expect(client.snapshot.version).toBe(1);
  expect(client.synchronized).toBe(false);
  expect(client.canCommand).toBe(false);
  sources[0].emit('snapshot', snapshot(1));
  expect(client.canCommand).toBe(true);
});
test('SSE wins races with initial reads, historical command receipts and replaced sessions', async () => {
  const { client, fetch, sources } = setup();
  let finish;
  fetch.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const connecting = client.connect();
  sources[0].emit('snapshot', snapshot(10, 'running', 'new'));
  finish(response(snapshot(2, 'stopped', 'old'))); await connecting;
  fetch.mockResolvedValueOnce(response(snapshot(3, 'running', 'old')));
  await client.command('pause');
  expect(client.snapshot).toMatchObject({ version: 10, session: { id: 'new' } });
  expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({ commandId: 'command-1', type: 'pause', expectedVersion: 10, sessionId: 'new' });
});
test('disconnect disables edits until current snapshot on native reconnect, not merely open', async () => {
  const { client, sources } = setup(); await client.connect();
  sources[0].emit('snapshot', snapshot(2));
  sources[0].emit('error');
  expect(client.canCommand).toBe(false);
  await expect(client.command('pause')).rejects.toThrow(/synchron/i);
  sources[0].emit('open'); expect(client.canCommand).toBe(false);
  sources[0].emit('snapshot', snapshot(4)); expect(client.canCommand).toBe(true);
});
test('stale reconnect snapshots cannot certify synchronization', async () => {
  const { client, sources } = setup(); await client.connect();
  sources[0].emit('snapshot', snapshot(5)); sources[0].emit('error');
  sources[0].emit('snapshot', snapshot(3)); expect(client.canCommand).toBe(false);
  sources[0].emit('snapshot', snapshot(5)); expect(client.canCommand).toBe(true);
});
test('conflict applies authoritative state without replaying the action', async () => {
  const { client, sources, fetch } = setup(); await client.connect(); sources[0].emit('snapshot', snapshot(2));
  fetch.mockResolvedValueOnce(response({ code: 'STALE_VERSION', error: 'Queue changed', snapshot: snapshot(5) }, false, 409));
  await expect(client.command('pause')).rejects.toMatchObject({ code: 'STALE_VERSION', unknown: false });
  expect(client.snapshot.version).toBe(5);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(client.pendingCommand).toBe(null);
});
test('lost response retains exact command identity for Retry and blocks a fresh action', async () => {
  const { client, sources, fetch } = setup(); await client.connect(); sources[0].emit('snapshot', snapshot(2));
  fetch.mockRejectedValueOnce(new Error('lost response'));
  await expect(client.command('add', { shortname: 'repeat' })).rejects.toMatchObject({ unknown: true });
  const original = fetch.mock.calls[1][1].body;
  sources[0].emit('snapshot', snapshot(6));
  await expect(client.command('add', { shortname: 'repeat' })).rejects.toThrow(/Retry/);
  fetch.mockResolvedValueOnce(response(snapshot(3)));
  await client.retry();
  expect(fetch.mock.calls[2][1].body).toBe(original);
  expect(client.snapshot.version).toBe(6);
  expect(client.pendingCommand).toBe(null);
  expect(client.canCommand).toBe(true);
});
test('unreadable success is unknown, never a new command', async () => {
  const { client, sources, fetch } = setup(); await client.connect(); sources[0].emit('snapshot', snapshot(2));
  fetch.mockResolvedValueOnce({ ok: true, json: async () => { throw new Error('truncated'); } });
  await expect(client.command('start', { listId: 1, sort: 'artist', order: 'desc' })).rejects.toMatchObject({ unknown: true });
  expect(client.pendingCommand.type).toBe('start');
});
test('diagnostics update independently and malformed stream data disables commands without throwing', async () => {
  const { client, sources } = setup(); await client.connect(); sources[0].emit('snapshot', snapshot(2));
  sources[0].emit('diagnostics', { inhibited: true }); expect(client.diagnostics.inhibited).toBe(true);
  expect(() => sources[0].handlers.snapshot({ data: 'bad json' })).not.toThrow();
  expect(client.canCommand).toBe(false);
});
test('close disposes EventSource and ignores late asynchronous responses', async () => {
  const { client, sources, fetch } = setup(); let finish;
  fetch.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const connecting = client.connect(); client.close(); finish(response(snapshot(9))); await connecting;
  expect(sources[0].close).toHaveBeenCalledTimes(1);
  expect(client.snapshot).toBe(null);
  expect(client.synchronized).toBe(false);
});
test('duplicate/out-of-order SSE frames do not roll back state or unset an already synchronized connection', async () => {
  const { client, sources } = setup(); await client.connect();
  sources[0].emit('snapshot', snapshot(7)); sources[0].emit('snapshot', snapshot(4));
  expect(client.snapshot.version).toBe(7); expect(client.canCommand).toBe(true);
});
test('initial read failure leaves browsing intact and native SSE can resynchronize later', async () => {
  const { client, sources, fetch } = setup(); fetch.mockRejectedValueOnce(new Error('offline'));
  await expect(client.connect()).resolves.toBeUndefined();
  expect(client.snapshot).toBe(null); expect(client.canCommand).toBe(false);
  sources[0].emit('snapshot', snapshot(5)); expect(client.canCommand).toBe(true);
});
test('each deliberate new Add gets a new identity; in-flight actions cannot be submitted twice', async () => {
  const { client, sources, fetch } = setup(); await client.connect(); sources[0].emit('snapshot', snapshot(2));
  let next = 0, finish; client.commandId = () => `id-${++next}`;
  fetch.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const adding = client.command('add', { shortname: 'repeat' });
  expect(client.busy).toBe(true);
  await expect(client.command('add', { shortname: 'repeat' })).rejects.toThrow(/Retry/);
  finish(response(snapshot(3))); await adding;
  fetch.mockResolvedValueOnce(response(snapshot(4)));
  await client.command('add', { shortname: 'repeat' });
  expect(JSON.parse(fetch.mock.calls[1][1].body).commandId).toBe('id-1');
  expect(JSON.parse(fetch.mock.calls[2][1].body).commandId).toBe('id-2');
});
test('plain HTTP LAN browsers without randomUUID use Web Crypto for command identity', async () => {
  const vm = require('node:vm'), fs = require('node:fs');
  const fetch = jest.fn().mockResolvedValue(response(snapshot(2)));
  const crypto = { getRandomValues: jest.fn(array => { array.fill(42); return array; }) };
  const context = vm.createContext({ crypto, fetch });
  vm.runInContext(fs.readFileSync('public/session-queue.js', 'utf8'), context);
  context.initial = snapshot(1);
  await vm.runInContext('const client = new SessionQueue.QueueClient(); client.accept(initial); client.synchronized = true; client.command("pause")', context);
  expect(crypto.getRandomValues).toHaveBeenCalledTimes(1);
  expect(JSON.parse(fetch.mock.calls[0][1].body).commandId).toBe('2a'.repeat(16));
});
test('server failure after possible acceptance retains Retry identity, while applying any newer snapshot', async () => {
  const { client, sources, fetch } = setup(); await client.connect(); sources[0].emit('snapshot', snapshot(2));
  fetch.mockResolvedValueOnce(response({ code: 'QUEUE_UNAVAILABLE', error: 'Storage unavailable after mutation', snapshot: snapshot(3) }, false, 503));
  await expect(client.command('add', { shortname: 'repeat' })).rejects.toMatchObject({ unknown: true });
  expect(client.snapshot.version).toBe(3);
  expect(client.pendingCommand).toMatchObject({ commandId: 'command-1', expectedVersion: 2 });
});
