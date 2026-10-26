(function (root) {
  const validSnapshot = value => value && Number.isSafeInteger(value.version) && value.version >= 0
    && (value.session === null || (value.session && typeof value.session.id === 'string'
      && Array.isArray(value.session.entries))) && Object.hasOwn(value, 'operation');

  // LAN HTTP is not a secure context, so randomUUID may be absent. Web Crypto's
  // getRandomValues remains available and keeps command identities collision-safe.
  function newCommandId() {
    if (root.crypto.randomUUID) return root.crypto.randomUUID();
    return Array.from(root.crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
  }

  class QueueClient {
    constructor({ fetch = root.fetch.bind(root), EventSource = root.EventSource,
      commandId = newCommandId, onChange = () => {} } = {}) {
      this.fetch = fetch;
      this.EventSource = EventSource;
      this.commandId = commandId;
      this.onChange = onChange;
      this.snapshot = null;
      this.diagnostics = {};
      this.synchronized = false;
      this.busy = false;
      this.pendingCommand = null;
      this.closed = false;
    }

    get canCommand() { return this.synchronized && !this.busy && !this.pendingCommand && !this.closed; }
    notify() { if (!this.closed) this.onChange(this); }

    accept(snapshot) {
      if (this.closed || !validSnapshot(snapshot)) return false;
      if (this.snapshot && snapshot.version < this.snapshot.version) return false;
      if (!this.snapshot || snapshot.version > this.snapshot.version) this.snapshot = snapshot;
      return true;
    }

    async connect() {
      if (this.source || this.closed) return;
      try {
        this.source = new this.EventSource('/api/queue/events');
        this.source.addEventListener('snapshot', event => {
          try {
            const snapshot = JSON.parse(event.data);
            if (!validSnapshot(snapshot)) this.synchronized = false;
            else if (this.accept(snapshot)) this.synchronized = true;
          } catch { this.synchronized = false; }
          this.notify();
        });
        this.source.addEventListener('diagnostics', event => {
          try { this.diagnostics = JSON.parse(event.data); } catch { /* Wait for the next diagnostics frame. */ }
          this.notify();
        });
        this.source.addEventListener('error', () => { this.synchronized = false; this.notify(); });
      } catch { this.synchronized = false; }
      try {
        const response = await this.fetch('/api/queue');
        if (!response.ok) throw new Error('Queue unavailable');
        this.accept(await response.json());
      } catch { /* Browsing stays usable; native SSE reconnect supplies current state. */ }
      this.notify();
    }

    async command(type, fields = {}) {
      if (this.pendingCommand) throw new Error('Result unknown — Retry the original action first.');
      if (!this.canCommand) throw new Error('Queue synchronization is unavailable; wait for shared state.');
      const command = JSON.parse(JSON.stringify({ ...fields, commandId: this.commandId(), type,
        expectedVersion: this.snapshot.version, sessionId: this.snapshot.session?.id || null }));
      this.pendingCommand = Object.freeze(command);
      return this.sendPending();
    }

    async retry() {
      if (!this.pendingCommand || this.busy || !this.synchronized || this.closed) throw new Error('Wait for queue synchronization before Retry.');
      return this.sendPending();
    }

    async sendPending() {
      this.busy = true;
      this.notify();
      try {
        const response = await this.fetch('/api/queue/commands', { method: 'POST',
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(this.pendingCommand) });
        const body = await response.json();
        if (this.closed) return body;
        if (!response.ok) {
          if (body.snapshot && !validSnapshot(body.snapshot)) throw new Error('Unreadable queue response');
          if (body.snapshot) this.accept(body.snapshot);
          const error = new Error(body.error || 'Queue action was not applied.');
          error.code = body.code;
          // A 5xx can occur after durable acceptance (for example while pumping
          // the next dispatch). Only definitive validation/conflict rejections
          // release this identity; retrying a possible acceptance must dedupe.
          error.unknown = response.status >= 500;
          if (!error.unknown) this.pendingCommand = null;
          throw error;
        }
        if (!validSnapshot(body)) throw new Error('Unreadable queue response');
        this.accept(body);
        this.pendingCommand = null;
        return body;
      } catch (error) {
        if (error.unknown !== false) error.unknown = true;
        throw error;
      } finally { this.busy = false; this.notify(); }
    }

    close() {
      this.closed = true;
      this.synchronized = false;
      this.source?.close();
    }
  }

  function startQueueDetails(list, eligibleCount) {
    if (!list) return { enabled: false, count: 0, text: 'Choose a saved Song List to start a queue. All songs is not a starting list.' };
    if (eligibleCount === null) return { enabled: false, count: 0, text: 'Checking full saved-list membership…' };
    if (!eligibleCount) return { enabled: false, count: 0, text: 'This saved list has no available songs.' };
    const excluded = Math.max(0, list.songCount - eligibleCount);
    return { enabled: true, count: eligibleCount,
      text: `Start with all ${eligibleCount} available songs in current sort order; search and duplicate filters are ignored.${excluded ? ` ${excluded} unavailable members excluded.` : ''} Session edits never change the saved list.` };
  }

  function describeQueue(snapshot, diagnostics = {}) {
    const session = snapshot?.session;
    const entries = session?.entries || [];
    const active = !!session && ['running', 'paused'].includes(session.status);
    const attempt = session?.currentAttempt;
    const current = attempt ? entries.find(entry => entry.id === attempt.entryId)
      || { shortname: attempt.shortname, title: attempt.shortname, artist: 'Unexpected gameplay' }
      : entries.find(entry => entry.id === session?.lockedEntryId) || null;
    const pending = entries.filter(entry => entry.status === 'pending');
    const quarantined = !!snapshot?.operation && snapshot.operation.status !== 'reserved';
    let label = 'No session queue';
    if (session?.status === 'completed') label = 'Queue complete';
    else if (session?.status === 'stopped') label = 'Queue stopped';
    else if (session?.status === 'paused') label = `Paused: ${session.pauseReason || 'Console state unknown'}`;
    else if (attempt) label = 'Playing';
    else if (current) label = 'Selection requested / awaiting start';
    else if (active) label = 'Waiting for song selection';
    const resumeBlocked = diagnostics.inhibited ? 'Resolve queue storage failure before Resume.'
      : snapshot?.operation ? 'An unresolved console request blocks Resume.'
        : session?.selectionUncertain || diagnostics.evidence?.uncertainty ? 'Unresolved gameplay evidence. Skip or Stop; Resume cannot resolve uncertainty.'
          : attempt && !attempt.expected ? 'Unexpected gameplay is still unresolved; wait for its end or Stop.' : '';
    const manualBlocked = diagnostics.inhibited ? 'Queue storage failure blocks console selection.'
      : snapshot?.operation ? 'An unresolved console request blocks Pick and Random.'
        : active ? 'Queue owns console selection, including while paused. Stop the queue to use Pick or Random.' : '';
    const warning = diagnostics.inhibited ? `Queue storage failure: ${diagnostics.storageError || 'dispatch inhibited'}. Console selections are disabled. Restore storage, then use Reconcile queue storage in Admin.`
      : quarantined ? 'An already-transmitted console request is unresolved. Stop cannot withdraw it. If its response cannot resolve it, actually restart the game/console, then confirm that restart in Admin.'
        : session?.selectionUncertain ? 'Selection or gameplay outcome is unknown. No automatic retry. Skip or Stop to resolve this entry; new song-selection evidence is required.' : '';
    return { active, label, current, locked: !!current, quarantined, resumeBlocked, manualBlocked, warning,
      upcoming: pending.filter(entry => entry.id !== session?.lockedEntryId && entry.id !== attempt?.entryId),
      progress: `${entries.filter(entry => entry.status === 'handled').length} handled attempt · ${pending.length} pending · ${entries.filter(entry => entry.status === 'skipped').length} skipped` };
  }

  // Reorder submits the full stored order; handled/current slots never move.
  function moveEntryOrder(snapshot, entryId, direction) {
    const model = describeQueue(snapshot);
    const index = model.upcoming.findIndex(entry => entry.id === entryId);
    if (!model.active || index < 0) throw new Error('Only upcoming entries can move.');
    const target = model.upcoming[index + direction];
    if (![1, -1].includes(direction) || !target) throw new Error('No upcoming position in that direction.');
    return snapshot.session.entries.map(entry => entry.id === entryId ? target.id : entry.id === target.id ? entryId : entry.id);
  }

  function recoveryOperationId(snapshot) {
    return snapshot?.operation && snapshot.operation.status !== 'reserved' ? snapshot.operation.id : null;
  }

  function describeDiagnostics(diagnostics = {}) {
    const listener = diagnostics.listener || {};
    const evidence = diagnostics.evidence || {};
    const time = value => value == null ? 'not yet observed' : new Date(value).toLocaleString();
    return `Events: ${listener.status || 'unknown'}${listener.error ? ` (${listener.error})` : ''}. `
      + `Bind: ${listener.bindAddress || 'unknown'}:${listener.port || 'unknown'}; configured source: ${listener.sourceAddress || 'unknown'}. `
      + `Last observed: ${time(listener.lastObservedAt ?? evidence.lastObservedAt)}. `
      + `Screen: ${evidence.screen?.name || 'unknown'}; last observed: ${time(evidence.screen?.receivedAt)}. `
      + `Evidence epoch: ${evidence.epoch ?? 'unknown'}.${evidence.uncertainty ? ` Uncertainty: ${evidence.uncertainty}.` : ''} Silence is not a heartbeat or a readiness check.`;
  }

  const exports = { QueueClient, describeQueue, startQueueDetails, moveEntryOrder, recoveryOperationId, describeDiagnostics };
  if (typeof module !== 'undefined' && module.exports) module.exports = exports;
  else root.SessionQueue = exports;
})(typeof globalThis !== 'undefined' ? globalThis : this);
