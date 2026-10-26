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
      let failNextClip = false;
      await page.route('https://audio-ssl.itunes.apple.com/test.wav', route => {
        if (failNextClip) {
          failNextClip = false;
          return route.abort('failed');
        }
        return route.fulfill({ contentType: 'audio/wav', headers: { 'cache-control': 'no-store' }, body: audio });
      });
      await page.goto(`http://127.0.0.1:${server.address().port}`);
      await page.waitForSelector('.preview-button');
      assert.equal(await page.locator('#previewPlayerPanel').count(), 0, 'no preview box is rendered');
      assert.equal(await page.locator('#previewAudio').isVisible(), false, 'shared audio has no visible controls');
      assert.equal(await page.locator('#previewAudio').getAttribute('controls'), null);
      assert.equal(clipRequests.length, 0, 'must not preload audio');
      assert.ok(await page.locator('.song-row').count() < 50, 'rows remain virtualized');
      assert.ok(await page.locator('.preview-button:disabled').count() >= 2);
      const row = name => page.locator('.song-row[data-shortname="' + name + '"]');
      await row('song0').locator('.preview-button').scrollIntoViewIfNeeded();
      const gridPosition = () => page.locator('#songTableWrapper').evaluate(element => ({
        top: element.getBoundingClientRect().top + window.scrollY, scrollTop: element.scrollTop
      }));
      const before = await gridPosition();
      await row('song0').locator('.preview-button').click();
      await page.waitForFunction(() => document.querySelector('#previewAnnouncement').textContent.startsWith('Playing preview'));
      assert.deepEqual(await gridPosition(), before, 'starting playback must not shift or scroll the grid');
      assert.equal(await page.locator('.preview-active').getAttribute('data-shortname'), 'song0');
      assert.equal(await row('song0').locator('.preview-button').textContent(), 'Stop');
      assert.equal(await page.locator('audio').count(), 1);
      assert.equal(await page.locator('#previewStoreLink').getAttribute('href'), 'https://music.apple.com/us/album/1');
      await page.locator('#previewStoreLink img').evaluate(img => img.decode());
      assert.ok(await page.locator('#previewStoreLink img').evaluate(img => img.naturalWidth > 0), 'official badge remains available');
      assert.equal(await page.locator('#previewAttribution').evaluate(element => getComputedStyle(element).borderTopWidth), '0px', 'credit is unboxed');
      await row('song0').locator('.preview-button').click();
      assert.deepEqual(await gridPosition(), before, 'stopping must not shift or scroll the grid');
      assert.equal(await page.locator('.preview-last').getAttribute('data-shortname'), 'song0');
      assert.equal(await row('song0').locator('.preview-button').textContent(), 'Preview');
      assert.equal(await page.locator('.preview-last .preview-row-status').textContent(), 'Last previewed');
      await row('song3').locator('.preview-button').click();
      await page.waitForFunction(() => document.querySelector('.preview-active')?.dataset.shortname === 'song3');
      assert.equal(await page.locator('.preview-last').count(), 0, 'a new preview replaces the old highlight');
      await row('song0').locator('.preview-button').click();
      await page.waitForFunction(() => document.querySelector('#previewAnnouncement').textContent.startsWith('Playing preview: 000'));
      assert.equal(await page.locator('.preview-active').count(), 1, 'only one row is playing');
      await page.locator('#previewAudio').evaluate(audio => { audio.currentTime = audio.duration; });
      await page.waitForFunction(() => document.querySelector('#previewAnnouncement').textContent.startsWith('Preview finished'));
      assert.equal(await page.locator('.preview-last').getAttribute('data-shortname'), 'song0', 'natural completion retains highlight');
      await row('song0').locator('.preview-button').click();
      await page.waitForFunction(() => document.querySelector('#previewAnnouncement').textContent.startsWith('Playing preview'));
      await page.locator('#songTableWrapper').evaluate(element => { element.scrollTop = 7000; });
      await page.waitForTimeout(400);
      assert.equal(await page.locator('.preview-active').count(), 0, 'active row can be virtualized away');
      assert.equal(await page.locator('#previewAudio').evaluate(audio => audio.paused), false, 'scrolling does not destroy playback');
      await page.locator('#songTableWrapper').evaluate(element => { element.scrollTop = 0; });
      await page.waitForSelector('.preview-active[data-shortname="song0"]');
      await page.screenshot({ path: path.join(output, 'songs-' + viewport.width + '.png'), fullPage: true });
      const rowHeight = await row('song0').evaluate(element => element.getBoundingClientRect().height);
      assert.equal(rowHeight, viewport.width < 761 ? 104 : 66);
      await page.locator('#searchInput').fill('119');
      await page.waitForFunction(() => document.querySelector('#summaryText').textContent.includes('Showing 1 songs'));
      assert.equal(await page.locator('.preview-active').count(), 0);
      await page.locator('#searchInput').fill('');
      await page.waitForFunction(() => document.querySelector('#summaryText').textContent.includes('Showing 120 songs'));
      await page.waitForSelector('.preview-active[data-shortname="song0"]');
      await row('song0').locator('.primary').click();
      await page.waitForFunction(() => document.querySelector('#previewAnnouncement').textContent.startsWith('Preview stopped'));
      assert.equal(await page.locator('.preview-last').getAttribute('data-shortname'), 'song0', 'Pick stops audio without losing row context');
      failNextClip = true;
      await row('song0').locator('.preview-button').click();
      await page.waitForFunction(() => document.querySelector('.preview-last .preview-row-status')?.textContent === 'Preview failed');
      assert.equal(await row('song0').locator('.preview-button').textContent(), 'Preview', 'failed playback can be retried from the row');
      await row('song0').locator('.preview-button').click();
      await page.waitForFunction(() => document.querySelector('#previewAnnouncement').textContent.startsWith('Playing preview'));
      await row('song0').locator('.preview-button').click();
      await page.screenshot({ path: path.join(output, 'stopped-' + viewport.width + '.png'), fullPage: true });
      await page.locator('#adminPageButton').click();
      await page.waitForSelector('#savePreviewsButton');
      await page.locator('#previewProgress').scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(output, `admin-${viewport.width}.png`), fullPage: true });
      await page.locator('#enablePreviews').uncheck();
      await page.locator('#savePreviewsButton').click();
      await page.waitForFunction(() => document.querySelector('#previewProgress').textContent.startsWith('Off / paused'));
      await page.locator('#songsPageButton').click();
      await page.waitForFunction(() => document.querySelectorAll('.preview-button').length === 0);
      assert.equal(await page.locator('#previewAttribution').isVisible(), false, 'disabling previews clears the credit');
      assert.equal(metadataRequests.length, 0, 'browser must never search Apple');
      assert.deepEqual(errors, []);
      console.log(`PASS ${viewport.width}px: row-only playback, no box/layout shift, retained highlights, switching/end, filtering, Pick/stop, no browser Apple searches`);
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
