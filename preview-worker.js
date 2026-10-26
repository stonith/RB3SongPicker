const { matchPreview } = require('./preview-matcher');
const { fingerprint } = require('./preview-store');

const REQUEST_INTERVAL = 3500;

class PreviewWorker {
  constructor(store, provider, { now = Date.now, random = Math.random, logger = console } = {}) {
    this.store = store;
    this.provider = provider;
    this.now = now;
    this.random = random;
    this.logger = logger;
    this.reconcileNeeded = true;
    this.recoveryNeeded = false;
    this.nextReconcileAt = 0;
    this.running = false;
    this.inFlight = null;
  }

  requestReconcile() { this.reconcileNeeded = true; }

  start() {
    if (this.running) return;
    this.running = true;
    const tick = async () => {
      try { await this.runOnce(); } catch (error) { this.logger.error('Preview worker:', error); }
      if (this.running) this.timer = setTimeout(tick, 500);
    };
    this.timer = setTimeout(tick, 0);
  }

  async stop() {
    this.running = false;
    clearTimeout(this.timer);
    await this.inFlight;
  }

  runOnce() {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.processOne().catch(async error => {
      this.reconcileNeeded = true;
      // A transient database/completion failure must not strand a processing job
      // until restart. Recovery is safe because this process has only one worker.
      this.recoveryNeeded = true;
      try {
        await this.store.recoverInterrupted();
        this.recoveryNeeded = false;
      } catch { /* Retry recovery next tick/startup. */ }
      throw error;
    }).finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  async processOne() {
    if (this.recoveryNeeded) {
      await this.store.recoverInterrupted();
      this.recoveryNeeded = false;
    }
    const config = await this.store.config();
    if (!config.enabled) return;
    if (this.reconcileNeeded || this.now() >= this.nextReconcileAt) {
      this.reconcileNeeded = false;
      try { await this.store.reconcile(config.country, this.now()); }
      catch (error) { this.reconcileNeeded = true; throw error; }
      this.nextReconcileAt = this.now() + 3600000;
    }
    const job = await this.store.nextJob(config.country, this.now());
    if (!job) return;
    if (fingerprint(job) !== job.fingerprint) {
      this.requestReconcile();
      return;
    }
    // Incomplete metadata cannot produce a safe match and needs no Apple call.
    if (!job.title?.trim() || !job.artist?.trim()) {
      await this.store.complete(job, { status: 'unavailable' }, this.now());
      return;
    }
    let candidates = await this.store.cachedSearch(job.search_key, this.now());
    if (candidates === null) {
      const timing = await this.store.timing();
      if (this.now() < Math.max(timing.next_request_at, timing.cooldown_until)) return;
      // Persist budget consumption before the network call, even if it fails or
      // the process dies. Restart must not refill the provider's rate budget.
      await this.store.reserveRequest(this.now() + REQUEST_INTERVAL);
      const latest = await this.store.config();
      if (!latest.enabled || latest.country !== config.country) return;
      await this.store.markProcessing(job);
      try {
        const startedAt = this.now();
        candidates = await this.provider.search(job, config.country);
        await this.store.reserveRequest(Math.max(startedAt + REQUEST_INTERVAL, (await this.store.timing()).next_request_at));
        await this.store.cacheSearch(job.search_key, candidates, this.now());
      } catch (error) {
        const backoff = Math.min(3600000, 30000 * 2 ** Math.min(job.attempts, 7));
        const delay = Math.max(error.retryAfterMs || 0, error.status === 429 ? 60000 : 0,
          backoff + Math.floor(this.random() * 5000));
        // Provider/network errors cool down the entire worker, not just this job.
        await this.store.cooldown(this.now() + delay);
        await this.store.retry(job, this.now(), delay, error);
        return;
      }
    }
    const latest = await this.store.config();
    if (latest.country !== config.country || !latest.enabled) {
      await this.store.retry(job, this.now(), 0, new Error('Preview configuration changed'));
      return;
    }
    await this.store.complete(job, matchPreview(job, candidates), this.now());
  }
}

module.exports = PreviewWorker;
module.exports.REQUEST_INTERVAL = REQUEST_INTERVAL;
