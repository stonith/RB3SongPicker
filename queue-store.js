const { randomUUID } = require('node:crypto');
const { songOrderBy } = require('./song-query');

const ACTIVE = new Set(['running', 'paused']);
const STATUSES = new Set(['running', 'paused', 'completed', 'stopped']);
const ENTRY_STATUSES = new Set(['pending', 'handled', 'skipped']);
const MAX_REQUEST_BYTES = 1024 * 1024;

class QueueStoreError extends Error {
  constructor(code, message, snapshot) {
    super(message);
    this.code = code;
    this.status = ['STALE_VERSION', 'STALE_SESSION', 'COMMAND_MISMATCH', 'SESSION_ACTIVE',
      'SESSION_TERMINAL', 'ENTRY_LOCKED', 'INVALID_ORDER'].includes(code) ? 409 : 400;
    if (snapshot) this.snapshot = snapshot;
  }
}
const fail = (code, message, snapshot) => { throw new QueueStoreError(code, message, snapshot); };
const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 200;
const shortnameValid = value => typeof value === 'string' && value.length > 0 && value.length <= 1000;

function canonical(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(canonical);
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  }
  fail('INVALID_COMMAND', 'Commands must contain only JSON values.');
}

class QueueStore {
  constructor(db, { maxEntries = 5000, maxReceipts = 1000, receiptTtlMs = 24 * 60 * 60 * 1000,
    now = Date.now } = {}) {
    if (![maxEntries, maxReceipts, receiptTtlMs].every(n => Number.isSafeInteger(n) && n > 0)) {
      throw new TypeError('Queue limits must be positive safe integers.');
    }
    this.db = db;
    this.maxEntries = maxEntries;
    this.maxReceipts = maxReceipts;
    this.receiptTtlMs = receiptTtlMs;
    this.now = now;
  }

  // Call once during application startup, before exposing controls. Evidence is
  // runtime-only; a durable operation/attempt is preserved for controller recovery.
  async initialize() {
    await this.db.ready;
    return this.db.transaction(async () => {
      const snapshot = await this.read();
      if (snapshot.session && ACTIVE.has(snapshot.session.status)) {
        const previous = structuredClone(snapshot);
        snapshot.session.status = 'paused';
        snapshot.session.pauseReason = 'restart, console state unknown';
        await this.save(snapshot, previous);
      }
      await this.pruneReceipts();
      return snapshot;
    });
  }

  async read() {
    const row = await this.db.promisifyGet('SELECT version, session_json, operation_json FROM queue_snapshot WHERE id = 1');
    return { version: row.version, session: row.session_json ? JSON.parse(row.session_json) : null,
      operation: row.operation_json ? JSON.parse(row.operation_json) : null };
  }

  // Returns a full-membership seed, never browser search/duplicate-filter results.
  // start() calls this inside its acceptance transaction; standalone use is read-only.
  seed({ listId, sort = 'title', order = 'asc' }) {
    return this.db.exclusive(async () => {
      if (!Number.isSafeInteger(listId) || listId <= 0) fail('INVALID_LIST', 'Choose a saved Song List.');
      const ordering = songOrderBy(sort, order, { strict: true });
      const list = await this.db.promisifyGet('SELECT id, name FROM songlists WHERE id = ?', [listId]);
      if (!list) fail('LIST_NOT_FOUND', 'Song List not found.');
      const rows = await this.db.promisifyAll(`SELECT s.shortname, s.title, s.artist, s.album, s.origin
        FROM songs s JOIN songlist_items li ON li.shortname = s.shortname
        LEFT JOIN picks p ON p.shortname = s.shortname
        WHERE li.list_id = ? AND s.present = 1 ORDER BY ${ordering}`, [listId]);
      if (!rows.length) fail('EMPTY_LIST', 'The Song List has no available songs.');
      if (rows.length > this.maxEntries) fail('QUEUE_LIMIT', `Queue supports at most ${this.maxEntries} entries.`);
      const excluded = await this.db.promisifyAll(`SELECT s.shortname FROM songs s
        JOIN songlist_items li ON li.shortname = s.shortname
        WHERE li.list_id = ? AND s.present != 1 ORDER BY s.shortname ASC`, [listId]);
      return { sourceList: list, entries: rows.map(row => this.entry(row)), excludedShortnames: excluded.map(row => row.shortname) };
    });
  }

  entry(song) {
    return { id: randomUUID(), shortname: song.shortname, title: song.title ?? null,
      artist: song.artist ?? null, album: song.album ?? null, origin: song.origin ?? null, status: 'pending' };
  }

  normalizeCommand(command, type, fields = []) {
    if (!command || typeof command !== 'object' || Array.isArray(command)) fail('INVALID_COMMAND', 'Provide a queue command.');
    const allowed = ['commandId', 'type', 'expectedVersion', 'sessionId', ...fields];
    if (type && (command.type !== type || Object.keys(command).some(key => !allowed.includes(key)))) {
      fail('INVALID_COMMAND', `Invalid ${type} command fields.`);
    }
    let normalized, json;
    try { normalized = canonical(command); json = JSON.stringify(normalized); }
    catch (error) {
      if (error instanceof QueueStoreError) throw error;
      fail('INVALID_COMMAND', 'Provide a bounded JSON command.');
    }
    if (Buffer.byteLength(json) > MAX_REQUEST_BYTES || !validId(normalized.commandId) || !validId(normalized.type)
        || !Number.isSafeInteger(normalized.expectedVersion) || normalized.expectedVersion < 0
        || !(normalized.sessionId === null || validId(normalized.sessionId))) {
      fail('INVALID_COMMAND', 'Provide a command ID, type, singleton expectedVersion and target sessionId within size limits.');
    }
    return normalized;
  }

  async start(command, initializeSession = () => {}) {
    const normalized = this.normalizeCommand(command, 'start', ['listId', 'sort', 'order']);
    normalized.sort = String(normalized.sort ?? 'title').toLowerCase();
    normalized.order = String(normalized.order ?? 'asc').toLowerCase();
    return this.execute(normalized, async snapshot => {
      if (snapshot.session && ACTIVE.has(snapshot.session.status)) fail('SESSION_ACTIVE', 'Stop the current queue before starting another.', snapshot);
      const seed = await this.seed(normalized);
      snapshot.session = { id: randomUUID(), revision: 0, ...seed, status: 'running', pauseReason: null,
        lockedEntryId: null, currentAttempt: null };
      initializeSession(snapshot.session);
      // A new session does not clear an old console-operation reservation.
    });
  }

  async add(command) {
    const normalized = this.normalizeCommand(command, 'add', ['shortname']);
    return this.execute(normalized, async snapshot => {
      const session = this.editable(snapshot);
      if (!shortnameValid(normalized.shortname)) fail('INVALID_COMMAND', 'Provide a song shortname of 1–1000 characters.', snapshot);
      if (session.entries.length >= this.maxEntries) fail('QUEUE_LIMIT', `Queue supports at most ${this.maxEntries} entries.`, snapshot);
      const song = await this.db.promisifyGet('SELECT shortname, title, artist, album, origin FROM songs WHERE shortname = ? AND present = 1', [normalized.shortname]);
      if (!song) fail('SONG_UNAVAILABLE', 'The song is not currently available.', snapshot);
      session.entries.push(this.entry(song));
    });
  }

  async remove(command) {
    const normalized = this.normalizeCommand(command, 'remove', ['entryId']);
    return this.execute(normalized, snapshot => {
      const session = this.editable(snapshot);
      const entry = session.entries.find(e => e.id === normalized.entryId);
      if (!entry) fail('ENTRY_NOT_FOUND', 'Queue entry not found.', snapshot);
      if (!this.isUpcoming(session, entry)) fail('ENTRY_LOCKED', 'Only upcoming entries can be removed.', snapshot);
      session.entries = session.entries.filter(e => e.id !== entry.id);
    });
  }

  // entryIds is the complete displayed entry order. Non-upcoming entries must
  // remain in their original slots; missing/extra/duplicate IDs reject atomically.
  async reorder(command) {
    const normalized = this.normalizeCommand(command, 'reorder', ['entryIds']);
    return this.execute(normalized, snapshot => {
      const session = this.editable(snapshot);
      const ids = normalized.entryIds;
      const byId = new Map(session.entries.map(entry => [entry.id, entry]));
      if (!Array.isArray(ids) || ids.length !== byId.size || new Set(ids).size !== ids.length
          || ids.some(id => !byId.has(id))
          || session.entries.some((entry, index) => !this.isUpcoming(session, entry) && ids[index] !== entry.id)) {
        fail('INVALID_ORDER', 'Provide every entry ID once and keep locked/handled entries in place.', snapshot);
      }
      session.entries = ids.map(id => byId.get(id));
    });
  }

  isUpcoming(session, entry) {
    return entry.status === 'pending' && entry.id !== session.lockedEntryId && entry.id !== session.currentAttempt?.entryId;
  }

  editable(snapshot) {
    if (!snapshot.session || !ACTIVE.has(snapshot.session.status)) fail('SESSION_TERMINAL', 'Only an active queue can be edited.', snapshot);
    return snapshot.session;
  }

  // Controller seam: revisioned/idempotent acceptance, including DB writes in the
  // callback, commits with one snapshot and receipt. No external effects here.
  async execute(command, update) {
    const normalized = this.normalizeCommand(command);
    const requestJson = JSON.stringify(canonical(normalized));
    return this.db.transaction(async () => {
      await this.pruneReceipts();
      const receipt = await this.db.promisifyGet('SELECT request_json, response_json FROM queue_command_receipts WHERE command_id = ?', [normalized.commandId]);
      if (receipt) {
        if (receipt.request_json !== requestJson) fail('COMMAND_MISMATCH', 'Command ID was already used for a different request.', await this.read());
        return JSON.parse(receipt.response_json);
      }
      const previous = await this.read();
      if (previous.version !== normalized.expectedVersion) fail('STALE_VERSION', 'Queue changed; refresh before editing.', previous);
      if ((previous.session?.id || null) !== normalized.sessionId) fail('STALE_SESSION', 'The target session is no longer current.', previous);
      const snapshot = structuredClone(previous);
      await update(snapshot, this.db);
      await this.save(snapshot, previous);
      await this.db.promisifyRun(`INSERT INTO queue_command_receipts (command_id, request_json, response_json, created_at)
        VALUES (?, ?, ?, ?)`, [normalized.commandId, requestJson, JSON.stringify(snapshot), this.now()]);
      await this.pruneReceipts();
      return snapshot;
    });
  }

  // Uncommanded controller events share the same transaction/monotonic version.
  // Operation result + once-only pick-count changes can commit in this callback.
  transition(update) {
    return this.db.transaction(async () => {
      const previous = await this.read();
      const snapshot = structuredClone(previous);
      await update(snapshot, this.db);
      await this.save(snapshot, previous);
      return snapshot;
    });
  }

  async save(snapshot, previous) {
    const session = snapshot.session;
    if (session) {
      if (!validId(session.id) || !STATUSES.has(session.status) || !Array.isArray(session.entries)) {
        fail('INVALID_SNAPSHOT', 'Invalid queue session.');
      }
      if (session.entries.length > this.maxEntries) fail('QUEUE_LIMIT', `Queue supports at most ${this.maxEntries} entries.`);
      const ids = new Set();
      for (const entry of session.entries) {
        if (!validId(entry.id) || ids.has(entry.id) || !shortnameValid(entry.shortname) || !ENTRY_STATUSES.has(entry.status)
            || ['title', 'artist', 'album', 'origin'].some(key => entry[key] !== null && (typeof entry[key] !== 'string' || entry[key].length > 1000))) {
          fail('INVALID_SNAPSHOT', 'Invalid entry identity, disposition or metadata size.');
        }
        ids.add(entry.id);
      }
      if (session.lockedEntryId !== null && !ids.has(session.lockedEntryId)) fail('INVALID_SNAPSHOT', 'Locked entry must exist in the session.');
      session.revision = previous.session?.id === session.id ? previous.session.revision + 1 : 1;
    }
    snapshot.version = previous.version + 1;
    if (!Number.isSafeInteger(snapshot.version)) fail('VERSION_LIMIT', 'Queue snapshot version exhausted.');
    await this.db.promisifyRun('UPDATE queue_snapshot SET version = ?, session_json = ?, operation_json = ? WHERE id = 1',
      [snapshot.version, session ? JSON.stringify(session) : null, snapshot.operation ? JSON.stringify(snapshot.operation) : null]);
  }

  async pruneReceipts() {
    await this.db.promisifyRun('DELETE FROM queue_command_receipts WHERE created_at <= ?', [this.now() - this.receiptTtlMs]);
    await this.db.promisifyRun(`DELETE FROM queue_command_receipts WHERE command_id IN (
      SELECT command_id FROM queue_command_receipts ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET ?
    )`, [this.maxReceipts]);
  }
}

module.exports = QueueStore;
module.exports.QueueStoreError = QueueStoreError;
