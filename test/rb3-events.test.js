const { EventEmitter } = require('node:events');
const { decodePacket, Rb3Events } = require('../rb3-events');
const packets = require('./fixtures/rb3-events/packets.json');
const sourceAddress = '192.0.2.10';
const source = { address: sourceAddress, port: 21070 };
const packet = name => Buffer.from(packets[name], 'hex');
function decode(buffer, remote = source) { return decodePacket(buffer, remote, { sourceAddress, receivedAt: 123 }); }
function raw(type, payload, platform = 0) {
  return Buffer.concat([Buffer.from([0x52, 0x42, 0x33, 0x45, 0, type, payload.length, platform]), payload]);
}

describe('RB3Enhanced Xbox v0 decoder', () => {
  test('decodes non-NUL and optional NUL shortnames with local timestamp', () => {
    for (const name of ['shortname', 'shortnameNul']) expect(decode(packet(name))).toEqual({
      type: 'SONG_SHORTNAME', value: 'alpha', platform: 0, receivedAt: 123, sourceAddress
    });
  });
  test('unsigned payload length accepts all 255 bytes', () => {
    expect(decode(raw(2, Buffer.alloc(255, 97))).value).toHaveLength(255);
  });
  test.each([['songSelect', 'SCREEN_NAME', 'song_select_screen'], ['start', 'STATE', 1],
    ['end', 'STATE', 0], ['alive', 'ALIVE', 'build']])('%s decodes', (name, type, value) => {
    expect(decode(packet(name))).toMatchObject({ type, value });
  });
  test.each([5, 6, 7, 10])('valid irrelevant binary type %i is recognized', type => {
    const sizes = { 5: 21, 6: 2, 7: 12, 10: 250 };
    expect(decode(raw(type, Buffer.alloc(sizes[type]))).type).toBe(['ALIVE', 'STATE', 'SONG_NAME',
      'SONG_ARTIST', 'SONG_SHORTNAME', 'SCORE', 'STAGEKIT', 'BAND_INFO', 'VENUE_NAME', 'SCREEN_NAME', 'DX_DATA'][type]);
  });
  test.each(['magic', 'version', 'size', 'truncated', 'oversized', 'type', 'platform', 'littleEndian'])('rejects %s', fault => {
    let buffer = packet('shortname');
    if (fault === 'magic') buffer[0] = 0;
    if (fault === 'version') buffer[4] = 1;
    if (fault === 'size') buffer[6]++;
    if (fault === 'truncated') buffer = buffer.subarray(0, 7);
    if (fault === 'oversized') buffer = Buffer.alloc(264);
    if (fault === 'type') buffer[5] = 11;
    if (fault === 'platform') buffer[7] = 1;
    if (fault === 'littleEndian') buffer.writeUInt32LE(0x52423345);
    expect(decode(buffer)).toBeNull();
  });
  test('requires exact configured source, not source port or ALIVE claims', () => {
    expect(decode(packet('start'), { address: '192.0.2.11' })).toBeNull();
    expect(decodePacket(packet('start'), source, {})).toBeNull();
    expect(decode(packet('start'), { ...source, port: 9999 })).not.toBeNull();
  });
  test.each([[1, []], [1, [2]], [1, [1, 0]], [5, [0]], [6, [0]], [7, [0]], [10, [0]],
    [4, []], [9, []], [4, [97, 0, 98]], [4, [0xff]], [9, [10]]])('rejects malformed payload type %i %j', (type, bytes) => {
    expect(decode(raw(type, Buffer.from(bytes)))).toBeNull();
  });
  test('empty display metadata is allowed, but embedded/trailing multiple NUL is not', () => {
    expect(decode(raw(2, Buffer.alloc(0))).value).toBe('');
    expect(decode(raw(4, Buffer.from('alpha\0\0')))).toBeNull();
    expect(decode(raw(4, Buffer.concat([Buffer.alloc(254, 97), Buffer.from([0])]))).value).toHaveLength(254);
  });
});

class Socket extends EventEmitter {
  bind(port, address) { this.bound = { port, address }; this.emit('listening'); }
  close(callback) { this.closed = true; this.emit('close'); callback?.(); }
}
describe('RB3 UDP listener lifecycle', () => {
  let sockets, listener, observations, invalidations;
  beforeEach(() => {
    sockets = []; observations = []; invalidations = [];
    listener = new Rb3Events({ sourceAddress }, { now: () => 456, createSocket: () => {
      const socket = new Socket(); sockets.push(socket); return socket;
    } });
    listener.on('observation', observation => observations.push(observation));
    listener.on('invalidate', reason => invalidations.push(reason));
  });
  afterEach(async () => listener.stop());
  test('binds configured UDP endpoint, validates packets and timestamps receives', async () => {
    await listener.start();
    expect(sockets[0].bound).toEqual({ port: 21070, address: '0.0.0.0' });
    sockets[0].emit('message', packet('songSelect'), source);
    sockets[0].emit('message', packet('start'), { address: '192.0.2.11' });
    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({ type: 'SCREEN_NAME', receivedAt: 456 });
    expect(listener.diagnostics()).toMatchObject({ status: 'listening', lastObservedAt: 456, droppedPackets: 1 });
  });
  test('bind failure is diagnostic, invalidates evidence and closes socket without throwing', async () => {
    listener.createSocket = () => { const socket = new Socket(); socket.bind = () => socket.emit('error', new Error('EADDRINUSE')); sockets.push(socket); return socket; };
    await expect(listener.start()).resolves.toBe(false);
    expect(listener.diagnostics()).toMatchObject({ status: 'error', error: 'EADDRINUSE' });
    expect(sockets[0].closed).toBe(true);
    expect(invalidations).toContain('listener-error');
  });
  test('runtime errors invalidate and permit rebind; obsolete callbacks are ignored', async () => {
    await listener.start();
    sockets[0].emit('error', new Error('lost socket'));
    await listener.start();
    sockets[0].emit('message', packet('songSelect'), source);
    sockets[1].emit('message', packet('songSelect'), source);
    expect(observations).toHaveLength(1);
    expect(sockets[0].closed).toBe(true);
  });
  test('endpoint change and shutdown reset evidence and release old sockets', async () => {
    await listener.start();
    await listener.configure({ sourceAddress: '192.0.2.20', bindAddress: '127.0.0.1', port: 21071 });
    expect(sockets[0].closed).toBe(true);
    expect(sockets[1].bound).toEqual({ port: 21071, address: '127.0.0.1' });
    sockets[1].emit('message', packet('songSelect'), source);
    expect(observations).toHaveLength(0);
    await listener.stop();
    sockets[1].emit('message', packet('songSelect'), { address: '192.0.2.20' });
    expect(observations).toHaveLength(0);
    expect(invalidations).toEqual(expect.arrayContaining(['listener-start', 'endpoint-change', 'listener-stop']));
  });
  test('unexpected socket close invalidates evidence', async () => {
    await listener.start(); sockets[0].emit('close');
    expect(listener.diagnostics().status).toBe('stopped');
    expect(invalidations).toContain('listener-close');
  });
  test('synchronous bind and socket creation failures remain nonfatal', async () => {
    listener.createSocket = () => { throw new Error('no transport'); };
    await expect(listener.start()).resolves.toBe(false);
    expect(listener.diagnostics().error).toBe('no transport');
    listener.createSocket = () => {
      const socket = new Socket(); socket.bind = () => { throw new Error('bind denied'); };
      sockets.push(socket); return socket;
    };
    await expect(listener.start()).resolves.toBe(false);
    expect(sockets[0].closed).toBe(true);
  });
  test('stopping a pending bind settles startup and ignores late listening', async () => {
    listener.createSocket = () => { const socket = new Socket(); socket.bind = () => {}; sockets.push(socket); return socket; };
    const starting = listener.start();
    expect(listener.start()).toBe(starting);
    await listener.stop();
    await expect(starting).resolves.toBe(false);
    sockets[0].emit('listening');
    expect(listener.diagnostics().status).toBe('stopped');
  });
  test('invalid endpoint rejected before binding; start/stop are idempotent', async () => {
    expect(() => new Rb3Events({ sourceAddress: 'hostname' })).toThrow();
    await listener.start(); await listener.start(); expect(sockets).toHaveLength(1);
    await expect(listener.configure({ sourceAddress, port: 65536 })).rejects.toThrow();
    expect(sockets[0].closed).not.toBe(true);
    await listener.stop(); await listener.stop(); expect(sockets[0].closed).toBe(true);
  });
});

test('real loopback UDP bind conflict, rebind, receive and shutdown release the port', async () => {
  const dgram = require('node:dgram');
  const { once } = require('node:events');
  let occupied = dgram.createSocket('udp4');
  occupied.bind(0, '127.0.0.1'); await once(occupied, 'listening');
  const port = occupied.address().port;
  const listener = new Rb3Events({ sourceAddress: '127.0.0.1', bindAddress: '127.0.0.1', port });
  const sender = dgram.createSocket('udp4');
  let occupiedClosed = false;
  try {
    expect(await listener.start()).toBe(false);
    expect(listener.diagnostics().error).toContain('EADDRINUSE');
    await new Promise(resolve => occupied.close(resolve)); occupiedClosed = true;
    expect(await listener.start()).toBe(true);
    const received = once(listener, 'observation', { signal: AbortSignal.timeout(2000) });
    sender.send(packet('songSelect'), port, '127.0.0.1');
    expect((await received)[0]).toMatchObject({ type: 'SCREEN_NAME', value: 'song_select_screen' });
    await listener.stop();
    occupied = dgram.createSocket('udp4'); occupiedClosed = false;
    occupied.bind(port, '127.0.0.1'); await once(occupied, 'listening');
  } finally {
    await listener.stop();
    sender.close();
    if (!occupiedClosed) await new Promise(resolve => occupied.close(resolve));
  }
});
