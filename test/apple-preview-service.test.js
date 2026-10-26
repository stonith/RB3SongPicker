const ApplePreviewService = require('../apple-preview-service');

test('uses a bounded encoded search, explicit country and no redirects', async () => {
  const fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ results: [] }) });
  const service = new ApplePreviewService(fetch);
  expect(await service.search({ artist: 'AC/DC', title: 'Back & Black' }, 'GB')).toEqual([]);
  const [url, options] = fetch.mock.calls[0];
  expect(url.searchParams.get('term')).toBe('AC/DC Back & Black');
  expect(url.searchParams.get('country')).toBe('GB');
  expect(url.searchParams.get('limit')).toBe('10');
  expect(options.redirect).toBe('error');
});
test('propagates Retry-After and rejects malformed provider data', async () => {
  const service = new ApplePreviewService(jest.fn().mockResolvedValue({ ok: false, status: 429,
    headers: { get: () => '120' } }));
  await expect(service.search({ artist: 'A', title: 'B' }, 'US')).rejects.toMatchObject({ status: 429, retryAfterMs: 120000 });
  service.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ results: 'wrong' }) });
  await expect(service.search({ artist: 'A', title: 'B' }, 'US')).rejects.toThrow('Invalid Apple');
});
