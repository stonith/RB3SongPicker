const express = require('express');

const wrapAsync = handler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
const snapshotFrame = snapshot => `event: snapshot\nid: ${snapshot.version}\ndata: ${JSON.stringify(snapshot)}\n\n`;

class QueueUpdates {
  constructor(runtime, { maxClients = 100, keepaliveMs = 25000 } = {}) {
    this.runtime = runtime;
    this.controller = runtime.controller;
    this.clients = new Set();
    this.maxClients = maxClients;
    this.closed = false;
    this.onSnapshot = snapshot => this.broadcast(snapshotFrame(snapshot), true);
    this.onDiagnostics = diagnostics => this.broadcast(`event: diagnostics\ndata: ${JSON.stringify(diagnostics)}\n\n`);
    this.onClose = () => this.close();
    this.controller.on('snapshot', this.onSnapshot);
    runtime.on('diagnostics', this.onDiagnostics);
    runtime.on('close', this.onClose);
    // These comments keep the browser transport alive, not console evidence.
    this.timer = setInterval(() => this.broadcast(': keepalive\n\n'), keepaliveMs);
    this.timer.unref?.();
  }

  drop(client, endResponse = true) {
    if (!this.clients.delete(client)) return;
    client.res.off('close', client.cleanup);
    client.res.off('error', client.cleanup);
    client.res.off('drain', client.drain);
    client.req.off('aborted', client.cleanup);
    if (endResponse) {
      client.res.end();
      if (client.blocked) client.res.destroy?.();
    }
  }

  send(client, frame, snapshot = false) {
    if (!this.clients.has(client)) return;
    // At most one write can be buffered in Node's response. A subscriber still
    // blocked at the next snapshot/keepalive reconnects for a fresh snapshot.
    if (client.blocked) {
      if (snapshot || frame.startsWith(':')) this.drop(client);
      return;
    }
    try { client.blocked = client.res.write(frame) === false; }
    catch { this.drop(client); }
  }

  broadcast(frame, snapshot = false) {
    for (const client of this.clients) if (client.ready) this.send(client, frame, snapshot);
  }

  subscribe(req, res) {
    if (this.closed || this.clients.size >= this.maxClients) {
      res.statusCode = 503; res.end(); return Promise.resolve();
    }
    const client = { req, res, ready: false, blocked: false };
    client.cleanup = () => this.drop(client);
    client.drain = () => { client.blocked = false; };
    this.clients.add(client);
    res.on('close', client.cleanup); res.on('error', client.cleanup); res.on('drain', client.drain);
    req.on('aborted', client.cleanup);
    // Registration and first read share the commit queue. No accepted update
    // can fall between the initial read and activation of this subscription.
    return this.controller.enqueue(async () => {
      if (!this.clients.has(client)) return;
      const snapshot = await this.runtime.store.read();
      if (!this.clients.has(client)) return;
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders?.();
      client.ready = true;
      this.send(client, snapshotFrame(snapshot), true);
      this.send(client, `event: diagnostics\ndata: ${JSON.stringify(this.runtime.diagnostics())}\n\n`);
    }).catch(error => { this.drop(client, res.headersSent === true); throw error; });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    this.controller.off('snapshot', this.onSnapshot);
    this.runtime.off('diagnostics', this.onDiagnostics);
    this.runtime.off('close', this.onClose);
    for (const client of [...this.clients]) this.drop(client);
  }
}

function createQueueRouter({ runtime, configStore }) {
  const router = express.Router();
  const updates = new QueueUpdates(runtime);
  router.updates = updates;
  router.close = () => updates.close();
  router.get('/', wrapAsync(async (req, res) => {
    res.json(await runtime.controller.enqueue(() => runtime.store.read()));
  }));
  router.get('/events', wrapAsync((req, res) => updates.subscribe(req, res)));
  router.get('/diagnostics', (req, res) => res.json(runtime.diagnostics()));
  router.get('/preferences', (req, res) => res.json({ pauseAfterAttempt: configStore.load().pauseAfterAttempt === true }));
  router.post('/preferences', (req, res) => {
    const body = req.body;
    if (!body || typeof body.pauseAfterAttempt !== 'boolean' || Object.keys(body).some(key => key !== 'pauseAfterAttempt')) {
      return res.status(400).json({ code: 'INVALID_PREFERENCES', error: 'Provide only pauseAfterAttempt (boolean).' });
    }
    const saved = configStore.save({ ...configStore.load(), pauseAfterAttempt: body.pauseAfterAttempt });
    res.json({ pauseAfterAttempt: saved.pauseAfterAttempt });
  });
  // Recovery is explicit and repeatable, not a selection command. It must remain
  // reachable even when storage failure prevents a snapshot/SSE subscription.
  router.post('/storage/reconcile', wrapAsync(async (req, res) => {
    await runtime.controller.reconcileStorage();
    const diagnostics = runtime.diagnostics();
    if (diagnostics.inhibited) {
      return res.status(503).json({ code: 'STORAGE_UNAVAILABLE', error: diagnostics.storageError, diagnostics });
    }
    const snapshot = await runtime.controller.enqueue(() => runtime.store.read());
    res.json({ snapshot, diagnostics });
  }));
  router.post('/commands', wrapAsync(async (req, res) => {
    res.json(await runtime.controller.command(req.body));
  }));
  router.use(async (error, req, res, next) => {
    if (res.headersSent) return next(error);
    try {
      const snapshot = await runtime.controller.enqueue(() => runtime.store.read());
      res.status(error.status || 503).json({ code: error.code || 'QUEUE_UNAVAILABLE', error: error.message, snapshot });
    } catch (readError) { next(readError); }
  });
  return router;
}

module.exports = { createQueueRouter, QueueUpdates };
