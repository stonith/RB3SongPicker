// Optional end-to-end check: real application, SQLite, UDP decoder and SSE.
// Only the Xbox selection transport is fake. No real console or Apple requests.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const dgram = require('node:dgram');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const Database = require('../database');
const ConfigStore = require('../config-store');
const { createApplication } = require('../server');

(async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rb3-queue-e2e-'));
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || undefined });
  let application;
  const sender = dgram.createSocket('udp4');
  try {
    for (const theme of ['default', 'strata']) for (const width of [390, 1280]) {
      const stateDir = path.join(directory, `${theme}-${width}`);
      await fs.mkdir(stateDir);
      const config = new ConfigStore(path.join(stateDir, 'config.json'));
      // Reserve a disposable loopback port. Application binds immediately after it closes.
      const reservation = dgram.createSocket('udp4');
      await new Promise(resolve => reservation.bind(0, '127.0.0.1', resolve));
      const port = reservation.address().port;
      await new Promise(resolve => reservation.close(resolve));
      config.save({ ...config.load(), xboxIp: '127.0.0.1', eventsBindAddress: '127.0.0.1', eventsPort: port, theme });
      const db = new Database(path.join(stateDir, 'songs.sqlite'));
      const picks = [];
      application = createApplication({ db, configStore: config,
        xboxService: { selectSong: async shortname => { picks.push(shortname); return 'OK'; } } });
      await application.initialize();
      await db.promisifyRun("INSERT INTO songs (shortname, title, artist) VALUES ('a', 'Alpha', 'Artist'), ('b', 'Beta', 'Artist'), ('c', 'Charlie', 'Artist')");
      await db.promisifyRun("INSERT INTO songlists (id, name) VALUES (1, 'Tonight')");
      await db.promisifyRun("INSERT INTO songlist_items VALUES (1, 'a'), (1, 'b')");
      const server = await application.listen(0);
      const base = `http://127.0.0.1:${server.address().port}`;
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      await context.route('https://**', route => route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg"/>' }));
      const errors = [];
      const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
      await page.goto(base);
      await page.waitForFunction(() => queueClient.canCommand);
      assert.equal(await page.locator('#startQueueButton').isDisabled(), true);
      await page.locator('#songListSelect').selectOption('1');
      await page.waitForFunction(() => document.querySelector('#startQueueButton').textContent === 'Start queue (2)' && !document.querySelector('#startQueueButton').disabled);
      await page.locator('#searchInput').fill('Beta');
      await page.waitForFunction(() => document.querySelectorAll('#songsTable tbody .song-row').length === 1);
      await page.locator('#startQueueButton').click();
      await page.waitForSelector('#queuePage:not(.hidden)');
      await page.waitForFunction(() => document.querySelectorAll('#queueUpcoming li').length === 2);
      assert.equal(picks.length, 0, 'unknown screen waits');
      const second = await context.newPage(); second.on('pageerror', error => errors.push(error.message));
      await second.goto(base); await second.waitForSelector('#queuePage:not(.hidden)');
      await second.waitForFunction(() => queueClient.canCommand);
      const send = async (type, value) => {
        const payload = type === 1 ? Buffer.from([value]) : Buffer.from(value);
        const packet = Buffer.alloc(8 + payload.length);
        packet.writeUInt32BE(0x52423345); packet[5] = type; packet[6] = payload.length; payload.copy(packet, 8);
        // Wait for actual decoder receipt, not just UDP send completion.
        const listener = application.queueRuntime.listener;
        await new Promise((resolve, reject) => {
          const received = () => { clearTimeout(timer); resolve(); };
          const timer = setTimeout(() => { listener.off('observation', received); reject(new Error('Loopback event not received')); }, 3000);
          listener.once('observation', received);
          sender.send(packet, port, '127.0.0.1', error => {
            if (error) { clearTimeout(timer); listener.off('observation', received); reject(error); }
          });
        });
        await application.queueRuntime.controller.idle();
      };
      await send(9, 'song_select_screen');
      await page.waitForFunction(() => document.querySelector('#queueStatus').textContent.startsWith('Selection requested'));
      assert.deepEqual(picks, ['a']);
      await send(9, 'song_select_screen'); assert.deepEqual(picks, ['a'], 'duplicate screen does not select twice');
      // Add a deliberate repeat while the head is locked, using real API + SSE.
      await second.locator('#queueAddSongsButton').click();
      await second.locator('#queuePickerSearch').fill('Alpha');
      await second.waitForSelector('#queuePickerBody [data-queue-add="a"]');
      await second.locator('#queuePickerBody [data-queue-add="a"]').click();
      await second.waitForFunction(() => document.querySelector('#queuePickerFeedback').textContent.startsWith('Added'));
      await second.locator('#queuePickerDone').click();
      await page.waitForFunction(() => document.querySelectorAll('#queueUpcoming li').length === 2);
      await send(4, 'a'); await send(1, 1);
      await page.waitForFunction(() => document.querySelector('#queueStatus').textContent === 'Playing');
      await page.screenshot({ path: path.join(directory, `${theme}-${width}-playing.png`), fullPage: true });
      // Server remains the owner when the initiating browser closes.
      await page.close();
      await send(1, 0); await send(9, 'song_select_screen');
      await second.waitForFunction(() => document.querySelector('#queueCurrentTitle').textContent === 'Beta');
      assert.deepEqual(picks, ['a', 'b']);
      await send(4, 'b'); await send(1, 1); await send(1, 0); await send(9, 'song_select_screen');
      await second.waitForFunction(() => document.querySelector('#queueCurrentTitle').textContent === 'Alpha');
      assert.deepEqual(picks, ['a', 'b', 'a']);
      await send(4, 'a'); await send(1, 1); await send(1, 0); await send(9, 'song_select_screen');
      await second.waitForFunction(() => document.querySelector('#queueStatus').textContent === 'Queue complete');
      assert.equal((await db.promisifyGet('SELECT COUNT(*) AS n FROM songlist_items WHERE list_id = 1')).n, 2);
      assert.deepEqual(await db.promisifyAll('SELECT shortname, count FROM picks ORDER BY shortname'), [{ shortname: 'a', count: 2 }, { shortname: 'b', count: 1 }]);
      // Starting during already-observed manual gameplay adopts its identity;
      // Stop/Start during the same attempt must retain every pending entry.
      await send(4, 'c'); await send(1, 1);
      const startSavedList = async () => {
        await second.locator('#songsPageButton').click();
        await second.locator('#songListSelect').selectOption('1');
        await second.waitForFunction(() => !document.querySelector('#startQueueButton').disabled);
        await second.locator('#startQueueButton').click();
        await second.waitForSelector('#queuePage:not(.hidden)');
        await second.waitForFunction(() => document.querySelector('#queueStatus').textContent.includes('Unexpected song: c'));
        assert.equal(await second.locator('#queueUpcoming li').count(), 2);
        assert.equal(await second.locator('#queueResumeButton').isDisabled(), true);
      };
      await startSavedList();
      const knownAttempt = application.queueRuntime.game.snapshot().attempt.id;
      assert.equal((await application.queueRuntime.store.read()).session.currentAttempt.id, knownAttempt);
      await second.locator('#queueStopButton').click();
      await second.waitForFunction(() => document.querySelector('#queueStatus').textContent === 'Queue stopped');
      await startSavedList();
      assert.equal((await application.queueRuntime.store.read()).session.currentAttempt.id, knownAttempt);
      await send(1, 0); await send(9, 'song_select_screen');
      await second.waitForFunction(() => !document.querySelector('#queueResumeButton').disabled);
      assert.equal(await second.locator('#queueUpcoming li').count(), 2);
      assert.deepEqual(picks, ['a', 'b', 'a']);
      await second.screenshot({ path: path.join(directory, `${theme}-${width}-manual-ended.png`), fullPage: true });
      // A real SQLite failure after selection preserves its known return and
      // lifecycle backlog. Recover via the shipped Admin action, not a test seam.
      await db.promisifyRun("CREATE TRIGGER fail_pick BEFORE INSERT ON picks BEGIN SELECT RAISE(ABORT, 'browser storage failed'); END");
      await second.locator('#queueResumeButton').click();
      await application.queueRuntime.controller.idle();
      await second.waitForFunction(() => queueClient.diagnostics.inhibited === true);
      await send(4, 'a'); await send(1, 1); await send(1, 0);
      await second.locator('#queueRecoveryAdminButton').click();
      await second.waitForSelector('#adminPage:not(.hidden)');
      await second.locator('#queueReconcileStorageButton').click();
      await second.waitForFunction(() => document.querySelector('#queueStorageRecoveryStatus').textContent.includes('browser storage failed'));
      assert.equal(await second.locator('#queueReconcileStorageButton').isDisabled(), false);
      assert.deepEqual(picks, ['a', 'b', 'a', 'a']);
      await second.screenshot({ path: path.join(directory, `${theme}-${width}-storage-failed.png`), fullPage: true });
      await db.promisifyRun('DROP TRIGGER fail_pick');
      await second.locator('#queueReconcileStorageButton').focus();
      await second.locator('#queueReconcileStorageButton').press('Enter');
      await second.waitForFunction(() => document.querySelector('#queueStorageRecoveryStatus').textContent.startsWith('Storage reconciled'));
      assert.equal(await second.locator('#queueStorageRecoverySection').isHidden(), true);
      assert.equal(await second.locator('#queueStorageRecoveryStatus').evaluate(node => node === document.activeElement), true);
      const recovered = await application.queueRuntime.store.read();
      assert.equal(recovered.session.status, 'paused');
      assert.deepEqual(recovered.session.entries.map(entry => entry.status), ['handled', 'pending']);
      assert.equal(recovered.operation, null);
      assert.equal(application.queueRuntime.game.snapshot().canSelect, false);
      assert.deepEqual(picks, ['a', 'b', 'a', 'a']);
      assert.equal((await db.promisifyGet("SELECT count FROM picks WHERE shortname = 'a'")).count, 3);
      await second.screenshot({ path: path.join(directory, `${theme}-${width}-storage-recovered.png`), fullPage: true });
      await second.locator('#queuePageButton').click();
      await second.locator('#queueResumeButton').click();
      await second.waitForFunction(() => document.querySelector('#queueStatus').textContent === 'Waiting for song selection');
      assert.deepEqual(picks, ['a', 'b', 'a', 'a']);
      await send(9, 'song_select_screen');
      assert.deepEqual(picks, ['a', 'b', 'a', 'a', 'b']);
      assert.deepEqual(errors, []);
      console.log(`PASS real app ${theme} ${width}px: UDP → selection/attempts → SQLite/SSE → two browsers, repeat, browser closure, completion, manual Start/Stop/Start, storage failure/reconciliation, no redispatch, keyboard recovery focus`);
      await context.close(); await application.close(); application = null;
    }
    console.log(`Screenshots and temporary state: ${directory}`);
  } finally {
    await browser.close();
    await application?.close();
    await new Promise(resolve => sender.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
