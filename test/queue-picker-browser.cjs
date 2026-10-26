// Optional U6 checks. External Playwright, synthetic localhost endpoints only.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const express = require('express');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

(async () => {
  const songs = Array.from({ length: 5000 }, (_, i) => ({ shortname: `song${i}`, title: `Song ${String(i).padStart(4, '0')}`, artist: 'Test artist', album: 'Tonight', origin: 'rb3', preview: { status: 'matched', previewUrl: '/clip.wav', storeUrl: 'https://example.test/store' } }));
  const entries = songs.slice(0, 3).map((song, i) => ({ ...song, id: `entry${i}`, status: 'pending' }));
  let snapshot, lostAdd, nextId, conflictNext, pauseAfterAttempt;
  const receipts = new Map(); const commands = []; const subscribers = new Set();
  const publish = () => { for (const res of subscribers) res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`); };
  const app = express(); app.use(express.json()); app.use(express.static(path.join(__dirname, '../public')));
  const audio = Buffer.alloc(44 + 8000 * 30 * 2);
  audio.write('RIFF'); audio.writeUInt32LE(audio.length - 8, 4); audio.write('WAVEfmt ', 8);
  audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22);
  audio.writeUInt32LE(8000, 24); audio.writeUInt32LE(16000, 28); audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34);
  audio.write('data', 36); audio.writeUInt32LE(audio.length - 44, 40);
  app.get('/clip.wav', (req, res) => res.type('audio/wav').send(audio));
  app.get('/api/queue', (req, res) => res.json(snapshot));
  app.get('/api/queue/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream'); res.flushHeaders(); subscribers.add(res);
    res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);
    res.write(`event: diagnostics\ndata: ${JSON.stringify({ listener: { status: 'listening', sourceAddress: '192.0.2.1', bindAddress: '0.0.0.0', port: 21070, lastObservedAt: 1000 }, evidence: { epoch: 1, screen: { name: 'song_select_screen', receivedAt: 1000 } } })}\n\n`);
    req.on('close', () => subscribers.delete(res));
  });
  app.get('/api/queue/preferences', (req, res) => res.json({ pauseAfterAttempt }));
  app.post('/api/queue/preferences', (req, res) => { assert.deepEqual(Object.keys(req.body), ['pauseAfterAttempt']); pauseAfterAttempt = req.body.pauseAfterAttempt; res.json({ pauseAfterAttempt }); });
  app.post('/api/queue/commands', (req, res) => {
    const command = req.body; commands.push(command);
    if (receipts.has(command.commandId)) return res.json(receipts.get(command.commandId));
    if (conflictNext) { conflictNext = false; snapshot.version++; snapshot.session.lockedEntryId = snapshot.session.entries.find(e => e.status === 'pending' && e.id !== snapshot.session.lockedEntryId).id; publish(); }
    if (command.expectedVersion !== snapshot.version) return res.status(409).json({ code: 'STALE_VERSION', error: 'Another participant changed the queue', snapshot });
    const session = snapshot.session;
    if (command.type === 'add') session.entries.push({ ...songs.find(s => s.shortname === command.shortname), id: `added-${++nextId}`, status: 'pending' });
    else if (command.type === 'remove') {
      if (command.entryId === session.lockedEntryId) return res.status(409).json({ error: 'Entry locked', snapshot });
      session.entries = session.entries.filter(e => e.id !== command.entryId);
    } else if (command.type === 'reorder') {
      const byId = new Map(session.entries.map(e => [e.id, e])); session.entries = command.entryIds.map(id => byId.get(id));
    } else if (command.type === 'confirm-console-restarted') {
      assert.equal(command.operationId, snapshot.operation.id);
      snapshot.operation = null; session.status = 'paused'; session.pauseReason = 'Console restarted; Resume after new song-selection evidence'; session.lockedEntryId = null;
    } else throw new Error(`Unexpected command ${command.type}`);
    snapshot.version++; receipts.set(command.commandId, structuredClone(snapshot)); publish();
    // An unreadable accepted response deterministically simulates a lost result;
    // a TCP reset may be transparently retried by Chromium itself.
    if (lostAdd && command.type === 'add') { lostAdd = false; return res.type('json').send('{'); }
    res.json(snapshot);
  });
  app.get('/api/songs', (req, res) => {
    let result = req.query.listId ? songs.slice(0, 3) : songs;
    if (req.query.search) result = result.filter(s => s.title.includes(req.query.search));
    res.json({ songs: result });
  });
  app.get('/api/songlists', (req, res) => res.json({ lists: [{ id: 1, name: 'Party list', songCount: 3 }] }));
  app.get('/api/config', (req, res) => res.json({ theme: 'default' }));
  app.get('/api/settings', (req, res) => res.json({ showSongListManagement: true }));
  app.get('/api/version', (req, res) => res.json({ version: 'U6 fixture' }));
  app.get('/api/previews', (req, res) => res.json({ enabled: true, country: 'US', counts: {} }));
  app.post('/api/previews/lookup', (req, res) => res.json({ songs: req.body.shortnames.map(shortname => ({ shortname, preview: songs[0].preview })) }));
  app.use('/api', (req, res) => res.status(500).json({ error: `Unexpected fixture request: ${req.path}` }));
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || undefined });
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const output = await fs.mkdtemp(path.join(os.tmpdir(), 'rb3-queue-picker-'));
  try {
    for (const theme of ['default', 'strata']) for (const width of [360, 390, 1280]) {
      snapshot = { version: 1, session: { id: 'session', sourceList: { name: 'Party list' }, status: 'paused', pauseReason: 'Manually paused', entries: structuredClone(entries), lockedEntryId: 'entry0', currentAttempt: null }, operation: null };
      lostAdd = false; nextId = 0; conflictNext = false; pauseAfterAttempt = false; commands.length = 0; receipts.clear();
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      await context.route('https://**', route => route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg"/>' }));
      const page = await context.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message));
      await page.goto(`http://127.0.0.1:${server.address().port}`); await page.waitForSelector('#queuePage:not(.hidden)');
      await page.evaluate(value => applyTheme(value), theme);
      const second = await context.newPage(); second.on('pageerror', e => errors.push(e.message));
      await second.goto(`http://127.0.0.1:${server.address().port}`); await second.waitForSelector('#queuePage:not(.hidden)');
      const controls = page.locator('[data-entry-id="entry2"] .queue-entry-controls button:not(.queue-preview-button)');
      assert.deepEqual(await controls.allTextContents(), ['↑', '↓', '−']);
      const bounds = await controls.evaluateAll(buttons => buttons.map(button => ({ top: button.getBoundingClientRect().top, height: button.getBoundingClientRect().height, width: button.getBoundingClientRect().width })));
      assert.ok(bounds.every(box => box.top === bounds[0].top && box.width >= 44 && box.height >= 44), 'compact controls stay on one line with usable touch targets');
      await page.locator('[data-entry-id="entry2"] button').first().focus(); await page.keyboard.press('Enter');
      await second.waitForFunction(() => document.querySelector('#queueUpcoming li').dataset.entryId === 'entry2');
      assert.equal(snapshot.session.entries[0].id, 'entry0');
      await page.waitForFunction(() => !document.querySelector('[data-entry-id="entry2"] button[aria-label^="Remove:"]').disabled);
      assert.equal(await page.locator('[data-entry-id="entry2"]').evaluate(el => el.contains(document.activeElement)), true, 'reorder retains keyboard focus on that entry');
      await page.waitForFunction(() => !document.querySelector('[data-entry-id="entry1"] button[aria-label^="Remove:"]').disabled);
      await page.locator('[data-entry-id="entry1"] button[aria-label^="Remove:"]').focus(); await page.keyboard.press('Enter');
      await second.waitForFunction(() => document.querySelectorAll('#queueUpcoming li').length === 1);
      assert.equal(await page.locator('#queueCurrentTitle').textContent(), 'Song 0000');
      const queuePreview = page.locator('[data-entry-id="entry2"] .queue-preview-button');
      await page.waitForFunction(() => !document.querySelector('[data-entry-id="entry2"] .queue-preview-button')?.disabled);
      const commandCount = commands.length;
      await queuePreview.click();
      await page.waitForFunction(() => previewPlayer.state.status === 'playing' && document.querySelector('[data-entry-id="entry2"] .queue-preview-button').textContent === 'Stop');
      assert.equal(commands.length, commandCount, 'queue preview never sends a queue or console command');
      assert.equal(await page.locator('#queuePreviewAttribution').isVisible(), true);
      const currentPreview = page.locator('#queueCurrent .queue-preview-button');
      await currentPreview.click();
      await page.waitForFunction(() => previewPlayer.state.song?.shortname === 'song0' && previewPlayer.state.status === 'playing');
      assert.equal(await queuePreview.textContent(), 'Preview', 'one shared audio player updates other queue controls');
      await currentPreview.click();
      await page.screenshot({ path: path.join(output, `${theme}-${width}-queue-previews.png`), fullPage: true });
      await page.locator('#queueAddSongsButton').click();
      const scroll = await page.evaluate(() => pickerWindowScroll);
      await page.waitForFunction(() => document.querySelector('#queuePickerSummary').textContent.startsWith('5000'));
      assert.equal(await page.locator('#queuePickerTitle').evaluate(el => el === document.activeElement), true, 'opening picker focuses its heading, not an input');
      assert.ok(await page.locator('#queuePickerBody .song-row').count() < 70, '5,000 songs remain virtualized');
      if (width < 1120) {
        assert.equal(await page.locator('#queuePicker').getAttribute('aria-modal'), 'true');
        assert.equal(await page.locator('.topbar').evaluate(el => el.inert), true);
        await page.locator('#queuePickerDone').focus(); await page.keyboard.press('Shift+Tab');
        assert.equal(await page.locator('#queuePicker').evaluate(el => el.contains(document.activeElement)), true);
        const height = await page.locator('#queuePicker').evaluate(el => el.getBoundingClientRect().height);
        assert.equal(height, 900);
      } else {
        const positions = await page.evaluate(() => ({ queue: document.querySelector('.queue-workspace').getBoundingClientRect().right, picker: document.querySelector('#queuePicker').getBoundingClientRect().left }));
        assert.ok(positions.picker > positions.queue, 'wide picker sits beside queue');
      }
      // Scrolling the independent container changes the rendered range, not its size.
      await page.locator('#queuePickerScroller').evaluate(el => { el.scrollTop = 200000; });
      await page.waitForFunction(() => Number(document.querySelector('#queuePickerBody .song-row').dataset.shortname.slice(4)) > 1000);
      assert.ok(await page.locator('#queuePickerBody .song-row').count() < 70);
      await page.locator('#queuePickerList').selectOption('1');
      await page.waitForFunction(() => document.querySelector('#queuePickerSummary').textContent.startsWith('3 songs'));
      assert.equal(await page.locator('#songListSelect').inputValue(), '', 'picker list context never changes Songs');
      await page.locator('#queuePickerList').selectOption('');
      await page.waitForFunction(() => document.querySelector('#queuePickerSummary').textContent.startsWith('5000'));
      if (width >= 1120) {
        await page.setViewportSize({ width: 1024, height: 650 });
        await page.waitForFunction(() => document.querySelector('#queuePicker').getAttribute('aria-modal') === 'true');
        await page.setViewportSize({ width, height: 900 });
        await page.waitForFunction(() => !document.querySelector('#queuePicker').hasAttribute('aria-modal'));
        assert.notEqual(await page.evaluate(() => document.activeElement?.tagName), 'INPUT', 'responsive layout must not autofocus search');
        assert.ok(await page.locator('#queuePickerBody .song-row').count() < 70);
      }
      await page.emulateMedia({ reducedMotion: 'reduce' });
      assert.equal(await page.locator('#queuePicker').evaluate(el => getComputedStyle(el).animationName), 'none');
      await page.locator('#queuePickerSearch').fill('0002');
      await page.waitForFunction(() => document.querySelector('#queuePickerSummary').textContent.startsWith('1 song'));
      const add = page.locator('#queuePickerBody [data-queue-add="song2"]');
      await add.click(); await page.waitForFunction(() => document.querySelector('#queuePickerFeedback').textContent.startsWith('Added'));
      assert.equal(await page.locator('#queuePicker').isVisible(), true);
      assert.equal(await page.locator('#queuePickerSearch').inputValue(), '0002');
      assert.equal(await add.evaluate(el => el === document.activeElement), true, 'confirmed Add preserves row focus');
      lostAdd = true; await add.click();
      await page.waitForFunction(() => document.querySelector('#queuePickerFeedback').textContent.startsWith('Result unknown'));
      assert.equal(await add.textContent(), 'Result unknown — Retry');
      const original = commands.at(-1); const length = snapshot.session.entries.length;
      await add.click(); await page.waitForFunction(() => document.querySelector('#queuePickerFeedback').textContent.startsWith('Added'));
      assert.equal(commands.at(-1).commandId, original.commandId); assert.equal(snapshot.session.entries.length, length);
      await add.click(); await page.waitForFunction(() => document.querySelector('#queuePickerFeedback').textContent.startsWith('Added'));
      assert.notEqual(commands.at(-1).commandId, original.commandId);
      await second.waitForFunction(() => document.querySelectorAll('#queueUpcoming li').length === 4);
      // A new remote lock conflicts with an edit without closing/resetting picker.
      conflictNext = true;
      await page.evaluate(() => moveQueueEntry(queueClient.snapshot.session.entries.at(-1).id, -1));
      await page.waitForFunction(() => document.querySelector('#queueActionStatus').textContent.startsWith('Action not applied'));
      assert.equal(await page.locator('#queuePicker').isVisible(), true); assert.equal(await page.locator('#queuePickerSearch').inputValue(), '0002');
      await page.locator('#queuePickerSearch').focus(); snapshot.version++; snapshot.session.pauseReason = 'Remote pause'; publish();
      await page.waitForFunction(() => document.querySelector('#queueStatus').textContent.includes('Remote pause'));
      assert.equal(await page.locator('#queuePickerSearch').evaluate(el => el === document.activeElement), true);
      await page.waitForFunction(() => !document.querySelector('#queuePickerBody [data-preview-shortname]').disabled);
      // A preview uses the existing audio player and carries attribution inside the picker.
      await page.locator('#queuePickerBody [data-preview-shortname]').click();
      await page.waitForFunction(() => !document.querySelector('#queuePickerAttribution').hidden && previewPlayer.state.status === 'playing');
      await add.click(); await page.waitForFunction(() => document.querySelector('#queuePickerFeedback').textContent.startsWith('Added'));
      assert.equal(await page.evaluate(() => previewPlayer.state.status), 'playing', 'Add never stops independent preview audio');
      await page.waitForFunction(() => {
        const buttons = Array.from(document.querySelectorAll('#queueUpcoming [data-shortname="song2"] .queue-preview-button'));
        return buttons.length >= 2 && buttons.every(button => button.textContent === 'Stop');
      });
      assert.ok(await page.locator('#queuePickerAttribution').evaluate(el => el.getBoundingClientRect().bottom <= innerHeight), 'preview credit stays inside viewport');
      await page.screenshot({ path: path.join(output, `${theme}-${width}-picker.png`) });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no page overflow');
      assert.ok(await page.locator('#queuePickerScroller').evaluate(el => el.scrollWidth <= el.clientWidth + 1), 'no picker overflow');
      await page.locator('#queuePickerDone').click();
      assert.equal(await page.locator('#queueAddSongsButton').evaluate(el => el === document.activeElement), true);
      assert.equal(await page.evaluate(() => window.scrollY), scroll);
      assert.equal(await page.locator('.topbar').evaluate(el => el.inert), false);
      await page.locator('#adminPageButton').click(); await page.waitForFunction(() => !document.querySelector('#pauseAfterAttempt').disabled);
      assert.equal(await page.locator('#pauseAfterAttempt').isChecked(), false);
      await page.locator('#pauseAfterAttempt').check(); await page.waitForFunction(() => document.querySelector('#queuePreferenceStatus').textContent.includes('saved'));
      assert.equal(pauseAfterAttempt, true); assert.equal(await page.locator('#queueRecoverySection').isVisible(), false);
      snapshot.version++; snapshot.operation = { id: 'exact-operation', status: 'unknown' }; publish();
      await page.waitForFunction(() => !document.querySelector('#queueRecoverySection').hidden);
      assert.match(await page.locator('#queueDiagnostics').textContent(), /Last observed/);
      page.once('dialog', dialog => dialog.accept()); await page.locator('#queueConfirmRestartButton').click();
      await page.waitForFunction(() => document.querySelector('#queueRecoverySection').hidden);
      assert.equal(commands.at(-1).operationId, 'exact-operation'); assert.equal(snapshot.session.status, 'paused');
      assert.deepEqual(errors, []); assert.equal(entries.length, 3, 'source list unchanged');
      console.log(`PASS ${theme} ${width}px: keyboard edits, two clients, 5000-song picker, repeats/retry, conflict/focus, preview, Admin recovery`);
      await context.close();
    }
    console.log(`Screenshots: ${output}`);
  } finally { await browser.close(); for (const res of subscribers) res.end(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
