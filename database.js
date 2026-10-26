const sqlite3 = require('sqlite3').verbose();
const { AsyncLocalStorage } = require('node:async_hooks');

class Database {
  constructor(dbPath) {
    this.db = new sqlite3.Database(dbPath);
    this.context = new AsyncLocalStorage();
    this.tail = Promise.resolve();
    this.ready = this.initializeSchema();
  }

  async initializeSchema() {
    await this.rawRun('PRAGMA journal_mode = WAL');
    await this.rawRun('PRAGMA foreign_keys = ON');
    await this.rawRun(`CREATE TABLE IF NOT EXISTS songs (
      shortname TEXT PRIMARY KEY, title TEXT, artist TEXT, album TEXT, origin TEXT,
      updated_at TEXT, present INTEGER NOT NULL DEFAULT 1
    )`);
    const columns = await this.rawAll('PRAGMA table_info(songs)');
    if (!columns.some(column => column.name === 'present')) {
      await this.rawRun('ALTER TABLE songs ADD COLUMN present INTEGER NOT NULL DEFAULT 1');
    }
    await this.rawRun(`CREATE TABLE IF NOT EXISTS picks (
      shortname TEXT PRIMARY KEY, count INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY(shortname) REFERENCES songs(shortname) ON DELETE CASCADE
    )`);
    await this.rawRun(`CREATE TABLE IF NOT EXISTS songlists (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE,
      created_at TEXT, updated_at TEXT
    )`);
    await this.rawRun(`CREATE TABLE IF NOT EXISTS songlist_items (
      list_id INTEGER NOT NULL, shortname TEXT NOT NULL, PRIMARY KEY(list_id, shortname),
      FOREIGN KEY(list_id) REFERENCES songlists(id) ON DELETE CASCADE,
      FOREIGN KEY(shortname) REFERENCES songs(shortname) ON DELETE CASCADE
    )`);
    await this.rawRun('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)');
    // Queue snapshots deliberately have no saved-list/song foreign keys: source
    // deletion and library refresh must not erase a live session or reservation.
    await this.rawRun(`CREATE TABLE IF NOT EXISTS queue_snapshot (
      id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL,
      session_json TEXT, operation_json TEXT
    )`);
    await this.rawRun('INSERT OR IGNORE INTO queue_snapshot (id, version) VALUES (1, 0)');
    await this.rawRun(`CREATE TABLE IF NOT EXISTS queue_command_receipts (
      command_id TEXT PRIMARY KEY, request_json TEXT NOT NULL,
      response_json TEXT NOT NULL, created_at INTEGER NOT NULL
    )`);
    await this.rawRun('CREATE INDEX IF NOT EXISTS queue_receipts_created ON queue_command_receipts(created_at)');
  }

  // All connection access shares this queue. Calls inside a transaction inherit its
  // context; unrelated HTTP requests/worker writes cannot accidentally join it.
  async exclusive(work) {
    await this.ready;
    if (this.context.getStore()?.active) return work();
    const result = this.tail.then(() => this.context.run({ active: true }, async () => {
      const scope = this.context.getStore();
      try { return await work(); } finally { scope.active = false; }
    }));
    this.tail = result.catch(() => {});
    return result;
  }

  transaction(work) {
    return this.exclusive(async () => {
      await this.rawRun('BEGIN IMMEDIATE');
      try {
        const result = await work();
        await this.rawRun('COMMIT');
        return result;
      } catch (error) {
        await this.rawRun('ROLLBACK');
        throw error;
      }
    });
  }

  rawRun(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.run(sql, params, function (err) {
        if (err) return reject(err);
        resolve(this);
      });
    });
  }

  rawGet(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.get(sql, params, (err, row) => err ? reject(err) : resolve(row));
    });
  }

  rawAll(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows));
    });
  }

  promisifyRun(sql, params = []) { return this.exclusive(() => this.rawRun(sql, params)); }
  promisifyGet(sql, params = []) { return this.exclusive(() => this.rawGet(sql, params)); }
  promisifyAll(sql, params = []) { return this.exclusive(() => this.rawAll(sql, params)); }

  async getSetting(key, defaultValue = null) {
    const row = await this.promisifyGet('SELECT value FROM settings WHERE key = ?', [key]);
    return row ? row.value : defaultValue;
  }

  setSetting(key, value) {
    return this.promisifyRun(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      [key, value]
    );
  }

  async close() {
    await this.exclusive(() => new Promise((resolve, reject) => {
      this.db.close(error => error ? reject(error) : resolve());
    }));
  }
}

module.exports = Database;
