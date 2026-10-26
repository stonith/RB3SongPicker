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
      assert.equal(await page.locator('#previewPlayerPanel').isVisible(), true, 'enabled player reserves space below the grid');
      assert.equal(clipRequests.length, 0, 'must not preload audio');
      assert.ok(await page.locator('.song-row').count() < 50, 'rows remain virtualized');
      assert.ok(await page.locator('.preview-button:disabled').count() >= 2);
      await page.locator('.preview-button:not(:disabled)').first().scrollIntoViewIfNeeded();
      const gridPosition = () => page.locator('#songTableWrapper').evaluate(element => ({
        top: element.getBoundingClientRect().top + window.scrollY, scrollTop: element.scrollTop
      }));
      const before = await gridPosition();
      await page.locator('.preview-button:not(:disabled)').first().click();
      await page.waitForFunction(() => document.querySelector('#previewPlaybackStatus').textContent === 'Playing preview');
      assert.deepEqual(await gridPosition(), before, 'starting playback must not shift or scroll the grid');
      assert.equal(await page.locator('.preview-active').getAttribute('data-shortname'), 'song0');
      assert.equal(await page.locator('audio').count(), 1);
      assert.equal(await page.locator('#previewStoreLink').getAttribute('href'), 'https://music.apple.com/us/album/1');
      assert.ok(await page.evaluate(() => document.querySelector('#previewPlayerPanel').getBoundingClientRect().top
        >= document.querySelector('#songTableWrapper').getBoundingClientRect().bottom), 'player must be below, not over, the list');
      await page.locator('#previewStoreLink img').evaluate(img => img.decode());
      assert.ok(await page.locator('#previewStoreLink img').evaluate(img => img.naturalWidth > 0), 'official badge must be visible');
      await page.locator('#stopPreviewButton').click();
      assert.equal(await page.locator('#previewPlayerPanel').isVisible(), true, 'Stop keeps the player and song identity');
      assert.deepEqual(await gridPosition(), before, 'stopping must not shift or scroll the grid');
      assert.equal(await page.locator('.preview-last').getAttribute('data-shortname'), 'song0');
      assert.equal(await page.locator('.preview-last .preview-row-status').textContent(), 'Last previewed');
      await page.locator('#replayPreviewButton').click();
      await page.waitForFunction(() => document.querySelector('#previewPlaybackStatus').textContent === 'Playing preview');
      await page.locator('#previewAudio').evaluate(audio => { audio.currentTime = audio.duration; });
      await page.waitForFunction(() => document.querySelector('#previewPlaybackStatus').textContent.startsWith('Finished'));
      assert.equal(await page.locator('.preview-last').getAttribute('data-shortname'), 'song0', 'natural completion retains highlight');
      await page.locator('#replayPreviewButton').click();
      await page.waitForFunction(() => document.querySelector('#previewPlaybackStatus').textContent === 'Playing preview');
      await page.locator('#songTableWrapper').evaluate(element => { element.scrollTop = 7000; });
      await page.waitForTimeout(400);
      assert.equal(await page.locator('.preview-active').count(), 0, 'active row can be virtualized away');
      assert.equal(await page.locator('#previewPlayerPanel').isVisible(), true, 'virtualization must not destroy playback');
      await page.locator('#showPreviewSongButton').click();
      await page.waitForSelector('.preview-active[data-shortname="song0"]');
      assert.equal(await page.locator('.preview-active').evaluate(row => row === document.activeElement), true, 'Show in list focuses the correct row');
      await page.screenshot({ path: path.join(output, `songs-${viewport.width}.png`), fullPage: true });
      const rowHeight = await page.locator('.preview-active').evaluate(row => row.getBoundingClientRect().height);
      assert.equal(rowHeight, viewport.width < 761 ? 104 : 66);
      await page.locator('#searchInput').fill('119');
      await page.waitForFunction(() => document.querySelector('#summaryText').textContent.includes('Showing 1 songs'));
      assert.equal(await page.locator('#showPreviewSongButton').isDisabled(), true, 'Show in list respects filters');
      await page.locator('#searchInput').fill('');
      await page.waitForFunction(() => document.querySelector('#summaryText').textContent.includes('Showing 120 songs'));
      await page.locator('#showPreviewSongButton').click();
      await page.waitForSelector('.preview-active[data-shortname="song0"]');
      await page.locator('#pickPreviewButton').click();
      await page.waitForFunction(() => document.querySelector('#previewPlaybackStatus').textContent.startsWith('Stopped'));
      assert.equal(await page.locator('.preview-last').getAttribute('data-shortname'), 'song0', 'Pick stops audio without losing preview context');
      await page.waitForFunction(() => getComputedStyle(document.querySelector('#gotoControls')).visibility === 'hidden');
      await page.screenshot({ path: path.join(output, `stopped-${viewport.width}.png`), fullPage: true });
      await page.locator('#adminPageButton').click();
      await page.waitForSelector('#savePreviewsButton');
      await page.locator('#previewProgress').scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(output, `admin-${viewport.width}.png`), fullPage: true });
      await page.locator('#enablePreviews').uncheck();
      await page.locator('#savePreviewsButton').click();
      await page.waitForFunction(() => document.querySelector('#previewProgress').textContent.startsWith('Off / paused'));
      await page.locator('#songsPageButton').click();
      await page.waitForFunction(() => document.querySelectorAll('.preview-button').length === 0);
      assert.equal(await page.locator('#previewPlayerPanel').isVisible(), false, 'disabling previews hides the reserved player');
      assert.equal(metadataRequests.length, 0, 'browser must never search Apple');
      assert.deepEqual(errors, []);
      console.log(`PASS ${viewport.width}px: bottom player, no layout shift, retained highlights, replay/end, Show in list, filtering, Pick/stop, no browser Apple searches`);
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
