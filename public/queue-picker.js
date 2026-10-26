(function (root) {
  class PickerModel {
    constructor({ client, fetch = root.fetch.bind(root), onChange = () => {} }) {
      this.client = client;
      this.fetch = fetch;
      this.onChange = onChange;
      this.filters = { search: '', listId: '' };
      this.songs = [];
      this.requestId = 0;
      this.loading = false;
      this.loadError = '';
      this.feedback = '';
    }

    async load(filters = this.filters) {
      this.filters = { ...filters };
      const requestId = ++this.requestId;
      this.loading = true;
      this.loadError = '';
      this.onChange();
      const params = new URLSearchParams({ sort: 'title', order: 'asc' });
      if (filters.search) params.set('search', filters.search);
      if (filters.listId) params.set('listId', filters.listId);
      try {
        const response = await this.fetch(`/api/songs?${params}`);
        if (!response.ok) throw new Error('Cannot load songs. Change the search or list to retry.');
        const data = await response.json();
        if (requestId !== this.requestId) return;
        this.songs = data.songs || [];
      } catch (error) {
        if (requestId === this.requestId) { this.loadError = error.message; this.songs = []; }
      } finally {
        if (requestId === this.requestId) { this.loading = false; this.onChange(); }
      }
    }

    rowState(shortname) {
      const pending = this.client.pendingCommand;
      if (pending?.type === 'add' && pending.shortname === shortname) {
        return { label: this.client.busy ? 'Adding…' : 'Result unknown — Retry', retry: !this.client.busy,
          disabled: this.client.busy || !this.client.synchronized };
      }
      const active = ['running', 'paused'].includes(this.client.snapshot?.session?.status);
      return { label: 'Add', retry: false, disabled: !active || !this.client.canCommand };
    }

    async add(song) {
      if (this.rowState(song.shortname).disabled) return;
      return this.apply(song, false);
    }

    async retry() {
      if (this.client.pendingCommand?.type !== 'add') return;
      const shortname = this.client.pendingCommand.shortname;
      return this.apply(this.songs.find(song => song.shortname === shortname) || { shortname, title: shortname }, true);
    }

    async apply(song, retry) {
      this.feedback = `Adding ${song.title || song.shortname}…`;
      this.onChange();
      try {
        await (retry ? this.client.retry() : this.client.command('add', { shortname: song.shortname }));
        this.feedback = `Added ${song.title || song.shortname}. Add again for an intentional repeat.`;
      } catch (error) {
        this.feedback = error.unknown ? 'Result unknown — Retry uses the original Add identity, not a new entry.'
          : `Add not applied: ${error.message} Review the shared queue before trying again.`;
      }
      this.onChange();
    }
  }
  const api = { PickerModel };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.QueuePicker = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
