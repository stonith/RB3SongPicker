const { createHash } = require('node:crypto');

const DAY = 86400000;
function normalize(value) {
  return String(value || '').normalize('NFD').replace(/\p{Diacritic}/gu, '')
    .toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}
function fingerprint(song) {
  return JSON.stringify([song.title, song.artist, song.album].map(normalize));
}
function searchKey(song, country) {
  return createHash('sha256').update(JSON.stringify([country, normalize(song.artist), normalize(song.title)])).digest('hex');
}

class PreviewStore {
  constructor(db) {
    this.db = db;
    this.negativeTtl = 30 * DAY;
  }

  async initialize() {
    await this.db.exclusive(async () => {
      await this.db.promisifyRun(`CREATE TABLE IF NOT EXISTS preview_config (
        id INTEGER PRIMARY KEY CHECK(id = 1), enabled INTEGER NOT NULL DEFAULT 0,
        country TEXT NOT NULL DEFAULT 'US', negative_days INTEGER NOT NULL DEFAULT 30
      )`);
      await this.db.promisifyRun('INSERT OR IGNORE INTO preview_config (id) VALUES (1)');
      await this.db.promisifyRun(`CREATE TABLE IF NOT EXISTS preview_state (
        id INTEGER PRIMARY KEY CHECK(id = 1), next_request_at INTEGER NOT NULL DEFAULT 0,
        cooldown_until INTEGER NOT NULL DEFAULT 0
      )`);
      await this.db.promisifyRun('INSERT OR IGNORE INTO preview_state (id) VALUES (1)');
      await this.db.promisifyRun(`CREATE TABLE IF NOT EXISTS preview_matches (
        shortname TEXT NOT NULL REFERENCES songs(shortname) ON DELETE CASCADE,
        country TEXT NOT NULL, fingerprint TEXT NOT NULL, search_key TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL DEFAULT 0, checked_at INTEGER,
        result TEXT, error TEXT, PRIMARY KEY(shortname, country)
      )`);
      await this.db.promisifyRun(`CREATE INDEX IF NOT EXISTS preview_jobs_due
        ON preview_matches(country, status, next_attempt_at, shortname)`);
      await this.db.promisifyRun(`CREATE TABLE IF NOT EXISTS preview_search_cache (
        search_key TEXT PRIMARY KEY, candidates TEXT NOT NULL, expires_at INTEGER NOT NULL
      )`);
      // One application process owns this queue. Interrupted HTTP requests are safe
      // to retry, but the durable provider pacing state is never reset on startup.
      await this.recoverInterrupted();
    });
  }

  recoverInterrupted() {
    return this.db.promisifyRun("UPDATE preview_matches SET status = 'retry' WHERE status = 'processing'");
  }

  async config() {
    const row = await this.db.promisifyGet('SELECT * FROM preview_config WHERE id = 1');
    this.negativeTtl = row.negative_days * DAY;
    return { enabled: Boolean(row.enabled), country: row.country, negativeDays: row.negative_days };
  }

  async configure({ enabled, country, negativeDays }) {
    await this.db.promisifyRun('UPDATE preview_config SET enabled = ?, country = ?, negative_days = ? WHERE id = 1',
      [enabled ? 1 : 0, country, negativeDays]);
    return this.config();
  }

  async reconcile(country, now = Date.now()) {
    await this.config();
    let cursor = null;
    for (;;) {
      const rows = await this.db.promisifyAll(`SELECT s.*, p.fingerprint AS preview_fingerprint,
        p.status AS preview_status, p.next_attempt_at AS preview_due
        FROM songs s LEFT JOIN preview_matches p ON p.shortname = s.shortname AND p.country = ?
        WHERE s.present = 1 AND (? IS NULL OR s.shortname > ?) ORDER BY s.shortname LIMIT 200`,
      [country, cursor, cursor]);
      if (!rows.length) break;
      await this.db.transaction(async () => {
        for (const song of rows) {
          const changed = song.preview_fingerprint !== fingerprint(song);
          const expired = ['unavailable', 'ambiguous'].includes(song.preview_status) && song.preview_due <= now;
          if (!changed && !expired) continue;
          await this.db.promisifyRun(`INSERT INTO preview_matches
            (shortname, country, fingerprint, search_key, next_attempt_at)
            VALUES (?, ?, ?, ?, ?) ON CONFLICT(shortname, country) DO UPDATE SET
            fingerprint = excluded.fingerprint, search_key = excluded.search_key,
            status = 'pending', attempts = 0, next_attempt_at = excluded.next_attempt_at, result = NULL, error = NULL`,
          [song.shortname, country, fingerprint(song), searchKey(song, country), now]);
        }
      });
      cursor = rows[rows.length - 1].shortname;
      // Yield between batches so refreshes and ordinary requests can use SQLite.
      await new Promise(resolve => setImmediate(resolve));
    }
  }

  nextJob(country, now) {
    return this.db.promisifyGet(`SELECT p.*, s.title, s.artist, s.album FROM preview_matches p
      JOIN songs s ON s.shortname = p.shortname WHERE p.country = ? AND s.present = 1
      AND p.status IN ('pending', 'retry') AND p.next_attempt_at <= ?
      ORDER BY p.next_attempt_at, p.shortname LIMIT 1`, [country, now]);
  }

  async markProcessing(job) {
    await this.db.promisifyRun(`UPDATE preview_matches SET status = 'processing'
      WHERE shortname = ? AND country = ? AND fingerprint = ?`, [job.shortname, job.country, job.fingerprint]);
  }

  async complete(job, result, now) {
    await this.db.transaction(async () => {
      const current = await this.db.promisifyGet('SELECT * FROM songs WHERE shortname = ?', [job.shortname]);
      const config = await this.config();
      if (!current || fingerprint(current) !== job.fingerprint || config.country !== job.country) {
        await this.db.promisifyRun(`UPDATE preview_matches SET status = 'pending'
          WHERE shortname = ? AND country = ? AND status = 'processing'`, [job.shortname, job.country]);
        return;
      }
      await this.db.promisifyRun(`UPDATE preview_matches SET status = ?, result = ?, checked_at = ?,
        next_attempt_at = ?, attempts = 0, error = NULL WHERE shortname = ? AND country = ? AND fingerprint = ?`,
      [result.status, JSON.stringify(result), now, result.status === 'matched' ? 0 : now + this.negativeTtl,
        job.shortname, job.country, job.fingerprint]);
    });
  }

  async retry(job, now, delay, error) {
    await this.db.promisifyRun(`UPDATE preview_matches SET status = 'retry', attempts = attempts + 1,
      next_attempt_at = ?, error = ? WHERE shortname = ? AND country = ? AND fingerprint = ?`,
    [now + delay, String(error.message).slice(0, 200), job.shortname, job.country, job.fingerprint]);
  }

  async cachedSearch(key, now) {
    const row = await this.db.promisifyGet('SELECT candidates FROM preview_search_cache WHERE search_key = ? AND expires_at > ?', [key, now]);
    return row ? JSON.parse(row.candidates) : null;
  }

  cacheSearch(key, candidates, now) {
    return this.db.promisifyRun(`INSERT INTO preview_search_cache VALUES (?, ?, ?)
      ON CONFLICT(search_key) DO UPDATE SET candidates = excluded.candidates, expires_at = excluded.expires_at`,
    [key, JSON.stringify(candidates), now + this.negativeTtl]);
  }

  timing() { return this.db.promisifyGet('SELECT * FROM preview_state WHERE id = 1'); }
  reserveRequest(next) { return this.db.promisifyRun('UPDATE preview_state SET next_request_at = ? WHERE id = 1', [next]); }
  cooldown(until) { return this.db.promisifyRun('UPDATE preview_state SET cooldown_until = MAX(cooldown_until, ?) WHERE id = 1', [until]); }

  async status(now = Date.now()) {
    const config = await this.config();
    const rows = await this.db.promisifyAll(`SELECT p.status, COUNT(*) AS count FROM preview_matches p
      JOIN songs s ON s.shortname = p.shortname WHERE s.present = 1 AND p.country = ? GROUP BY p.status`, [config.country]);
    const timing = await this.timing();
    return { ...config, counts: Object.fromEntries(rows.map(row => [row.status, row.count])),
      cooldownUntil: timing.cooldown_until > now ? timing.cooldown_until : null,
      requestsPerMinute: 17 };
  }

  async decorate(songs) {
    const config = await this.config();
    if (!config.enabled) return songs;
    const matches = new Map();
    for (let offset = 0; offset < songs.length; offset += 200) {
      const names = songs.slice(offset, offset + 200).map(song => song.shortname);
      const rows = await this.db.promisifyAll(`SELECT * FROM preview_matches WHERE country = ?
        AND shortname IN (${names.map(() => '?').join(',')})`, [config.country, ...names]);
      for (const row of rows) matches.set(row.shortname, row);
    }
    return songs.map(song => {
      const match = matches.get(song.shortname);
      const valid = match && match.fingerprint === fingerprint(song);
      return { ...song, preview: valid
        ? { status: match.status, ...(match.status === 'matched' ? JSON.parse(match.result) : {}) }
        : { status: 'pending' } };
    });
  }
}

module.exports = PreviewStore;
module.exports.normalize = normalize;
module.exports.fingerprint = fingerprint;
module.exports.searchKey = searchKey;
