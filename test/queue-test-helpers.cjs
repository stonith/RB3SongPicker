const express = require('express');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const Database = require('../database');
const ConfigStore = require('../config-store');
const QueueRuntime = require('../queue-runtime');
const { createQueueRouter } = require('../queue-router');
const { createApiRouter } = require('../api-router');

class FakeListener extends EventEmitter {
  constructor(config) { super(); this.config = config; this.status = 'stopped'; this.error = null; }
  diagnostics() { return { ...this.config, status: this.status, error: this.error }; }
  async start() { this.emit('invalidate', 'listener-start'); this.status = 'listening'; return true; }
  async stop() { this.status = 'stopped'; this.emit('invalidate', 'listener-stop'); }
  async configure(config) { await this.stop(); this.config = config; return this.start(); }
  fail() { this.status = 'error'; this.error = 'EADDRINUSE'; this.emit('invalidate', 'listener-error'); }
}
async function harness({ filename = ':memory:', createListener = config => new FakeListener(config), storeOptions } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rb3-queue-api-'));
  const configStore = new ConfigStore(path.join(directory, 'config.json'));
  const db = new Database(filename);
  const xbox = { selectSong: jest.fn().mockResolvedValue('OK'), fetch: jest.fn() };
  const runtime = new QueueRuntime({ db, configStore, xboxService: xbox, createListener, storeOptions });
  await runtime.initialize();
  await db.promisifyRun("INSERT OR IGNORE INTO songs (shortname, title) VALUES ('a', 'A'), ('b', 'B'), ('x', 'X')");
  await db.promisifyRun("INSERT OR IGNORE INTO songlists (id, name) VALUES (1, 'Party')");
  await db.promisifyRun("INSERT OR IGNORE INTO songlist_items VALUES (1, 'a'), (1, 'b')");
  const app = express(); app.use(express.json());
  const router = createQueueRouter({ runtime, configStore });
  app.use('/api/queue', router);
  app.use('/api', createApiRouter({ db, configStore, xboxService: xbox, queueController: runtime.controller, queueRuntime: runtime }));
  app.use((error, req, res, next) => res.status(error.status || 500).json({ error: error.message }));
  const command = async (type, extra = {}) => { const s = await runtime.store.read(); return {
    commandId: `${type}-${s.version}`, type, expectedVersion: s.version, sessionId: s.session?.id || null, ...extra
  }; };
  const observe = async (type, value) => { runtime.listener.emit('observation', { type, value, receivedAt: Date.now() }); await runtime.controller.idle(); };
  const close = async () => { await runtime.close(); router.close(); await db.close(); fs.rmSync(directory, { recursive: true, force: true }); };
  return { app, db, xbox, runtime, router, configStore, command, observe, close };
}
module.exports = { harness, FakeListener };
