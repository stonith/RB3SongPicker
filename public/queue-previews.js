(function (root) {
  function queuePreviewSongs(snapshot) {
    const session = snapshot?.session;
    if (!session) return [];
    const current = session.entries.find(entry => entry.id === session.currentAttempt?.entryId || entry.id === session.lockedEntryId)
      || (session.currentAttempt ? { shortname: session.currentAttempt.shortname, title: session.currentAttempt.shortname } : null);
    return [...new Map([current, ...session.entries.filter(entry => entry.status === 'pending')]
      .filter(song => song?.shortname).map(song => [song.shortname, song])).values()];
  }

  // Browser-local preview metadata, never persisted in the shared queue. The
  // lookup endpoint only reads existing matches; it never searches the provider.
  class QueuePreviewCache {
    constructor({ fetch = root.fetch.bind(root), now = Date.now, onChange = () => {}, ttlMs = 10000 } = {}) {
      this.fetch = fetch; this.now = now; this.onChange = onChange; this.ttlMs = ttlMs;
      this.cache = new Map(); this.enabled = false; this.country = null; this.generation = 0;
      this.songs = []; this.inflight = null;
    }
    configure({ enabled, country }) {
      if (this.enabled === enabled && this.country === country) return;
      this.enabled = enabled; this.country = country; this.generation++;
      this.cache.clear(); this.onChange();
    }
    get(shortname) { return this.cache.get(shortname)?.preview; }
    refresh(songs) {
      this.songs = songs;
      if (!this.enabled) return Promise.resolve();
      if (this.inflight) return this.loadingGeneration === this.generation ? this.inflight
        : this.inflight.catch(() => {}).then(() => this.refresh(this.songs));
      const generation = this.generation;
      this.loadingGeneration = generation;
      this.inflight = this.load(generation).finally(() => { this.inflight = null; });
      return this.inflight;
    }
    async load(generation) {
      const lookedUp = new Set();
      while (this.enabled && generation === this.generation) {
        const names = [...new Set(this.songs.map(song => song.shortname))].filter(name => {
          const item = this.cache.get(name);
          return !lookedUp.has(name) && (!item || this.now() - item.checkedAt >= this.ttlMs);
        }).slice(0, 200);
        if (!names.length) return;
        for (const name of names) lookedUp.add(name);
        const response = await this.fetch('/api/previews/lookup', { method: 'POST',
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ shortnames: names }) });
        if (!response.ok) throw new Error('Queue preview lookup unavailable');
        const data = await response.json();
        if (!this.enabled || generation !== this.generation) return;
        const previews = new Map(data.songs.map(song => [song.shortname, song.preview]));
        for (const name of names) this.cache.set(name, { preview: previews.get(name) || { status: 'unavailable' }, checkedAt: this.now() });
        // Bound memory to the session's current/pending songs, including repeats.
        const wanted = new Set(this.songs.map(song => song.shortname));
        for (const name of this.cache.keys()) if (!wanted.has(name)) this.cache.delete(name);
        this.onChange();
      }
    }
  }
  const api = { QueuePreviewCache, queuePreviewSongs };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.QueuePreviews = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
