const { EventEmitter } = require('node:events');
const SelectionCoordinator = require('./selection-coordinator');
const { QueueStoreError } = require('./queue-store');
const active = session => session && ['running', 'paused'].includes(session.status);

class QueueController extends EventEmitter {
  constructor({ store, gameState, xboxService, pauseAfterAttempt = () => false }) {
    super();
    this.store = store;
    this.game = gameState;
    this.pauseAfterAttempt = pauseAfterAttempt;
    this.tail = Promise.resolve();
    this.generation = 0;
    this.closed = false;
    this.inhibited = false;
    this.storageError = null;
    this.pendingResults = new Map();
    this.lifecycleBacklog = [];
    this.lifecycleOverflow = false;
    this.manualWaiters = new Map();
    this.selection = new SelectionCoordinator({ xboxService,
      onResult: (id, result) => this.reconcileOperation(id, result) });
    this.onTransition = event => {
      if (event.type === 'reset' || event.type === 'uncertain') this.generation++;
      const policy = event.type === 'attempt-started' ? !!this.pauseAfterAttempt() : false;
      // Persist boundaries in receive order before considering newer screen
      // evidence. Retain failed boundaries for storage reconciliation, bounded
      // even if the console keeps reporting attempts while storage is down.
      if (this.lifecycleBacklog.length < 64) this.lifecycleBacklog.push({ event, policy });
      else { this.lifecycleOverflow = true; this.inhibit(new Error('Too many unpersisted lifecycle boundaries')); }
      this.enqueue(async () => {
        if (this.inhibited) return;
        try { await this.drainLifecycle(); await this.pump(); }
        catch (error) { this.inhibit(error); }
      });
    };
    this.game.on('transition', this.onTransition);
  }

  enqueue(work) {
    const task = this.tail.then(work);
    this.tail = task.catch(() => {});
    return task;
  }

  async idle() {
    // Flush already-resolved transport callbacks, never wait on an HTTP request.
    let previous;
    do { previous = this.tail; await previous; await Promise.resolve(); } while (previous !== this.tail);
  }

  async initialize() {
    await this.store.initialize();
    // Reset before accepting observations/controls, without treating startup as
    // another live listener failure. A persisted transmission stays quarantined.
    this.game.off('transition', this.onTransition);
    this.game.reset('startup');
    this.game.on('transition', this.onTransition);
    const s = await this.store.read();
    if (s.operation?.status === 'reserved' || (active(s.session) && (s.session.lockedEntryId || s.session.currentAttempt))) {
      await this.store.transition(snapshot => {
        if (snapshot.operation?.status === 'reserved') {
          const op = snapshot.operation;
          if (snapshot.session?.id === op.sessionId && snapshot.session.lockedEntryId === op.entryId) snapshot.session.lockedEntryId = null;
          snapshot.operation = null;
        }
        if (active(snapshot.session) && (snapshot.session.lockedEntryId || snapshot.session.currentAttempt)) snapshot.session.selectionUncertain = true;
      });
    }
    return this.store.read();
  }

  observe(observation) {
    if (this.closed) return;
    // Evidence updates synchronously, even while a reservation is awaiting SQLite.
    this.game.observe(observation);
    this.enqueue(async () => { try { await this.pump(); } catch (error) { this.inhibit(error); } });
  }

  diagnostics() {
    return { inhibited: this.inhibited, storageError: this.storageError, evidence: this.game.snapshot(), closed: this.closed };
  }

  inhibit(error) {
    this.inhibited = true;
    this.storageError = error.message;
    this.generation++;
    this.emit('diagnostics', this.diagnostics());
  }

  conflict(code, message, snapshot) {
    const error = new QueueStoreError(code, message, snapshot);
    error.status = 409;
    throw error;
  }

  publish(snapshot) { this.emit('snapshot', snapshot); }

  command(command) {
    // An arriving safety control invalidates an unsent reservation immediately;
    // its revision/session acceptance still happens on the serialized path.
    if (['pause', 'stop', 'skip', 'confirm-console-restarted'].includes(command?.type)) this.generation++;
    return this.enqueue(async () => {
      if (this.closed) this.conflict('CONTROLLER_CLOSED', 'Queue controller is closed.', await this.store.read());
      let result;
      if (command?.type === 'start') {
        result = await this.store.start(command, session => {
          // Sample live evidence inside durable acceptance, after any seed wait.
          // Manual gameplay belongs to no queue entry, even after Stop/Start.
          const attempt = this.game.snapshot().attempt;
          if (attempt) {
            session.currentAttempt = { ...attempt, entryId: null, expected: false,
              pauseAfterAttempt: false, skipRequested: false };
            session.status = 'paused'; session.pauseReason = `Unexpected song: ${attempt.shortname}`;
          }
        });
      } else if (['add', 'remove', 'reorder'].includes(command?.type)) result = await this.store[command.type](command);
      else {
        const fields = command?.type === 'confirm-console-restarted' ? ['operationId'] : [];
        const normalized = this.store.normalizeCommand(command, command?.type, fields);
        let reset = false;
        result = await this.store.execute(normalized, snapshot => {
          const session = snapshot.session;
          if (normalized.type === 'confirm-console-restarted') {
            if (this.inhibited) this.conflict('STORAGE_UNAVAILABLE', 'Reconcile storage before confirming console restart.', snapshot);
            if (!snapshot.operation || snapshot.operation.id !== normalized.operationId || snapshot.operation.status === 'reserved') {
              this.conflict('STALE_OPERATION', 'Confirm only the exact unresolved transmitted operation.', snapshot);
            }
            snapshot.operation = null;
            if (active(session)) {
              session.status = 'paused'; session.pauseReason = 'Console restarted; Resume after new song-selection evidence';
              session.currentAttempt = null; session.lockedEntryId = null; session.selectionUncertain = false;
            }
            reset = true;
            return;
          }
          this.store.editable(snapshot);
          if (normalized.type === 'pause') { session.status = 'paused'; session.pauseReason = 'Manually paused'; }
          else if (normalized.type === 'stop') { session.status = 'stopped'; session.pauseReason = null; }
          else if (normalized.type === 'resume') {
            if (this.inhibited || snapshot.operation || session.selectionUncertain || this.game.snapshot().uncertainty
                || (session.currentAttempt && !session.currentAttempt.expected)) {
              this.conflict('UNSAFE_RESUME', 'Unresolved command or gameplay; Resume cannot resolve uncertainty. Skip or Stop, or reconcile the exact operation.', snapshot);
            }
            session.status = 'running'; session.pauseReason = null;
          } else if (normalized.type === 'skip') {
            if (session.currentAttempt && this.game.snapshot().attempt?.id === session.currentAttempt.id) {
              // Preserve tracking even for unexpected gameplay. Skip only the
              // pending expected entry when its accepted end arrives.
              session.currentAttempt.skipRequested = true;
              session.currentAttempt.skipEntryId = session.lockedEntryId || session.entries.find(e => e.status === 'pending')?.id || null;
            } else {
              const entry = session.entries.find(e => e.id === session.lockedEntryId) || session.entries.find(e => e.status === 'pending');
              if (entry) entry.status = 'skipped';
              session.lockedEntryId = null; session.currentAttempt = null; session.selectionUncertain = false;
              reset = true;
            }
          } else this.conflict('INVALID_COMMAND', 'Unknown queue control.', snapshot);
          this.complete(snapshot);
        });
        if (reset) this.resetEvidence('explicit-recovery');
      }
      // Receipt replay may return an older snapshot. Publish only a fresh read;
      // pump consults current state and can never dispatch from a receipt.
      try { await this.pump(); }
      catch (error) { this.inhibit(error); throw error; }
      this.publish(await this.store.read());
      return result;
    });
  }

  resetEvidence(reason) {
    this.generation++;
    this.game.off('transition', this.onTransition);
    this.game.reset(reason);
    this.game.on('transition', this.onTransition);
  }

  complete(snapshot) {
    const session = snapshot.session;
    if (active(session) && !snapshot.operation && !session.lockedEntryId && !session.currentAttempt
        && !this.game.snapshot().attempt && !session.entries.some(e => e.status === 'pending')) {
      session.status = 'completed'; session.pauseReason = null;
    }
  }

  async drainLifecycle() {
    while (this.lifecycleBacklog.length) {
      const { event, policy } = this.lifecycleBacklog[0];
      await this.lifecycle(event, policy);
      this.lifecycleBacklog.shift();
    }
  }

  async lifecycle(event, policy) {
    if (this.closed) return;
    const current = await this.store.read();
    if (!active(current.session)) return;
    const snapshot = await this.store.transition(s => {
      const session = s.session;
      if (event.type === 'attempt-started') {
        // Start may already have adopted this boundary while awaiting its seed.
        if (session.currentAttempt?.id === event.attempt.id) return;
        if (session.currentAttempt || session.selectionUncertain) {
          session.status = 'paused'; session.pauseReason = 'Unresolved previous attempt'; session.selectionUncertain = true;
          return;
        }
        const entry = session.entries.find(e => e.id === session.lockedEntryId && e.status === 'pending');
        const expected = !!entry && entry.shortname === event.attempt.shortname;
        session.currentAttempt = { ...event.attempt, entryId: expected ? entry.id : null,
          expected, pauseAfterAttempt: policy, skipRequested: false };
        if (!expected) { session.status = 'paused'; session.pauseReason = `Unexpected song: ${event.attempt.shortname}`; }
      } else if (event.type === 'attempt-ended') {
        const attempt = session.currentAttempt;
        if (!attempt || attempt.id !== event.attempt.id || session.selectionUncertain) {
          session.status = 'paused'; session.pauseReason = 'Uncorrelated attempt end'; session.selectionUncertain = true;
          return;
        }
        const entry = session.entries.find(e => e.id === (attempt.skipRequested ? attempt.skipEntryId : attempt.entryId));
        if (entry) entry.status = attempt.skipRequested ? 'skipped' : 'handled';
        session.currentAttempt = null; session.lockedEntryId = null;
        if (attempt.expected && attempt.pauseAfterAttempt && session.status === 'running') {
          session.status = 'paused'; session.pauseReason = 'Pause after each song attempt';
        }
        this.complete(s);
      } else if (event.type === 'reset' || event.type === 'uncertain') {
        session.status = 'paused'; session.pauseReason = `Console state unknown: ${event.reason}`;
        if (session.lockedEntryId || session.currentAttempt || event.type === 'uncertain') session.selectionUncertain = true;
      }
    });
    this.publish(snapshot);
  }

  gate(operation) {
    if (this.closed || this.inhibited || operation.generation !== this.generation) return false;
    if (operation.owner === 'manual') return true;
    const evidence = this.game.snapshot();
    return evidence.canSelect && evidence.epoch === operation.epoch && evidence.screen.opportunityId === operation.opportunityId;
  }

  async pump() {
    if (this.closed || this.inhibited || this.lifecycleBacklog.length) return;
    let snapshot = await this.store.read();
    const before = snapshot.session?.status;
    this.complete(snapshot);
    if (snapshot.session?.status !== before) {
      snapshot = await this.store.transition(s => this.complete(s)); this.publish(snapshot);
    }
    const session = snapshot.session;
    const evidence = this.game.snapshot();
    if (snapshot.operation || session?.status !== 'running' || session.lockedEntryId || session.currentAttempt
        || session.selectionUncertain || !evidence.canSelect) return;
    const entry = session.entries.find(e => e.status === 'pending');
    if (!entry) return;
    const operation = this.selection.reservation({ owner: 'queue', sessionId: session.id, entryId: entry.id,
      shortname: entry.shortname, epoch: evidence.epoch, opportunityId: evidence.screen.opportunityId, generation: this.generation });
    snapshot = await this.store.transition(async (s, db) => {
      const song = await db.promisifyGet('SELECT shortname FROM songs WHERE shortname = ? AND present = 1', [entry.shortname]);
      if (!song) { s.session.status = 'paused'; s.session.pauseReason = `Song unavailable: ${entry.shortname}`; return; }
      s.operation = operation; s.session.lockedEntryId = entry.id;
    });
    this.publish(snapshot);
    if (snapshot.operation?.id === operation.id) await this.sendReserved(operation);
  }

  async sendReserved(operation) {
    if (!this.gate(operation)) return this.cancelUnsent(operation);
    const snapshot = await this.store.transition(s => {
      if (s.operation?.id === operation.id) { s.operation.status = 'transmitted'; s.operation.sentAt = Date.now(); }
    });
    // SQLite may have waited behind library refresh. Check live evidence and
    // arriving controls again, immediately before the synchronous send boundary.
    if (snapshot.operation?.id !== operation.id || !this.gate(operation)) return this.cancelUnsent(operation);
    if (operation.owner === 'queue' && !this.game.consumeSelectionOpportunity(operation.opportunityId)) return this.cancelUnsent(operation);
    this.publish(snapshot);
    this.selection.dispatch(operation);
  }

  async cancelUnsent(operation) {
    const snapshot = await this.store.transition(s => {
      if (s.operation?.id !== operation.id) return;
      s.operation = null;
      if (s.session?.id === operation.sessionId && s.session.lockedEntryId === operation.entryId) s.session.lockedEntryId = null;
      this.complete(s);
    });
    this.publish(snapshot);
  }

  manualPick(shortname) {
    // Wait for transport/result outside the controller queue.
    let resolve, reject, reservedId;
    const returned = new Promise((a, b) => { resolve = a; reject = b; });
    this.enqueue(async () => {
      const snapshot = await this.store.read();
      if (this.closed || this.inhibited || active(snapshot.session) || snapshot.operation) {
        this.conflict('SELECTION_CONFLICT', 'Queue ownership or an unresolved console request blocks manual Pick.', snapshot);
      }
      if (typeof shortname !== 'string' || !shortname.length || shortname.length > 1000) throw new QueueStoreError('INVALID_COMMAND', 'Provide a song shortname.');
      const operation = this.selection.reservation({ owner: 'manual', shortname, generation: this.generation });
      await this.store.transition(s => { s.operation = operation; });
      reservedId = operation.id;
      this.manualWaiters.set(operation.id, { resolve, reject });
      await this.sendReserved(operation);
      const latest = await this.store.read();
      if (!latest.operation && this.manualWaiters.has(operation.id)) {
        this.manualWaiters.delete(operation.id); this.conflict('SELECTION_CANCELLED', 'Selection cancelled before send.', latest);
      }
    }).catch(error => {
      if (reservedId) {
        this.manualWaiters.delete(reservedId);
        if (error.code !== 'SELECTION_CANCELLED') this.inhibit(error);
      }
      reject(error);
    });
    return returned;
  }

  reconcileOperation(id, result) {
    return this.enqueue(async () => {
      if (this.closed) return;
      this.pendingResults.set(id, result);
      try {
        const snapshot = await this.store.read();
        if (snapshot.operation?.id !== id) { this.pendingResults.delete(id); return; }
        let count;
        const saved = await this.store.transition(async (s, db) => {
          const operation = s.operation;
          if (result.ok) {
            await db.promisifyRun(`INSERT INTO picks (shortname, count) VALUES (?, 1)
              ON CONFLICT(shortname) DO UPDATE SET count = count + 1`, [operation.shortname]);
            count = (await db.promisifyGet('SELECT count FROM picks WHERE shortname = ?', [operation.shortname])).count;
          }
          if (result.ok || result.returned) s.operation = null;
          else { operation.status = 'unknown'; operation.error = result.message; }
          // An old result reconciles its global reservation, never newer progress.
          if (!result.ok && active(s.session) && s.session.id === operation.sessionId) {
            s.session.status = 'paused'; s.session.pauseReason = `Selection outcome unknown: ${result.message}`;
            // Transport uncertainty is independent of a coherent observed
            // attempt. Keep tracking it; only an unstarted locked request needs
            // explicit Skip rather than ordinary Resume after reconciliation.
            if (s.session.lockedEntryId === operation.entryId && !s.session.currentAttempt) s.session.selectionUncertain = true;
          }
          this.complete(s);
        });
        this.pendingResults.delete(id);
        const waiter = this.manualWaiters.get(id);
        this.manualWaiters.delete(id);
        if (result.ok) waiter?.resolve({ shortname: snapshot.operation.shortname, count });
        else waiter?.reject(new Error(result.message));
        this.publish(saved);
        await this.pump();
      } catch (error) {
        this.inhibit(error);
        this.manualWaiters.get(id)?.reject(error); this.manualWaiters.delete(id);
      }
    });
  }

  async reconcileStorage() {
    if (!this.inhibited) return;
    // Only known results are replayed; dispatch is inhibited throughout recovery.
    for (const [id, result] of this.pendingResults) await this.reconcileOperation(id, result);
    if (this.pendingResults.size) return;
    await this.enqueue(async () => {
      try {
        await this.drainLifecycle();
        const snapshot = await this.store.read();
        if (active(snapshot.session) || snapshot.operation?.status === 'reserved') {
          const saved = await this.store.transition(s => {
            if (s.operation?.status === 'reserved') {
              if (s.session?.id === s.operation.sessionId && s.session.lockedEntryId === s.operation.entryId) s.session.lockedEntryId = null;
              s.operation = null;
            }
            if (active(s.session)) {
              s.session.status = 'paused'; s.session.pauseReason = 'Storage recovered; explicit Resume required';
              if (s.session.lockedEntryId || s.session.currentAttempt || this.lifecycleOverflow) s.session.selectionUncertain = true;
            }
          });
          this.publish(saved);
        }
        this.lifecycleOverflow = false;
        this.inhibited = false; this.storageError = null;
        this.resetEvidence('storage-recovered');
        this.emit('diagnostics', this.diagnostics());
      } catch (error) { this.inhibit(error); }
    });
  }

  async close() {
    this.closed = true; this.generation++;
    this.game.off('transition', this.onTransition);
    await this.idle();
    for (const waiter of this.manualWaiters.values()) waiter.reject(new Error('Queue controller closed; console outcome unresolved'));
    this.manualWaiters.clear();
  }
}

module.exports = QueueController;
