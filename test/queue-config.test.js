const request = require('supertest');
const { harness } = require('./queue-test-helpers.cjs');
let h;
beforeEach(async () => { h = await harness(); });
afterEach(async () => { await h.close(); });

test('queue preference defaults off, is strictly validated, persists and preserves PIN/theme/UI/preview settings', async () => {
  expect((await request(h.app).get('/api/queue/preferences').expect(200)).body).toEqual({ pauseAfterAttempt: false });
  h.configStore.save({ ...h.configStore.load(), theme: 'strata', xboxPort: 8080 }); h.configStore.setAdminPin('1234');
  await h.db.setSetting('showSongListManagement', 'true');
  const previewStore = new (require('../preview-store'))(h.db);
  await previewStore.initialize();
  await previewStore.configure({ enabled: true, country: 'GB', negativeDays: 45 });
  const previewsBefore = await previewStore.config();
  const before = h.configStore.load();
  for (const value of [{}, { pauseAfterAttempt: 'true' }, { pauseAfterAttempt: true, theme: 'default' }]) {
    await request(h.app).post('/api/queue/preferences').send(value).expect(400);
  }
  await request(h.app).post('/api/queue/preferences').send({ pauseAfterAttempt: true }).expect(200, { pauseAfterAttempt: true });
  expect(h.configStore.load()).toEqual({ ...before, pauseAfterAttempt: true });
  await request(h.app).post('/api/settings').send({ showShortnameColumn: true }).expect(200);
  expect(h.configStore.load().pauseAfterAttempt).toBe(true);
  expect(await previewStore.config()).toEqual(previewsBefore);
  expect(h.configStore.verifyAdminPin('1234')).toBe(true);
});

test('network fields round-trip; config changes pause and invalidate while theme-only changes do not', async () => {
  await h.runtime.controller.command(await h.command('start', { listId: 1 }));
  await request(h.app).post('/api/config').send({ theme: 'strata' }).expect(200);
  expect((await h.runtime.store.read()).session.status).toBe('running');
  const epoch = h.runtime.game.snapshot().epoch;
  const response = await request(h.app).post('/api/config').send({ xboxIp: '192.0.2.3', xboxPort: 8080, eventsBindAddress: '127.0.0.1', eventsPort: 21071 }).expect(200);
  expect(response.body).toMatchObject({ eventsBindAddress: '127.0.0.1', eventsPort: 21071 });
  expect(h.runtime.listener.config).toEqual({ sourceAddress: '192.0.2.3', bindAddress: '127.0.0.1', port: 21071 });
  expect((await h.runtime.store.read()).session.status).toBe('paused');
  expect(h.runtime.game.snapshot().epoch).toBeGreaterThan(epoch);
  expect(h.runtime.game.snapshot().canSelect).toBe(false);
});

test.each([{ eventsPort: 0 }, { eventsPort: 65536 }, { eventsPort: '21070' }, { eventsBindAddress: 'bad' }, { xboxIp: 'bad' }, { xboxPort: 70000 }])('invalid network update %j is atomic', async body => {
  const before = h.configStore.load();
  await request(h.app).post('/api/config').send(body).expect(400);
  expect(h.configStore.load()).toEqual(before);
});

test('dedicated preference is sampled by composed controller at attempt start, not retroactively', async () => {
  await request(h.app).post('/api/queue/preferences').send({ pauseAfterAttempt: true }).expect(200);
  await h.runtime.controller.command(await h.command('start', { listId: 1 }));
  await h.observe('SCREEN_NAME', 'song_select_screen');
  await h.observe('SONG_SHORTNAME', 'a'); await h.observe('STATE', 1);
  await request(h.app).post('/api/queue/preferences').send({ pauseAfterAttempt: false }).expect(200);
  await h.observe('STATE', 0); await h.observe('SCREEN_NAME', 'song_select_screen');
  expect((await h.runtime.store.read()).session).toMatchObject({ status: 'paused', pauseReason: 'Pause after each song attempt' });
  expect(h.xbox.selectSong.mock.calls).toEqual([['a']]);
  await h.runtime.controller.command(await h.command('resume'));
  expect(h.xbox.selectSong.mock.calls).toEqual([['a'], ['b']]);
});

test('legacy xboxPort numeric strings normalize to persisted numbers without narrowing the existing API', async () => {
  h.configStore.save({ ...h.configStore.load(), xboxPort: 8080 });
  const response = await request(h.app).post('/api/config').send({ xboxPort: '21070' }).expect(200);
  expect(response.body.xboxPort).toBe(21070);
  expect(h.configStore.load().xboxPort).toBe(21070);
  expect(JSON.parse(require('node:fs').readFileSync(h.configStore.configPath, 'utf8')).xboxPort).toBe(21070);
  for (const xboxPort of ['0', '65536', '1.5', 'bad']) {
    const before = h.configStore.load();
    await request(h.app).post('/api/config').send({ xboxPort, theme: 'strata' }).expect(400);
    expect(h.configStore.load()).toEqual(before);
  }
});
