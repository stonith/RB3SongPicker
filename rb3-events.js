const dgram = require('node:dgram');
const { isIPv4 } = require('node:net');
const { EventEmitter } = require('node:events');
const { TextDecoder } = require('node:util');

// RB3Enhanced b4678376f503744f8be2f6b0fea3cb56227415f7, include/net_events.h.
// Only physical Xbox big-endian v0 packets are supported here.
const TYPES = ['ALIVE', 'STATE', 'SONG_NAME', 'SONG_ARTIST', 'SONG_SHORTNAME',
  'SCORE', 'STAGEKIT', 'BAND_INFO', 'VENUE_NAME', 'SCREEN_NAME', 'DX_DATA'];
const BINARY_SIZES = { SCORE: 21, STAGEKIT: 2, BAND_INFO: 12, DX_DATA: 250 };
const utf8 = new TextDecoder('utf-8', { fatal: true });

function decodePacket(packet, remote, { sourceAddress, receivedAt = Date.now() } = {}) {
  if (!isIPv4(sourceAddress || '') || remote?.address !== sourceAddress || !Buffer.isBuffer(packet) ||
      packet.length < 8 || packet.length > 263 || packet.readUInt32BE(0) !== 0x52423345 ||
      packet[4] !== 0 || packet[7] !== 0 || packet.length !== 8 + packet[6]) return null;
  const type = TYPES[packet[5]];
  if (!type) return null;
  const payload = packet.subarray(8);
  let value;
  if (type === 'STATE') {
    if (payload.length !== 1 || payload[0] > 1) return null;
    value = payload[0];
  } else if (Object.hasOwn(BINARY_SIZES, type)) {
    if (payload.length !== BINARY_SIZES[type]) return null;
    value = Buffer.from(payload);
  } else {
    const text = payload[payload.length - 1] === 0 ? payload.subarray(0, -1) : payload;
    if (text.includes(0)) return null;
    try { value = utf8.decode(text); } catch { return null; }
    if (/[\x00-\x1f\x7f]/.test(value)) return null;
    if ((type === 'SONG_SHORTNAME' || type === 'SCREEN_NAME') && !value.trim()) return null;
  }
  return { type, value, platform: 0, receivedAt, sourceAddress };
}

function endpoint(config) {
  const result = { sourceAddress: config.sourceAddress, bindAddress: config.bindAddress ?? '0.0.0.0', port: config.port ?? 21070 };
  if (!isIPv4(result.sourceAddress || '') || !isIPv4(result.bindAddress) ||
      !Number.isInteger(result.port) || result.port < 1 || result.port > 65535) {
    throw new TypeError('UDP events require IPv4 source/bind addresses and a port from 1 to 65535');
  }
  return result;
}

class Rb3Events extends EventEmitter {
  constructor(config, { now = Date.now, createSocket = () => dgram.createSocket('udp4') } = {}) {
    super();
    this.config = endpoint(config);
    this.now = now;
    this.createSocket = createSocket;
    this.socket = null;
    this.status = 'stopped';
    this.error = null;
    this.lastObservedAt = null;
    this.droppedPackets = 0;
    this.starting = null;
  }

  diagnostics() {
    return { ...this.config, status: this.status, error: this.error,
      lastObservedAt: this.lastObservedAt, droppedPackets: this.droppedPackets };
  }

  invalidate(reason) {
    this.lastObservedAt = null;
    this.emit('invalidate', reason);
  }

  start() {
    if (this.status === 'listening') return Promise.resolve(true);
    if (this.starting) return this.starting;
    this.invalidate('listener-start');
    this.status = 'binding';
    this.error = null;
    let settle;
    const pending = new Promise(resolve => { settle = resolve; });
    this.starting = pending;
    this.settleStart = value => {
      this.starting = null;
      this.settleStart = null;
      settle(value);
    };
    let socket;
    const fail = error => {
      if (socket && this.socket !== socket) return;
      this.socket = null;
      this.status = 'error';
      this.error = error.message;
      this.invalidate('listener-error');
      this.settleStart?.(false);
      if (socket) { try { socket.close(); } catch { /* Binding may have failed before opening. */ } }
    };
    try {
      socket = this.createSocket();
      this.socket = socket;
      socket.on('message', (packet, remote) => {
        if (this.socket !== socket || this.status !== 'listening') return;
        const observation = decodePacket(packet, remote, { sourceAddress: this.config.sourceAddress, receivedAt: this.now() });
        if (!observation) { this.droppedPackets++; return; }
        this.lastObservedAt = observation.receivedAt;
        this.emit('observation', observation);
      });
      socket.on('error', fail);
      socket.on('close', () => {
        if (this.socket !== socket) return;
        this.socket = null;
        this.status = 'stopped';
        this.invalidate('listener-close');
        this.settleStart?.(false);
      });
      socket.once('listening', () => {
        if (this.socket !== socket) return;
        this.status = 'listening';
        this.settleStart?.(true);
      });
      socket.bind(this.config.port, this.config.bindAddress);
    } catch (error) { fail(error); }
    return pending;
  }

  async stop(reason = 'listener-stop') {
    const socket = this.socket;
    this.socket = null;
    this.settleStart?.(false);
    this.status = 'stopped';
    this.invalidate(reason);
    if (socket) await new Promise(resolve => {
      try { socket.close(resolve); } catch { resolve(); }
    });
  }

  async configure(config) {
    const next = endpoint(config);
    if (JSON.stringify(next) === JSON.stringify(this.config)) return;
    await this.stop('endpoint-change');
    this.config = next;
    return this.start();
  }
}

module.exports = { decodePacket, Rb3Events };
