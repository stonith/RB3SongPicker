// Optional browser smoke test. Requires Playwright + Chromium; not part of Jest.
// PLAYWRIGHT_MODULE can point to an existing external Playwright installation.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const express = require('express');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs/promises');
const Database = require('../database');
const PreviewStore = require('../preview-store');
const { createApiRouter } = require('../api-router');

(async () => {
  const db = new Database(':memory:');
  const store = new PreviewStore(db);
  await store.initialize();
  await store.configure({ enabled: true, country: 'US', negativeDays: 30 });
  await db.transaction(async () => {
    for (let i = 0; i < 120; i++) await db.promisifyRun(
      'INSERT INTO songs (shortname, title, artist, album, origin) VALUES (?, ?, ?, ?, ?)',
      [`song${i}`, `${String(i).padStart(3, '0')} Somebody to Love`, 'Queen', 'A Day at the Races', 'rb3']);
  });
  await store.reconcile('US');
  await db.promisifyRun("UPDATE preview_matches SET status = 'matched', result = ?", [JSON.stringify({
    status: 'matched', title: 'Somebody to Love', artist: 'Queen',
    previewUrl: 'https://audio-ssl.itunes.apple.com/test.wav', storeUrl: 'https://music.apple.com/us/album/1'
  })]);
  await db.promisifyRun("UPDATE preview_matches SET status = 'unavailable' WHERE shortname = 'song1'");
  await db.promisifyRun("UPDATE preview_matches SET status = 'pending' WHERE shortname = 'song2'");
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(__dirname, '../public')));
  app.get('/api/version', (req, res) => res.json({ version: 'browser-test' }));
  app.use('/api', createApiRouter({ db, configStore: { load: () => ({}) },
    xboxService: { fetch: async () => '' }, previewStore: store,
    previewWorker: { requestReconcile() {} } }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const browser = await chromium.launch({ headless: true });
  const output = await fs.mkdtemp(path.join(os.tmpdir(), 'rb3-preview-screenshots-'));
  try {
    for (const viewport of [{ width: 1280, height: 950 }, { width: 390, height: 844 }]) {
      const page = await browser.newPage({ viewport });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      const metadataRequests = [];
      const clipRequests = [];
      page.on('request', req => {
        if (req.url().includes('itunes.apple.com/search')) metadataRequests.push(req.url());
        if (req.url().includes('/test.wav')) clipRequests.push(req.url());
      });
      // A small synthetic WAV verifies real browser audio without provider calls.
      const audio = Buffer.alloc(44 + 8000 * 8);
      audio.write('RIFF', 0); audio.writeUInt32LE(audio.length - 8, 4); audio.write('WAVEfmt ', 8);
      audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22);
      audio.writeUInt32LE(8000, 24); audio.writeUInt32LE(8000, 28); audio.writeUInt16LE(1, 32);
      audio.writeUInt16LE(8, 34); audio.write('data', 36); audio.writeUInt32LE(audio.length - 44, 40);
      audio.fill(128, 44);
      await page.route('https://audio-ssl.itunes.apple.com/test.wav', route => route.fulfill({ contentType: 'audio/wav', body: audio }));
      await page.goto(`http://127.0.0.1:${server.address().port}`);
      await page.waitForSelector('.preview-button');
      assert.equal(await page.locator('#previewPlayerPanel').isVisible(), false);
      assert.equal(clipRequests.length, 0, 'must not preload audio');
      assert.ok(await page.locator('.song-row').count() < 50, 'rows remain virtualized');
      assert.ok(await page.locator('.preview-button:disabled').count() >= 2);
      await page.locator('.preview-button:not(:disabled)').first().click();
      await page.waitForFunction(() => document.querySelector('#previewPlaybackStatus').textContent === 'Playing preview');
      assert.equal(await page.locator('#previewPlayerPanel').isVisible(), true);
      assert.equal(await page.locator('audio').count(), 1);
      assert.equal(await page.locator('#previewStoreLink').getAttribute('href'), 'https://music.apple.com/us/album/1');
      await page.locator('#previewStoreLink img').evaluate(img => img.decode());
      assert.ok(await page.locator('#previewStoreLink img').evaluate(img => img.naturalWidth > 0), 'official badge must be visible');
      await page.screenshot({ path: path.join(output, `songs-${viewport.width}.png`), fullPage: true });
      const rowHeight = await page.locator('.song-row').first().evaluate(row => row.getBoundingClientRect().height);
      assert.equal(rowHeight, viewport.width < 761 ? 104 : 66);
      await page.locator('#songTableWrapper').evaluate(element => { element.scrollTop = 7000; });
      await page.waitForTimeout(400);
      assert.equal(await page.locator('#previewPlayerPanel').isVisible(), true, 'virtualization must not destroy playback');
      await page.locator('.song-actions .primary').first().click();
      assert.equal(await page.locator('#previewPlayerPanel').isVisible(), false, 'Pick must stop preview');
      await page.locator('#adminPageButton').click();
      await page.waitForSelector('#savePreviewsButton');
      await page.locator('#previewProgress').scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(output, `admin-${viewport.width}.png`), fullPage: true });
      await page.locator('#enablePreviews').uncheck();
      await page.locator('#savePreviewsButton').click();
      await page.waitForFunction(() => document.querySelector('#previewProgress').textContent.startsWith('Off / paused'));
      await page.locator('#songsPageButton').click();
      await page.waitForFunction(() => document.querySelectorAll('.preview-button').length === 0);
      assert.equal(metadataRequests.length, 0, 'browser must never search Apple');
      assert.deepEqual(errors, []);
      console.log(`PASS ${viewport.width}px: playback, no preload, virtual rows, pick/stop, admin pause, no browser Apple searches`);
      // Restore the shared fixture before the next viewport.
      await store.configure({ enabled: true, country: 'US', negativeDays: 30 });
      await page.close();
    }
    console.log(`Screenshots: ${output}`);
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
    await db.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
