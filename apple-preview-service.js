class ApplePreviewService {
  constructor(fetchImpl = globalThis.fetch) { this.fetch = fetchImpl; }

  async search(song, country) {
    const url = new URL('https://itunes.apple.com/search');
    url.search = new URLSearchParams({ term: `${song.artist} ${song.title}`,
      media: 'music', entity: 'song', country, limit: '10' });
    const response = await this.fetch(url, { redirect: 'error', signal: AbortSignal.timeout(10000) });
    if (!response.ok) {
      const error = new Error(`Apple search returned HTTP ${response.status}`);
      error.status = response.status;
      const retry = response.headers.get('retry-after');
      error.retryAfterMs = retry && /^\d+(?:\.\d+)?$/.test(retry)
        ? Number(retry) * 1000 : Math.max(0, Date.parse(retry) - Date.now()) || 0;
      throw error;
    }
    const data = await response.json();
    if (!Array.isArray(data.results) || data.results.length > 200) throw new Error('Invalid Apple search response');
    return data.results.filter(row => row && row.kind === 'song').slice(0, 10).map(row => ({
      trackId: row.trackId, trackName: row.trackName, artistName: row.artistName,
      collectionName: row.collectionName, previewUrl: row.previewUrl, trackViewUrl: row.trackViewUrl
    }));
  }
}

module.exports = ApplePreviewService;
