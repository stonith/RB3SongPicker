// Optional U5 visual/interaction check. Uses an external Playwright installation,
// only local synthetic endpoints, and never sends a console selection request.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const express = require('express');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

(async () => {
  const songs = Array.from({ length: 120 }, (_, i) => ({ shortname: `song${i}`, title: `Song ${String(i).padStart(3, '0')}`, artist: 'Test artist', album: 'Tonight', origin: 'rb3', picks: 0 }));
  const entries = songs.slice(0, 3).map((song, i) => ({ ...song, id: `entry${i}`, status: 'pending' }));
  let snapshot = { version: 0, session: null, operation: null };
  const subscribers = new Set();
  const commands = [];
  const publish = () => { for (const res of subscribers) res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`); };
  const app = express(); app.use(express.json());
  app.use(express.static(path.join(__dirname, '../public')));
  app.get('/api/queue', (req, res) => res.json(snapshot));
  app.get('/api/queue/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream'); res.flushHeaders(); subscribers.add(res);
    res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);
    req.on('close', () => subscribers.delete(res));
  });
  app.post('/api/queue/commands', (req, res) => {
    commands.push(req.body);
    if (req.body.type === 'start') snapshot.session = { id: 'session', sourceList: { name: 'Party list' }, status: 'running', entries: structuredClone(entries), lockedEntryId: null, currentAttempt: null };
    else if (req.body.type === 'pause') { snapshot.session.status = 'paused'; snapshot.session.pauseReason = 'Manually paused'; }
    else if (req.body.type === 'resume') { snapshot.session.status = 'running'; snapshot.session.pauseReason = null; }
    else if (req.body.type === 'stop') snapshot.session.status = 'stopped';
    snapshot.version++; publish(); res.json(snapshot);
  });
  app.get('/api/songs', (req, res) => {
    let result = req.query.listId ? songs.slice(0, 3) : songs;
    if (req.query.search) result = result.filter(song => song.title.includes(req.query.search));
    res.json({ songs: result });
  });
  app.get('/api/songlists', (req, res) => res.json({ lists: [{ id: 1, name: 'Party list', songCount: 3 }] }));
  app.get('/api/config', (req, res) => res.json({ theme: 'default' }));
  app.get('/api/settings', (req, res) => res.json({ showSongListManagement: true }));
  app.get('/api/version', (req, res) => res.json({ version: 'U5 browser fixture' }));
  app.get('/api/previews', (req, res) => res.json({ enabled: false, country: 'US', counts: {} }));
  app.use('/api', (req, res) => res.status(500).json({ error: `Unexpected fixture request: ${req.path}` }));
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || undefined });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const output = await fs.mkdtemp(path.join(os.tmpdir(), 'rb3-queue-workspace-'));
  try {
    for (const theme of ['default', 'strata']) for (const width of [390, 1280]) {
      snapshot = { version: 0, session: null, operation: null };
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      await context.route('https://**', route => route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg"/>' }));
      const page = await context.newPage(); const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(`http://127.0.0.1:${server.address().port}`);
      await page.waitForFunction(() => document.querySelectorAll('.song-row').length > 0 && !document.querySelector('#randomButton').disabled);
      await page.evaluate(value => applyTheme(value), theme);
      assert.equal(await page.locator('#startQueueButton').isDisabled(), true);
      await page.locator('#songListSelect').selectOption('1');
      await page.waitForFunction(() => document.querySelector('#startQueueButton').textContent === 'Start queue (3)');
      await page.locator('#searchInput').fill('001');
      await page.waitForFunction(() => document.querySelectorAll('.song-row').length === 1);
      assert.equal(await page.locator('#startQueueButton').textContent(), 'Start queue (3)');
      await page.locator('#startQueueButton').click();
      await page.waitForSelector('#queuePage:not(.hidden)');
      assert.equal(commands.at(-1).listId, 1);
      assert.equal(commands.at(-1).search, undefined);
      assert.equal(await page.locator('#queueUpcoming li').count(), 3);
      assert.match(await page.locator('#queueStatus').textContent(), /Waiting for song selection/);
      assert.equal(await page.locator('#randomButton').isDisabled(), true);
      snapshot.version++; snapshot.session.lockedEntryId = 'entry0'; publish();
      await page.waitForFunction(() => document.querySelector('#queueStatus').textContent.startsWith('Selection requested'));
      assert.equal(await page.locator('#queueUpcoming li').count(), 2);
      await page.locator('#queuePauseButton').click();
      await page.waitForFunction(() => document.querySelector('#queueStatus').textContent.startsWith('Paused:'));
      const second = await context.newPage(); second.on('pageerror', error => errors.push(error.message));
      await second.goto(`http://127.0.0.1:${server.address().port}`);
      await second.waitForSelector('#queuePage:not(.hidden)');
      await page.locator('#songsPageButton').click();
      await page.locator('#searchInput').fill('');
      await page.waitForFunction(() => document.querySelectorAll('.song-row').length === 3);
      await page.locator('#searchInput').focus();
      const before = await page.locator('#songTableWrapper').evaluate(el => el.scrollTop);
      snapshot.version++; snapshot.session.pauseReason = 'Remote pause'; publish();
      await page.waitForFunction(() => document.querySelector('#queueCompactText').textContent.includes('Remote pause'));
      assert.equal(await page.locator('#songsPage').isVisible(), true);
      assert.equal(await page.locator('#searchInput').evaluate(el => el === document.activeElement), true);
      assert.equal(await page.locator('#songTableWrapper').evaluate(el => el.scrollTop), before);
      await page.locator('#queuePageButton').click();
      assert.equal(await page.locator('#queuePageButton').getAttribute('aria-current'), 'page');
      assert.equal(await page.locator('#songsPageButton').getAttribute('aria-current'), 'false');
      await page.screenshot({ path: path.join(output, `${theme}-${width}-paused.png`), fullPage: true });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal page overflow');
      // A stopped unresolved transmission remains visible and blocks manual picks.
      snapshot.version++; snapshot.session.status = 'stopped'; snapshot.operation = { id: 'operation', status: 'unknown' }; publish();
      await page.waitForFunction(() => !document.querySelector('#queueWarning').hidden);
      assert.equal(await page.locator('#queueControls').isVisible(), false);
      assert.match(await page.locator('#queueWarning').textContent(), /restart.*Admin/);
      snapshot.version++; snapshot.operation = null; snapshot.session.status = 'completed'; snapshot.session.lockedEntryId = null; snapshot.session.entries = []; publish();
      await page.waitForFunction(() => document.querySelector('#queueStatus').textContent === 'Queue complete');
      assert.equal(await page.locator('#queueUpcoming li').count(), 0);
      assert.equal(await page.locator('#randomButton').isDisabled(), false);
      assert.deepEqual(errors, []);
      console.log(`PASS ${theme} ${width}px: full-list Start, initial join, locks/controls, remote focus/navigation, quarantine, empty completion`);
      await context.close();
    }
    console.log(`Screenshots: ${output}`);
  } finally {
    await browser.close(); for (const res of subscribers) res.end();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
