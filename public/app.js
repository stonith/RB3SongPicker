const state = {
  currentPage: 'songs',
  queueViewChosen: false,
  queueJoined: false,
  queueSeedCount: null,
  queueSeedRequestId: 0,
  songs: [],
  songLists: [],
  selectedListId: '',
  searchText: '',
  sortBy: 'title',
  sortOrder: 'asc',
  editingList: null,
  showSongListManagement: false,
  showDuplicateFilterButton: false,
  showShortnameColumn: false,
  showExportCsvButton: false,
  filterDuplicates: false,
  saving: false,
  loading: false,
  virtualStart: 0,
  virtualEnd: 0,
  songsRequestId: 0,
  previewEnabled: false,
  previewCountry: 'US',
  theme: 'default',
  adminPinEnabled: false,
  adminUnlocked: false
};

const VIRTUAL_OVERSCAN = 12;
const SEARCH_DEBOUNCE_MS = 250;
let searchDebounceTimer;
let virtualRenderFrame;
let previewVisibleTimer;
let previewLookupId = 0;

const elements = {
  xboxIp: document.getElementById('xboxIp'),
  xboxPort: document.getElementById('xboxPort'),
  saveConfigButton: document.getElementById('saveConfigButton'),
  defaultTheme: document.getElementById('defaultTheme'),
  strataThemeStylesheet: document.getElementById('strataThemeStylesheet'),
  adminPin: document.getElementById('adminPin'),
  adminPinHint: document.getElementById('adminPinHint'),
  saveAdminPinButton: document.getElementById('saveAdminPinButton'),
  clearAdminPinButton: document.getElementById('clearAdminPinButton'),
  adminPinDialog: document.getElementById('adminPinDialog'),
  adminPinForm: document.getElementById('adminPinForm'),
  adminPinEntry: document.getElementById('adminPinEntry'),
  adminPinError: document.getElementById('adminPinError'),
  cancelAdminPinButton: document.getElementById('cancelAdminPinButton'),
  refreshButton: document.getElementById('refreshButton'),
  enablePreviews: document.getElementById('enablePreviews'),
  previewCountry: document.getElementById('previewCountry'),
  previewNegativeDays: document.getElementById('previewNegativeDays'),
  savePreviewsButton: document.getElementById('savePreviewsButton'),
  previewProgress: document.getElementById('previewProgress'),
  previewAudio: document.getElementById('previewAudio'),
  previewAnnouncement: document.getElementById('previewAnnouncement'),
  previewAttribution: document.getElementById('previewAttribution'),
  previewStoreLink: document.getElementById('previewStoreLink'),
  showListManagement: document.getElementById('showListManagement'),
  showDuplicateFilterButton: document.getElementById('showDuplicateFilterButton'),
  showShortnameColumn: document.getElementById('showShortnameColumn'),
  showExportCsvButton: document.getElementById('showExportCsvButton'),
  duplicateFilterButton: document.getElementById('duplicateFilterButton'),
  exportCsvButton: document.getElementById('exportCsvButton'),
  qrImage: document.getElementById('qrImage'),
  appVersion: document.getElementById('appVersion'),
  searchInput: document.getElementById('searchInput'),
  randomButton: document.getElementById('randomButton'),
  randomMenuButton: document.getElementById('randomMenuButton'),
  randomMenu: document.getElementById('randomMenu'),
  randomUnpopularButton: document.getElementById('randomUnpopularButton'),
  randomPopularButton: document.getElementById('randomPopularButton'),
  songListSelect: document.getElementById('songListSelect'),
  newListButton: document.getElementById('newListButton'),
  editListButton: document.getElementById('editListButton'),
  deleteListButton: document.getElementById('deleteListButton'),
  listEditor: document.getElementById('listEditor'),
  songTableWrapper: document.getElementById('songTableWrapper'),
  gotoControls: document.getElementById('gotoControls'),
  gotoToggle: document.getElementById('gotoToggle'),
  gotoTop: document.getElementById('gotoTop'),
  gotoUp: document.getElementById('gotoUp'),
  gotoDown: document.getElementById('gotoDown'),
  gotoBottom: document.getElementById('gotoBottom'),
  listName: document.getElementById('listName'),
  saveListButton: document.getElementById('saveListButton'),
  cancelListButton: document.getElementById('cancelListButton'),
  sortButtons: document.getElementById('sortButtons'),
  songsTableBody: document.querySelector('#songsTable tbody'),
  summaryText: document.getElementById('summaryText'),
  managementActions: document.getElementById('managementActions'),
  pageButtons: {
    songs: document.getElementById('songsPageButton'),
    queue: document.getElementById('queuePageButton'),
    admin: document.getElementById('adminPageButton')
  },
  pages: {
    songs: document.getElementById('songsPage'),
    queue: document.getElementById('queuePage'),
    admin: document.getElementById('adminPage')
  },
  tableHeaders: Array.from(document.querySelectorAll('th.sortable'))
};

const previewPlayer = new PreviewPlayer(elements.previewAudio, renderPreviewState);
const queueElements = Object.fromEntries([
  'queuePage', 'queueSource', 'queueStatus', 'queueSyncStatus', 'queueWarning', 'queueProgress',
  'queueCurrent', 'queueCurrentTitle', 'queueCurrentArtist', 'queueCurrentLabel', 'queueControls',
  'queuePauseButton', 'queueResumeButton', 'queueSkipButton', 'queueStopButton', 'queueControlHint',
  'queueActionStatus', 'queueRetryButton', 'queueUpcoming', 'queueEmpty', 'queueTerminalHint', 'queuePreviewAttribution', 'queuePreviewStoreLink',
  'queueCompactStatus', 'queueCompactText', 'openQueueButton', 'startQueueButton', 'queueStartHint', 'queueManualHint',
  'queueAddSongsButton', 'queuePicker', 'queuePickerTitle', 'queuePickerDone', 'queuePickerSearch', 'queuePickerList', 'queuePickerSummary',
  'queuePickerFeedback', 'queuePickerRetry', 'queuePickerScroller', 'queuePickerBody', 'queuePickerAttribution', 'queuePickerStoreLink',
  'pauseAfterAttempt', 'queuePreferenceStatus', 'queueDiagnostics', 'queueRecoverySection', 'queueRecoveryOperation',
  'queueRecoveryAdminButton', 'queueConfirmRestartButton', 'queueRecoveryStatus', 'queueAdminActionStatus', 'queueAdminRetryButton',
  'queueStorageRecoverySection', 'queueReconcileStorageButton', 'queueStorageRecoveryStatus'
].map(id => [id, document.getElementById(id)]));
let queueStorageRecovering = false;
const queueClient = new SessionQueue.QueueClient({ onChange: renderQueue });
const queuePicker = new QueuePicker.PickerModel({ client: queueClient, onChange: renderQueuePicker });
let pickerOpen = false;
let pickerReturnFocus;
let pickerWindowScroll = 0;
let pickerSearchTimer;
let pickerPreviewTimer;
let pickerRange = { start: -1, end: -1 };
let pickerSongs = null;
let queuePreferenceRequestId = 0;
let queuePreferenceSaving = false;
let queuePreviewTimer;
const queuePreviewCache = new QueuePreviews.QueuePreviewCache({ onChange: renderQueuePreviews });

function scheduleQueuePreviewLookup() {
  if (!state.previewEnabled || queuePreviewTimer) return;
  queuePreviewTimer = setTimeout(() => {
    queuePreviewTimer = null;
    queuePreviewCache.refresh(QueuePreviews.queuePreviewSongs(queueClient.snapshot)).catch(() => {
      // Cached preview availability must never block shared queue actions.
    });
  }, 100);
}

function renderQueuePreviews() {
  const model = SessionQueue.describeQueue(queueClient.snapshot);
  const entries = new Map(model.upcoming.map(song => [song.id, song]));
  const rows = [[queueElements.queueCurrent, model.current], ...Array.from(queueElements.queueUpcoming.children)
    .map(row => [row, entries.get(row.dataset.entryId)])];
  for (const [row, song] of rows) {
    let button = row.querySelector?.('.queue-preview-button');
    if (!song || !state.previewEnabled) {
      if (button) button.hidden = true;
      row.classList.remove('preview-active'); row.classList.remove('preview-last');
      continue;
    }
    row.dataset.shortname = song.shortname;
    if (!button) {
      button = document.createElement('button'); button.type = 'button';
      button.className = 'small-button secondary queue-preview-button';
      button.addEventListener('click', () => {
        const current = QueuePreviews.queuePreviewSongs(queueClient.snapshot).find(item => item.shortname === row.dataset.shortname);
        const preview = queuePreviewCache.get(row.dataset.shortname);
        if (current && preview?.status === 'matched') previewPlayer.play({ ...current, preview });
      });
      (row.querySelector('.queue-entry-controls') || row).append(button);
    }
    const preview = queuePreviewCache.get(song.shortname);
    const available = preview?.status === 'matched';
    const selected = previewPlayer.state.song?.shortname === song.shortname;
    const stoppable = selected && ['loading', 'playing'].includes(previewPlayer.state.status);
    button.hidden = false; button.disabled = !available;
    queueText(button, available ? stoppable ? 'Stop' : 'Preview' : ['unavailable', 'ambiguous'].includes(preview?.status) ? 'No clip' : 'Queued');
    button.title = available ? `${stoppable ? 'Stop preview of' : 'Preview'} ${song.title || song.shortname}`
      : button.textContent === 'No clip' ? 'No confident preview match available' : 'Preview matching is pending';
    button.setAttribute('aria-label', button.title);
    button.setAttribute('aria-pressed', String(Boolean(stoppable)));
    row.classList.toggle('preview-active', selected && ['loading', 'playing', 'paused'].includes(previewPlayer.state.status));
    row.classList.toggle('preview-last', selected && !['loading', 'playing', 'paused'].includes(previewPlayer.state.status));
  }
}

function queueText(element, text) {
  if (element.textContent !== text) element.textContent = text;
}

function manualSelectionReason() {
  if (queueClient.pendingCommand?.type === 'start') return 'Queue Start is pending or its result is unknown. Resolve it with Retry before manual selection.';
  if (!queueClient.synchronized) return 'Shared queue synchronization is unavailable. Pick and Random are disabled until resynchronized.';
  return SessionQueue.describeQueue(queueClient.snapshot, queueClient.diagnostics).manualBlocked;
}

function updateManualSelection() {
  const reason = manualSelectionReason();
  queueElements.queueManualHint.hidden = !reason;
  queueText(queueElements.queueManualHint, reason);
  for (const button of [elements.randomButton, elements.randomMenuButton, elements.randomPopularButton,
    elements.randomUnpopularButton, ...elements.songsTableBody.querySelectorAll('[data-manual-pick]')]) {
    button.disabled = !!reason;
    button.title = reason;
  }
  if (reason) closeRandomMenu();
}

function renderQueueStart() {
  const list = state.songLists.find(item => String(item.id) === state.selectedListId);
  const details = SessionQueue.startQueueDetails(list, state.queueSeedCount);
  const active = SessionQueue.describeQueue(queueClient.snapshot).active;
  queueElements.startQueueButton.disabled = !details.enabled || !queueClient.canCommand || active || !!state.editingList;
  queueText(queueElements.startQueueButton, details.enabled ? `Start queue (${details.count})` : 'Start queue');
  queueText(queueElements.queueStartHint, active ? 'Stop the current queue before starting another. Saved-list edits do not change this session.'
    : state.editingList ? 'Save or cancel saved-list editing before starting a queue.' : details.text);
}

async function loadQueueSeedCount() {
  const requestId = ++state.queueSeedRequestId;
  state.queueSeedCount = null;
  renderQueueStart();
  if (!state.selectedListId) return;
  try {
    const data = await apiFetch(`/api/songs?listId=${encodeURIComponent(state.selectedListId)}`);
    if (requestId !== state.queueSeedRequestId) return;
    state.queueSeedCount = data.songs.length;
    renderQueueStart();
  } catch {
    if (requestId === state.queueSeedRequestId) queueText(queueElements.queueStartHint, 'Cannot check full-list membership. Select the list again to retry.');
  }
}

function renderQueue() {
  const snapshot = queueClient.snapshot;
  const session = snapshot?.session;
  const model = SessionQueue.describeQueue(snapshot, queueClient.diagnostics);
  if (snapshot && queueClient.synchronized && !state.queueJoined) {
    state.queueJoined = true;
    if (model.active && !state.queueViewChosen) setPage('queue', true);
  }
  queueText(queueElements.queueSource, session ? `From ${session.sourceList.name} · independent session queue` : 'Start from a saved Song List in Songs.');
  queueText(queueElements.queueStatus, model.label);
  queueText(queueElements.queueSyncStatus, queueClient.synchronized
    ? 'Shared queue is up to date. Execution continues with this browser closed.'
    : 'Shared queue synchronization unavailable. Controls disabled; reconnecting…');
  queueElements.queueWarning.hidden = !model.warning;
  queueText(queueElements.queueWarning, model.warning);
  queueText(queueElements.queueProgress, session ? model.progress : '');
  queueElements.queueCurrent.hidden = !model.current;
  if (model.current) {
    queueText(queueElements.queueCurrentLabel, session.currentAttempt ? 'Playing attempt · Locked' : 'Current · Locked');
    queueText(queueElements.queueCurrentTitle, model.current.title || model.current.shortname);
    queueText(queueElements.queueCurrentArtist, model.current.artist || '—');
  }
  queueElements.queueControls.hidden = !model.active;
  queueElements.queuePauseButton.hidden = session?.status !== 'running';
  queueElements.queueResumeButton.hidden = session?.status !== 'paused';
  for (const button of [queueElements.queuePauseButton, queueElements.queueResumeButton, queueElements.queueSkipButton, queueElements.queueStopButton]) button.disabled = !queueClient.canCommand;
  queueElements.queueResumeButton.disabled ||= !!model.resumeBlocked;
  queueElements.queueResumeButton.title = model.resumeBlocked || 'Resume retains pending entries and waits for song selection.';
  queueElements.queueSkipButton.disabled ||= !session?.entries.some(entry => entry.status === 'pending');
  queueText(queueElements.queueSkipButton, session?.currentAttempt?.skipRequested ? 'Skip after attempt' : 'Skip');
  queueText(queueElements.queueControlHint, model.active ? model.resumeBlocked || (session?.currentAttempt
    ? 'Pause and Stop do not interrupt gameplay. Skip takes effect at the attempt boundary.'
    : 'Resume waits for observed song selection. Players start gameplay.') : '');
  queueElements.queueRetryButton.hidden = !queueClient.pendingCommand || queueClient.busy;
  queueElements.queueRetryButton.disabled = !queueClient.synchronized || queueClient.busy;
  queueElements.queueAdminRetryButton.hidden = !queueClient.pendingCommand || queueClient.busy;
  queueElements.queueAdminRetryButton.disabled = !queueClient.synchronized || queueClient.busy;
  queueText(queueElements.queueAdminActionStatus, queueClient.pendingCommand ? queueClient.busy ? 'Applying shared queue action…' : 'Result unknown — Retry the original queue action before another command.' : '');
  // Keep nodes keyed by independent entry ID. Remote status packets never replace
  // the workspace or browser rows, preserving focus and scroll for participants.
  const focusedEntry = document.activeElement?.closest?.('#queueUpcoming li');
  const focusedControl = document.activeElement;
  const existing = new Map(Array.from(queueElements.queueUpcoming.children).map(row => [row.dataset.entryId, row]));
  model.upcoming.forEach((entry, index) => {
    let row = existing.get(entry.id);
    if (!row) {
      row = document.createElement('li'); row.dataset.entryId = entry.id; row.tabIndex = -1;
      const title = document.createElement('strong');
      const artist = document.createElement('span'); artist.className = 'hint';
      const controls = document.createElement('div'); controls.className = 'queue-entry-controls';
      for (const [icon, label, action] of [['↑', 'Move up', () => moveQueueEntry(entry.id, -1)], ['↓', 'Move down', () => moveQueueEntry(entry.id, 1)], ['−', 'Remove', () => removeQueueEntry(entry.id)]]) {
        const button = document.createElement('button'); button.type = 'button'; button.className = 'small-button secondary';
        button.textContent = icon; button.title = label; button.setAttribute('aria-label', `${label}: ${entry.title || entry.shortname}`);
        button.addEventListener('click', action); controls.append(button);
      }
      row.append(title, artist, controls);
    }
    queueText(row.children[0], entry.title || entry.shortname);
    queueText(row.children[1], entry.artist || '—');
    const buttons = row.children[2].children;
    buttons[0].disabled = !model.active || !queueClient.canCommand || index === 0;
    buttons[1].disabled = !model.active || !queueClient.canCommand || index === model.upcoming.length - 1;
    buttons[2].disabled = !model.active || !queueClient.canCommand;
    if (queueElements.queueUpcoming.children[index] !== row) queueElements.queueUpcoming.insertBefore(row, queueElements.queueUpcoming.children[index] || null);
    existing.delete(entry.id);
  });
  for (const row of existing.values()) row.remove();
  if (focusedEntry && document.activeElement === document.body) {
    if (focusedControl.isConnected && !focusedControl.disabled) focusedControl.focus({ preventScroll: true });
    else if (focusedEntry.isConnected) focusedEntry.focus({ preventScroll: true });
    else queueElements.queueStatus.focus({ preventScroll: true });
  }
  queueElements.queueEmpty.hidden = model.upcoming.length > 0;
  queueText(queueElements.queueEmpty, model.active ? 'No upcoming entries. Current gameplay or an unresolved request must finish before queue completion.' : 'No upcoming entries.');
  queueElements.queueTerminalHint.hidden = model.active;
  queueElements.queueCompactStatus.classList.toggle('hidden', state.currentPage === 'queue' || (!session && !snapshot?.operation));
  queueText(queueElements.queueCompactText, `${session?.sourceList.name || 'Console request'} · ${model.label}`);
  queueText(elements.pageButtons.queue, `Queue${model.active ? ` (${session.entries.filter(entry => entry.status === 'pending').length})` : ''}`);
  queueElements.queueAddSongsButton.hidden = !model.active;
  queueElements.queueAddSongsButton.disabled = !queueClient.synchronized;
  const operationId = SessionQueue.recoveryOperationId(snapshot);
  queueElements.queueRecoveryAdminButton.hidden = !operationId && !queueClient.diagnostics.inhibited;
  queueElements.queueStorageRecoverySection.hidden = !queueClient.diagnostics.inhibited;
  queueElements.queueReconcileStorageButton.disabled = queueStorageRecovering;
  queueElements.queueRecoverySection.hidden = !operationId;
  queueElements.queueConfirmRestartButton.dataset.operationId = operationId || '';
  queueElements.queueConfirmRestartButton.disabled = !queueClient.canCommand || !!queueClient.diagnostics.inhibited;
  queueText(queueElements.queueRecoveryOperation, operationId ? `Unresolved request: ${operationId}` : '');
  queueText(queueElements.queueDiagnostics, SessionQueue.describeDiagnostics(queueClient.diagnostics));
  renderQueueStart();
  updateManualSelection();
  renderQueuePreviews();
  scheduleQueuePreviewLookup();
  renderQueuePicker();
}

async function runQueueAction(type, fields = {}, retry = false) {
  if (type === 'stop' && queueClient.snapshot?.operation && !confirm('Stop prevents future selections, but an already-sent console request cannot be withdrawn. Stop the queue?')) return;
  if (type === 'start' || type === 'resume') previewPlayer.stop();
  queueText(queueElements.queueActionStatus, 'Applying queue action…');
  try {
    await (retry ? queueClient.retry() : queueClient.command(type, fields));
    queueText(queueElements.queueActionStatus, type === 'start' ? 'Queue started from the full saved list.' : 'Queue action accepted.');
    if (type === 'start') setPage('queue', true);
    return true;
  } catch (error) {
    queueText(queueElements.queueActionStatus, error.unknown ? 'Result unknown — Retry uses the original action identity and cannot duplicate it.'
      : `Action not applied: ${error.message} Shared state is current; review it before trying again.`);
  }
  renderQueue();
}

async function moveQueueEntry(entryId, direction) {
  const row = Array.from(queueElements.queueUpcoming.children).find(node => node.dataset.entryId === entryId);
  const hadFocus = row?.contains?.(document.activeElement);
  const controlIndex = hadFocus ? Array.from(row.children[2].children).indexOf(document.activeElement) : -1;
  try {
    const entryIds = SessionQueue.moveEntryOrder(queueClient.snapshot, entryId, direction);
    await runQueueAction('reorder', { entryIds });
  } catch (error) { queueText(queueElements.queueActionStatus, `Move not applied: ${error.message}`); }
  if (hadFocus && (document.activeElement === document.body || document.activeElement === row)) {
    const currentRow = Array.from(queueElements.queueUpcoming.children).find(node => node.dataset.entryId === entryId);
    const preferred = currentRow?.children[2].children[controlIndex];
    const target = preferred && !preferred.disabled ? preferred : currentRow?.querySelector('button:not(:disabled)');
    (target || queueElements.queueStatus).focus({ preventScroll: true });
  }
}

async function removeQueueEntry(entryId) {
  const row = Array.from(queueElements.queueUpcoming.children).find(node => node.dataset.entryId === entryId);
  const hadFocus = row?.contains(document.activeElement);
  const index = row ? Array.from(queueElements.queueUpcoming.children).indexOf(row) : -1;
  if (await runQueueAction('remove', { entryId })) {
    if (hadFocus && (document.activeElement === document.body || document.activeElement === queueElements.queueStatus)) {
      const next = queueElements.queueUpcoming.children[Math.max(0, index - 1)];
      (next?.querySelector('button:not(:disabled)') || (queueElements.queueAddSongsButton.hidden ? queueElements.queueStatus : queueElements.queueAddSongsButton)).focus({ preventScroll: true });
    }
  }
}

function retryQueueAction() {
  if (queueClient.pendingCommand?.type === 'add') return queuePicker.retry();
  return runQueueAction(queueClient.pendingCommand?.type, {}, true);
}

async function loadQueuePreferences() {
  if (queuePreferenceSaving) return;
  const requestId = ++queuePreferenceRequestId;
  queueElements.pauseAfterAttempt.disabled = true;
  try {
    const data = await apiFetch('/api/queue/preferences');
    if (requestId !== queuePreferenceRequestId) return;
    queueElements.pauseAfterAttempt.checked = data.pauseAfterAttempt === true;
    queueElements.pauseAfterAttempt.disabled = false;
    queueText(queueElements.queuePreferenceStatus, 'Policy applies at the start of each attempt.');
  } catch (error) {
    if (requestId === queuePreferenceRequestId) queueText(queueElements.queuePreferenceStatus, `Cannot load queue preference: ${error.message}. Reopen Admin to retry.`);
  }
}

async function saveQueuePreferences() {
  ++queuePreferenceRequestId;
  queuePreferenceSaving = true;
  queueElements.pauseAfterAttempt.disabled = true;
  try {
    const data = await apiFetch('/api/queue/preferences', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pauseAfterAttempt: queueElements.pauseAfterAttempt.checked }) });
    queueElements.pauseAfterAttempt.checked = data.pauseAfterAttempt === true;
    queueText(queueElements.queuePreferenceStatus, 'Queue preference saved. Current attempts keep their original policy.');
  } catch (error) {
    queueText(queueElements.queuePreferenceStatus, `Save result unknown: ${error.message}. Reopen Admin to check the saved policy.`);
    return;
  } finally { queuePreferenceSaving = false; }
  queueElements.pauseAfterAttempt.disabled = false;
}

async function reconcileQueueStorage() {
  if (queueStorageRecovering) return;
  const hadFocus = document.activeElement === queueElements.queueReconcileStorageButton;
  queueStorageRecovering = true;
  queueText(queueElements.queueStorageRecoveryStatus, 'Reconciling retained queue state…');
  renderQueue();
  try {
    const response = await fetch('/api/queue/storage/reconcile', { method: 'POST' });
    const body = await response.json();
    if (body.diagnostics) queueClient.diagnostics = body.diagnostics;
    if (body.snapshot) queueClient.accept(body.snapshot);
    if (!response.ok) throw new Error(body.error || 'Storage remains unavailable.');
    queueText(queueElements.queueStorageRecoveryStatus, 'Storage reconciled. Queue remains paused; wait for a new song-selection observation and explicitly Resume. Any unresolved console request remains quarantined.');
  } catch (error) {
    queueText(queueElements.queueStorageRecoveryStatus, `Storage recovery not confirmed: ${error.message}. Restore storage and try Reconcile queue storage again; no console request is resent.`);
  } finally {
    queueStorageRecovering = false;
    renderQueue();
    if (hadFocus && (document.activeElement === document.body || document.activeElement === queueElements.queueReconcileStorageButton)) {
      (queueElements.queueStorageRecoverySection.hidden ? queueElements.queueStorageRecoveryStatus : queueElements.queueReconcileStorageButton).focus({ preventScroll: true });
    }
  }
}

async function confirmConsoleRestarted() {
  const operationId = queueElements.queueConfirmRestartButton.dataset.operationId;
  if (!operationId || !queueClient.canCommand) return;
  if (!confirm('Have you actually restarted the game/console? This action does not restart it remotely. It clears only this unresolved request and leaves the queue paused awaiting new observations and explicit Resume.')) return;
  const accepted = await runQueueAction('confirm-console-restarted', { operationId });
  queueText(queueElements.queueRecoveryStatus, accepted ? 'Restart confirmed. Queue remains paused; wait for a new song-selection observation and explicitly Resume.' : queueElements.queueActionStatus.textContent);
}

async function addPickerSong(song) {
  const focused = document.activeElement?.dataset.queueAdd === song.shortname;
  await (queuePicker.rowState(song.shortname).retry ? queuePicker.retry() : queuePicker.add(song));
  // Disabling a pending Add blurs it in browsers. Restore only local action
  // focus, never a participant's newer choice or a remote mutation's focus.
  if (focused && pickerOpen && (document.activeElement === document.body || document.activeElement?.dataset.queueAdd === song.shortname)) {
    const button = Array.from(queueElements.queuePickerBody.querySelectorAll('[data-queue-add]')).find(node => node.dataset.queueAdd === song.shortname);
    if (button && !button.disabled) button.focus({ preventScroll: true });
  }
}

function updatePickerAddButton(button) {
  const shortname = button.dataset.queueAdd;
  const model = queuePicker.rowState(shortname);
  queueText(button, model.label);
  button.disabled = model.disabled;
  const song = queuePicker.songs.find(item => item.shortname === shortname);
  button.setAttribute('aria-label', `${model.label}: ${song?.title || shortname}`);
  button.title = model.disabled ? 'Add requires an active synchronized queue with no unresolved action.' : 'Add an independent entry to this session only';
}

function openQueuePicker() {
  if (!SessionQueue.describeQueue(queueClient.snapshot).active) return;
  pickerReturnFocus = document.activeElement;
  pickerWindowScroll = window.scrollY;
  pickerOpen = true;
  queueElements.queuePicker.hidden = false;
  queueElements.queuePage.classList.add('picker-open');
  const options = [new Option('All songs', ''), ...state.songLists.map(list => new Option(list.name, String(list.id)))];
  queueElements.queuePickerList.replaceChildren(...options);
  queueElements.queuePickerList.value = queuePicker.filters.listId;
  if (!queueElements.queuePickerList.value) queuePicker.filters.listId = '';
  queueElements.queuePickerSearch.value = queuePicker.filters.search;
  updatePickerLayout();
  pickerRange.start = -1;
  renderQueuePicker();
  queueElements.queuePickerTitle.focus({ preventScroll: true });
  loadQueuePickerSongs();
}

function closeQueuePicker(restoreFocus = true) {
  clearTimeout(pickerSearchTimer);
  queuePicker.filters = { search: queueElements.queuePickerSearch.value, listId: queueElements.queuePickerList.value };
  pickerOpen = false;
  queueElements.queuePicker.hidden = true;
  queueElements.queuePage.classList.remove('picker-open');
  updatePickerLayout();
  if (restoreFocus) {
    window.scrollTo(0, pickerWindowScroll);
    (pickerReturnFocus?.isConnected && !pickerReturnFocus.disabled && !pickerReturnFocus.hidden ? pickerReturnFocus : elements.pageButtons.queue).focus({ preventScroll: true });
  }
}

function updatePickerLayout() {
  const wasModal = queueElements.queuePicker.getAttribute('aria-modal') === 'true';
  const modal = pickerOpen && !window.matchMedia('(min-width: 1120px)').matches;
  queueElements.queuePicker.setAttribute('role', modal ? 'dialog' : 'region');
  if (modal) queueElements.queuePicker.setAttribute('aria-modal', 'true');
  else queueElements.queuePicker.removeAttribute('aria-modal');
  document.body.classList.toggle('queue-picker-modal', modal);
  if (pickerOpen) {
    const viewport = window.visualViewport;
    const height = modal ? viewport?.height || window.innerHeight
      : window.innerHeight - Math.max(16, queueElements.queuePicker.getBoundingClientRect().top) - 16;
    queueElements.queuePicker.style.height = `${Math.max(0, height)}px`;
    queueElements.queuePicker.style.top = modal ? `${viewport?.offsetTop || 0}px` : '';
  } else {
    queueElements.queuePicker.style.height = '';
    queueElements.queuePicker.style.top = '';
  }
  for (const node of document.querySelectorAll('.app-shell > :not(#queuePage), .queue-workspace')) node.inert = modal;
  if (modal && !wasModal && !queueElements.queuePicker.contains(document.activeElement)) queueElements.queuePickerTitle.focus({ preventScroll: true });
}

function handlePickerKeydown(event) {
  if (event.key === 'Escape') { event.preventDefault(); closeQueuePicker(); return; }
  if (event.key !== 'Tab' || queueElements.queuePicker.getAttribute('aria-modal') !== 'true') return;
  const controls = Array.from(queueElements.queuePicker.querySelectorAll('button:not(:disabled), input, select, a[href]')).filter(node => !node.hidden && node.getClientRects().length);
  const first = controls[0]; const last = controls.at(-1);
  if (event.shiftKey && (document.activeElement === first || document.activeElement === queueElements.queuePicker || document.activeElement === queueElements.queuePickerTitle)) { event.preventDefault(); last?.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
}

async function loadQueuePickerSongs() {
  queueElements.queuePickerScroller.scrollTop = 0;
  await queuePicker.load({ search: queueElements.queuePickerSearch.value, listId: queueElements.queuePickerList.value });
  schedulePickerPreviewLookup();
}

function renderQueuePicker() {
  if (!pickerOpen) return;
  const model = SessionQueue.describeQueue(queueClient.snapshot);
  queueText(queueElements.queuePickerSummary, !model.active ? 'Queue ended. Done returns to the queue; start a saved list to add again.'
    : queuePicker.loading ? 'Loading songs…' : queuePicker.loadError || `${queuePicker.songs.length} song${queuePicker.songs.length === 1 ? '' : 's'} · additions never select on the console`);
  queueText(queueElements.queuePickerFeedback, queuePicker.feedback);
  const retry = queueClient.pendingCommand?.type === 'add';
  queueElements.queuePickerRetry.hidden = !retry || queueClient.busy;
  queueElements.queuePickerRetry.disabled = !queueClient.synchronized || queueClient.busy;
  const scroller = queueElements.queuePickerScroller;
  const rowHeight = Number.parseFloat(getComputedStyle(scroller).getPropertyValue('--song-row-height')) || 100;
  const range = VirtualList.calculateRange({ itemCount: queuePicker.songs.length, scrollTop: scroller.scrollTop,
    viewportHeight: scroller.clientHeight, rowHeight, overscan: VIRTUAL_OVERSCAN });
  if (pickerSongs !== queuePicker.songs || range.start !== pickerRange.start || range.end !== pickerRange.end) {
    const active = document.activeElement;
    const focusedSong = active?.dataset.queueAdd || active?.dataset.previewShortname;
    const previewFocused = !!active?.dataset.previewShortname;
    const fragment = document.createDocumentFragment();
    if (range.start) fragment.append(createSpacerRow(range.start * rowHeight));
    for (let index = range.start; index < range.end; index++) fragment.append(createSongRow(queuePicker.songs[index], null, false, true));
    if (range.end < queuePicker.songs.length) fragment.append(createSpacerRow((queuePicker.songs.length - range.end) * rowHeight));
    queueElements.queuePickerBody.replaceChildren(fragment);
    pickerRange = range; pickerSongs = queuePicker.songs;
    if (focusedSong) {
      const selector = previewFocused ? '[data-preview-shortname]' : '[data-queue-add]';
      const replacement = Array.from(queueElements.queuePickerBody.querySelectorAll(selector)).find(button => (button.dataset.queueAdd || button.dataset.previewShortname) === focusedSong);
      if (replacement && !replacement.disabled) replacement.focus({ preventScroll: true });
    }
  }
  for (const button of queueElements.queuePickerBody.querySelectorAll('[data-queue-add]')) updatePickerAddButton(button);
  renderPreviewState(previewPlayer.state);
}

function schedulePickerPreviewLookup() {
  clearTimeout(pickerPreviewTimer);
  if (pickerOpen && state.previewEnabled) pickerPreviewTimer = setTimeout(refreshPickerPreviews, 200);
}

async function refreshPickerPreviews() {
  if (!pickerOpen || !state.previewEnabled || !queuePicker.songs.length) return;
  const requestId = queuePicker.requestId;
  const country = state.previewCountry;
  const shortnames = queuePicker.songs.slice(pickerRange.start, pickerRange.end).map(song => song.shortname);
  try {
    const data = await apiFetch('/api/previews/lookup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ shortnames }) });
    if (requestId !== queuePicker.requestId || country !== state.previewCountry || !state.previewEnabled) return;
    const previews = new Map(data.songs.map(song => [song.shortname, song.preview]));
    let changed = false;
    for (const song of queuePicker.songs) if (previews.has(song.shortname)) {
      const preview = previews.get(song.shortname);
      if (JSON.stringify(song.preview) !== JSON.stringify(preview)) { song.preview = preview; changed = true; }
    }
    if (changed) { pickerRange.start = -1; renderQueuePicker(); }
  } catch { /* Preview availability never blocks a session Add. */ }
}

function startQueue() {
  if (queueElements.startQueueButton.disabled) return;
  runQueueAction('start', { listId: Number(state.selectedListId), sort: state.sortBy, order: state.sortOrder });
}

function updatePreviewRow(row, playback) {
  const selected = state.previewEnabled && playback.song?.shortname === row.dataset.shortname;
  const active = selected && ['loading', 'playing', 'paused'].includes(playback.status);
  row.classList.toggle('preview-active', Boolean(active));
  row.classList.toggle('preview-last', Boolean(selected && !active));
  if (selected) row.setAttribute('aria-current', 'true');
  else row.removeAttribute('aria-current');
  const indicator = row.querySelector('.preview-row-status');
  if (indicator) indicator.textContent = selected
    ? active ? (playback.status === 'paused' ? 'Paused' : 'Previewing')
      : playback.status === 'error' ? 'Preview failed' : 'Last previewed' : '';
  const button = row.querySelector('[data-preview-shortname]');
  if (button) {
    const stoppable = selected && ['playing', 'loading'].includes(playback.status);
    button.textContent = stoppable ? 'Stop' : 'Preview';
    button.setAttribute('aria-pressed', String(Boolean(stoppable)));
    const title = row.querySelector('.title-cell strong').textContent;
    button.title = selected && playback.status === 'error' ? 'Preview failed. Tap to retry.'
      : stoppable ? `Stop preview of ${title}` : `Preview ${title}`;
    button.setAttribute('aria-label', button.title);
  }
}

function renderPreviewState(playback) {
  const song = playback.song;
  // Audio stays outside virtualized rows, but all playback controls live in the
  // list. Only the required store link/credit remains below it, without a box.
  elements.previewAttribution.hidden = !state.previewEnabled || !song;
  if (song) {
    elements.previewStoreLink.href = song.preview.storeUrl;
    const status = {
      loading: 'Loading preview', playing: 'Playing preview', paused: 'Preview paused',
      stopped: 'Preview stopped', finished: 'Preview finished',
      error: 'Preview failed. Check your connection and try again.'
    }[playback.status] || '';
    const announcement = `${status}: ${song.title} — ${song.artist}`;
    if (elements.previewAnnouncement.textContent !== announcement) elements.previewAnnouncement.textContent = announcement;
  } else {
    elements.previewStoreLink.removeAttribute('href');
    elements.previewAnnouncement.textContent = '';
  }
  queueElements.queuePreviewAttribution.hidden = !state.previewEnabled || !song;
  if (song) queueElements.queuePreviewStoreLink.href = song.preview.storeUrl;
  else queueElements.queuePreviewStoreLink.removeAttribute('href');
  renderQueuePreviews();
  queueElements.queuePickerAttribution.hidden = !state.previewEnabled || !song;
  if (song) queueElements.queuePickerStoreLink.href = song.preview.storeUrl;
  else queueElements.queuePickerStoreLink.removeAttribute('href');
  for (const body of [elements.songsTableBody, queueElements.queuePickerBody]) {
    for (const row of body.querySelectorAll('.song-row')) updatePreviewRow(row, playback);
  }
}

async function loadPreviewStatus(syncControls = false) {
  try {
    const data = await apiFetch('/api/previews');
    const changed = state.previewEnabled !== data.enabled || state.previewCountry !== data.country;
    state.previewEnabled = data.enabled;
    state.previewCountry = data.country;
    queuePreviewCache.configure({ enabled: data.enabled, country: data.country });
    scheduleQueuePreviewLookup();
    if (syncControls) {
      elements.enablePreviews.checked = data.enabled;
      elements.previewCountry.value = data.country;
      elements.previewNegativeDays.value = data.negativeDays;
    }
    const counts = data.counts;
    const remaining = (counts.pending || 0) + (counts.processing || 0) + (counts.retry || 0);
    const cooldown = data.cooldownUntil ? ` Cooling down until ${new Date(data.cooldownUntil).toLocaleTimeString()}.` : '';
    elements.previewProgress.textContent = `${data.enabled ? 'Matching enabled' : 'Off / paused'} · ${counts.matched || 0} matched · ${remaining} queued · ${(counts.unavailable || 0) + (counts.ambiguous || 0)} unavailable.${cooldown}`;
    if (changed) {
      previewPlayer.clear();
      for (const song of [...state.songs, ...queuePicker.songs]) song.preview = data.enabled ? { status: 'pending' } : undefined;
      renderSongTable(false, true);
      pickerRange.start = -1; renderQueuePicker(); schedulePickerPreviewLookup();
    }
    return true;
  } catch (error) {
    elements.previewProgress.textContent = `Cannot load preview status: ${error.message}`;
    return false;
  }
}

async function refreshVisiblePreviews() {
  if (!state.previewEnabled || state.currentPage !== 'songs' || !state.songs.length) return;
  const requestId = ++previewLookupId;
  const songsRequestId = state.songsRequestId;
  const country = state.previewCountry;
  const names = state.songs.slice(Math.max(0, state.virtualStart), state.virtualEnd).map(song => song.shortname);
  try {
    const data = await apiFetch('/api/previews/lookup', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ shortnames: names })
    });
    if (requestId !== previewLookupId || songsRequestId !== state.songsRequestId || country !== state.previewCountry || !state.previewEnabled) return;
    const previews = new Map(data.songs.map(song => [song.shortname, song.preview]));
    for (const song of state.songs) if (previews.has(song.shortname)) song.preview = previews.get(song.shortname);
    renderSongTable(false, true);
  } catch { /* Cached browsing and picking remain usable while offline. */ }
}

function schedulePreviewLookup() {
  clearTimeout(previewVisibleTimer);
  previewVisibleTimer = setTimeout(refreshVisiblePreviews, 200);
}

async function savePreviewSettings() {
  elements.savePreviewsButton.disabled = true;
  try {
    await apiFetch('/api/previews', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: elements.enablePreviews.checked,
        country: elements.previewCountry.value.trim().toUpperCase(),
        negativeDays: Number(elements.previewNegativeDays.value) })
    });
    await loadPreviewStatus(true);
    setStatus('Preview settings saved. Cached matches are preserved.');
  } catch (error) {
    elements.previewProgress.textContent = `Cannot save preview settings: ${error.message}`;
  } finally { elements.savePreviewsButton.disabled = false; }
}

async function pollPreviews() {
  if (!document.hidden) {
    await loadPreviewStatus();
    await refreshVisiblePreviews();
    await refreshPickerPreviews();
  }
  setTimeout(pollPreviews, 10000);
}

function setStatus(message, isError = false) {
  const prefix = isError ? '⚠️ ' : '✨ ';
  elements.summaryText.textContent = `${prefix}${message}`;
  elements.summaryText.style.color = isError ? 'var(--st-danger-text)' : 'var(--st-accent-text)';
}

async function apiFetch(url, options = {}) {
  const res = await fetch(url, options);
  if (!res.ok) {
    const errorData = await res.json().catch(() => null);
    const message = errorData?.message || errorData?.error || res.statusText;
    throw new Error(message || 'Request failed');
  }
  return res.json();
}

function renderQrImage() {
  if (!elements.qrImage) return;
  const url = window.location.href;
  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(url)}`;
  elements.qrImage.src = qrUrl;
  elements.qrImage.alt = `Scan to open ${url}`;
}

async function loadVersion() {
  if (!elements.appVersion) return;
  try {
    const { version } = await apiFetch('/api/version');
    elements.appVersion.textContent = version;
  } catch {
    elements.appVersion.textContent = 'development';
  }
}

function applyTheme(theme) {
  state.theme = theme === 'strata' ? 'strata' : 'default';
  document.documentElement.dataset.theme = state.theme;
  elements.strataThemeStylesheet.disabled = state.theme !== 'strata';
  if (elements.defaultTheme) elements.defaultTheme.value = state.theme;
}

async function loadConfig() {
  try {
    const config = await apiFetch('/api/config');
    elements.xboxIp.value = config.xboxIp || '';
    elements.xboxPort.value = config.xboxPort || '';
    state.adminPinEnabled = Boolean(config.adminPinEnabled);
    applyTheme(config.theme);
    updateAdminPinHint();
  } catch (error) {
    setStatus(`Cannot load config: ${error.message}`, true);
  }
}

async function saveTheme() {
  const theme = elements.defaultTheme.value === 'strata' ? 'strata' : 'default';
  try {
    const config = await apiFetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme })
    });
    applyTheme(config.theme);
    setStatus(`Default theme set to ${theme === 'strata' ? 'Strata' : 'Default'}.`);
  } catch (error) {
    elements.defaultTheme.value = state.theme;
    setStatus(`Cannot save theme: ${error.message}`, true);
  }
}

function updateAdminPinHint() {
  elements.adminPinHint.textContent = state.adminPinEnabled
    ? 'PIN is on. Admin will prompt for it when opened.'
    : 'PIN is off. Enter exactly 4 digits to enable the Admin screen prompt.';
}

async function saveAdminPin() {
  const pin = elements.adminPin.value;
  if (!/^[0-9]{4}$/.test(pin)) {
    elements.adminPin.setCustomValidity('Enter exactly 4 digits.');
    elements.adminPin.reportValidity();
    return;
  }
  elements.adminPin.setCustomValidity('');
  try {
    const result = await apiFetch('/api/admin/pin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin })
    });
    state.adminPinEnabled = result.enabled;
    elements.adminPin.value = '';
    updateAdminPinHint();
    setStatus('Admin PIN saved.');
  } catch (error) {
    setStatus(`Cannot save Admin PIN: ${error.message}`, true);
  }
}

async function clearAdminPin() {
  try {
    const result = await apiFetch('/api/admin/pin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: '' })
    });
    state.adminPinEnabled = result.enabled;
    elements.adminPin.value = '';
    updateAdminPinHint();
    setStatus('Admin PIN turned off.');
  } catch (error) {
    setStatus(`Cannot turn off Admin PIN: ${error.message}`, true);
  }
}

function requestAdminPage() {
  if (!state.adminPinEnabled) {
    setPage('admin');
    return;
  }
  elements.adminPinEntry.value = '';
  elements.adminPinError.hidden = true;
  elements.adminPinDialog.classList.remove('hidden');
  elements.adminPinEntry.focus();
}

async function verifyAdminPin(event) {
  event.preventDefault();
  try {
    const result = await apiFetch('/api/admin/pin/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: elements.adminPinEntry.value })
    });
    if (!result.valid) {
      elements.adminPinError.hidden = false;
      elements.adminPinEntry.select();
      return;
    }
    elements.adminPinDialog.classList.add('hidden');
    state.adminUnlocked = true;
    setPage('admin');
  } catch (error) {
    elements.adminPinError.textContent = `Cannot verify PIN: ${error.message}`;
    elements.adminPinError.hidden = false;
  }
}

async function saveConfig() {
  try {
    const xboxIp = elements.xboxIp.value.trim();
    const xboxPort = Number(elements.xboxPort.value.trim()) || 21070;
    await apiFetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ xboxIp, xboxPort })
    });
    setStatus('Server configuration saved.');
  } catch (error) {
    setStatus(`Cannot save config: ${error.message}`, true);
  }
}

async function loadSongLists() {
  try {
    const data = await apiFetch('/api/songlists');
    state.songLists = data.lists || [];
    renderSongListOptions();
    loadQueueSeedCount();
  } catch (error) {
    setStatus(`Cannot load song lists: ${error.message}`, true);
  }
}

async function loadSettings() {
  try {
    const data = await apiFetch('/api/settings');
    state.showSongListManagement = Boolean(data.showSongListManagement);
    state.showDuplicateFilterButton = Boolean(data.showDuplicateFilterButton);
    state.showShortnameColumn = Boolean(data.showShortnameColumn);
    state.showExportCsvButton = Boolean(data.showExportCsvButton);
    elements.showListManagement.checked = state.showSongListManagement;
    elements.showDuplicateFilterButton.checked = state.showDuplicateFilterButton;
    elements.showShortnameColumn.checked = state.showShortnameColumn;
    elements.showExportCsvButton.checked = state.showExportCsvButton;
    renderSongListOptions();
    updateDuplicateFilterButtonVisibility();
    updateShortnameColumnVisibility();
    updateExportButtonVisibility();
  } catch (error) {
    setStatus(`Cannot load settings: ${error.message}`, true);
  }
}

async function saveSettings() {
  try {
    const payload = {
      showSongListManagement: elements.showListManagement.checked,
      showDuplicateFilterButton: elements.showDuplicateFilterButton.checked,
      showShortnameColumn: elements.showShortnameColumn.checked,
      showExportCsvButton: elements.showExportCsvButton.checked
    };
    const data = await apiFetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    state.showSongListManagement = Boolean(data.showSongListManagement);
    state.showDuplicateFilterButton = Boolean(data.showDuplicateFilterButton);
    state.showShortnameColumn = Boolean(data.showShortnameColumn);
    state.showExportCsvButton = Boolean(data.showExportCsvButton);
    renderSongListOptions();
    updateDuplicateFilterButtonVisibility();
    updateShortnameColumnVisibility();
    updateExportButtonVisibility();
    setStatus('Settings saved.');
  } catch (error) {
    setStatus(`Cannot save settings: ${error.message}`, true);
  }
}

function renderSongListOptions() {
  elements.songListSelect.innerHTML = '<option value="">All songs</option>';
  for (const list of state.songLists) {
    const option = document.createElement('option');
    option.value = list.id;
    option.textContent = `${list.name} (${list.songCount})`;
    elements.songListSelect.append(option);
  }
  elements.songListSelect.value = state.selectedListId;
  const hasSelected = state.songLists.some((list) => String(list.id) === state.selectedListId);
  elements.editListButton.disabled = !hasSelected;
  elements.deleteListButton.disabled = !hasSelected;
  elements.managementActions.classList.toggle('hidden', !state.showSongListManagement);
  if (!state.showSongListManagement) {
    elements.listEditor.classList.add('hidden');
    state.editingList = null;
  }
  renderQueueStart();
}

function updateDuplicateFilterButtonVisibility() {
  if (!elements.duplicateFilterButton) return;

  if (state.showDuplicateFilterButton) {
    elements.duplicateFilterButton.classList.remove('hidden');
    elements.duplicateFilterButton.style.display = '';
  } else {
    elements.duplicateFilterButton.classList.add('hidden');
    elements.duplicateFilterButton.style.display = 'none';
    state.filterDuplicates = false;
    elements.duplicateFilterButton.classList.remove('active');
  }
}

function updateShortnameColumnVisibility() {
  if (!elements.songTableWrapper) return;
  elements.songTableWrapper.classList.toggle('shortname-enabled', state.showShortnameColumn);
}

function updateExportButtonVisibility() {
  if (!elements.exportCsvButton) return;
  if (state.showExportCsvButton) {
    elements.exportCsvButton.classList.remove('hidden');
    elements.exportCsvButton.style.display = '';
  } else {
    elements.exportCsvButton.classList.add('hidden');
    elements.exportCsvButton.style.display = 'none';
  }
}

function escapeCsvValue(value) {
  const text = String(value ?? '');
  return `"${text.replace(/"/g, '""')}"`;
}

function exportVisibleGridToCsv() {
  if (!state.songs.length) {
    setStatus('No songs available to export.', true);
    return;
  }

  const columnDefs = [
    { key: 'title', label: 'Title', selector: 'th[data-sort="title"]' },
    { key: 'artist', label: 'Artist', selector: 'th[data-sort="artist"]' },
    { key: 'album', label: 'Album', selector: 'th[data-sort="album"]' },
    { key: 'origin', label: 'Origin', selector: 'th[data-sort="origin"]' },
    { key: 'shortname', label: 'Shortname', selector: 'th.shortname-column' }
  ];

  const visibleColumns = columnDefs.filter((column) => {
    const header = document.querySelector(column.selector);
    return header && window.getComputedStyle(header).display !== 'none';
  });

  if (!visibleColumns.length) {
    setStatus('No visible columns available to export.', true);
    return;
  }

  const rows = [
    visibleColumns.map((column) => escapeCsvValue(column.label)).join(','),
    ...state.songs.map((song) =>
      visibleColumns.map((column) => escapeCsvValue(song[column.key] || '')).join(',')
    )
  ];

  const csv = rows.join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const downloadLink = document.createElement('a');
  downloadLink.href = URL.createObjectURL(blob);
  downloadLink.download = `rb3-songs-${timestamp}.csv`;
  document.body.append(downloadLink);
  downloadLink.click();
  downloadLink.remove();
  URL.revokeObjectURL(downloadLink.href);
  setStatus(`Exported ${state.songs.length} songs to CSV.`);
}

async function loadSongs(resetScroll = true) {
  renderQueueStart();
  const requestId = ++state.songsRequestId;
  state.loading = true;
  try {
    const params = new URLSearchParams();
    if (state.searchText) params.set('search', state.searchText);
    params.set('sort', state.sortBy);
    params.set('order', state.sortOrder);
    if (state.selectedListId && !state.editingList) params.set('listId', state.selectedListId);
    if (state.filterDuplicates) params.set('filterDuplicates', 'true');
    const data = await apiFetch(`/api/songs?${params.toString()}`);
    if (requestId !== state.songsRequestId) return;
    state.songs = data.songs || [];
    state.virtualStart = -1;
    state.virtualEnd = -1;
    renderSongTable(resetScroll);
    let listMessage = '';
    if (state.editingList) {
      listMessage = ' (editing list, full library shown)';
    } else if (state.selectedListId) {
      listMessage = ' from selected song list';
    }
    const filterMessage = state.filterDuplicates ? ' (duplicates only)' : '';
    setStatus(`Showing ${state.songs.length} songs${listMessage}${filterMessage}.`);
  } catch (error) {
    if (requestId === state.songsRequestId) {
      setStatus(`Cannot load songs: ${error.message}`, true);
    }
  } finally {
    if (requestId === state.songsRequestId) state.loading = false;
  }
}

function getVirtualRowHeight() {
  const configuredHeight = getComputedStyle(elements.songTableWrapper)
    .getPropertyValue('--song-row-height');
  const rowHeight = Number.parseFloat(configuredHeight);
  return Number.isFinite(rowHeight) && rowHeight > 0 ? rowHeight : 66;
}

function createSpacerRow(height) {
  const row = document.createElement('tr');
  row.className = 'virtual-spacer';
  const cell = document.createElement('td');
  cell.colSpan = 6;
  cell.style.height = `${height}px`;
  row.append(cell);
  return row;
}

function createSongRow(song, editingSet, inEditMode, queueAddMode = false) {
  const row = document.createElement('tr');
  row.className = 'song-row';
  row.dataset.shortname = song.shortname;
  row.tabIndex = -1;
  row.innerHTML = `
      <td class="title-cell"><strong></strong>
      <div class="song-meta">
        <div class="song-meta-primary"></div>
        <div class="song-meta-secondary"></div>
      </div>
    </td>
    <td class="artist-cell"></td>
    <td class="album-cell"></td>
    <td class="origin-cell"></td>
    <td class="shortname-column"></td>
    <td class="action-cell"><div class="song-actions"></div></td>
  `;
  row.querySelector('.title-cell strong').textContent = song.title || '—';
  row.querySelector('.song-meta-primary').textContent = song.artist || '—';
  row.querySelector('.song-meta-secondary').textContent = `${song.album || '—'} | ${song.origin || '—'}`;
  for (const key of ['artist', 'album', 'origin']) row.querySelector(`.${key}-cell`).textContent = song[key] || '—';
  row.querySelector('.shortname-column').textContent = song.shortname || '—';

  const actionCell = row.querySelector('.song-actions');
  if (state.previewEnabled) {
    const previewButton = document.createElement('button');
    previewButton.type = 'button';
    previewButton.className = 'small-button secondary preview-button';
    const available = song.preview?.status === 'matched';
    const active = previewPlayer.state.song?.shortname === song.shortname
      && ['playing', 'loading'].includes(previewPlayer.state.status);
    previewButton.textContent = available ? (active ? 'Stop' : 'Preview')
      : ['unavailable', 'ambiguous'].includes(song.preview?.status) ? 'No clip' : 'Queued';
    previewButton.disabled = !available;
    previewButton.title = available ? `Preview ${song.title}` : previewButton.textContent === 'No clip'
      ? 'No confident Apple preview match available' : 'Preview matching is pending; browsing does not use Apple API calls';
    previewButton.setAttribute('aria-label', previewButton.title);
    previewButton.setAttribute('aria-pressed', String(active));
    if (available) {
      previewButton.dataset.previewShortname = song.shortname;
      previewButton.addEventListener('click', () => previewPlayer.play(song));
    }
    actionCell.append(previewButton);
  }
  const button = document.createElement('button');
  button.type = 'button';
  button.className = inEditMode ? 'small-button secondary' : 'small-button primary';
  if (queueAddMode) {
    button.dataset.queueAdd = song.shortname;
    updatePickerAddButton(button);
    button.addEventListener('click', () => addPickerSong(song));
  } else if (inEditMode) {
    const selected = editingSet.has(song.shortname);
    button.textContent = selected ? '−' : '+';
    button.title = selected ? 'Remove from song list' : 'Add to song list';
    button.addEventListener('click', () => toggleSongInList(song.shortname));
  } else {
    button.textContent = 'Pick';
    button.dataset.manualPick = song.shortname;
    button.disabled = !!manualSelectionReason();
    button.title = manualSelectionReason();
    button.addEventListener('click', () => pickSong(song.shortname));
  }
  actionCell.append(button);
  if (state.previewEnabled) {
    const indicator = document.createElement('span');
    indicator.className = 'preview-row-status';
    actionCell.append(indicator);
  }
  updatePreviewRow(row, previewPlayer.state);
  return row;
}

function renderSongTable(resetScroll = false, force = false) {
  if (resetScroll) elements.songTableWrapper.scrollTop = 0;
  if (!state.songs.length) {
    elements.songsTableBody.innerHTML = '<tr><td colspan="6" class="empty-row">No songs found.</td></tr>';
    updateGotoControls();
    renderPreviewState(previewPlayer.state);
    return;
  }

  const rowHeight = getVirtualRowHeight();
  const viewportHeight = elements.songTableWrapper.clientHeight;
  const { start, end } = VirtualList.calculateRange({
    itemCount: state.songs.length,
    scrollTop: elements.songTableWrapper.scrollTop,
    viewportHeight,
    rowHeight,
    overscan: VIRTUAL_OVERSCAN
  });
  if (!resetScroll && !force && start === state.virtualStart && end === state.virtualEnd) return;

  state.virtualStart = start;
  state.virtualEnd = end;
  const fragment = document.createDocumentFragment();
  if (start) fragment.append(createSpacerRow(start * rowHeight));
  const editingSet = new Set(state.editingList?.items || []);
  const inEditMode = Boolean(state.editingList);
  for (let index = start; index < end; index += 1) {
    fragment.append(createSongRow(state.songs[index], editingSet, inEditMode));
  }
  if (end < state.songs.length) fragment.append(createSpacerRow((state.songs.length - end) * rowHeight));
  elements.songsTableBody.replaceChildren(fragment);
  updateGotoControls();
  renderPreviewState(previewPlayer.state);
}

function scheduleVirtualRender() {
  if (virtualRenderFrame) return;
  virtualRenderFrame = requestAnimationFrame(() => {
    virtualRenderFrame = null;
    renderSongTable();
    schedulePreviewLookup();
  });
}

function getSortKey(song) {
  return String(song[state.sortBy] || '').trim().toUpperCase();
}

function getSongGroup(value) {
  const letter = String(value || '').trim().charAt(0).toUpperCase();
  return /[A-Z]/.test(letter) ? letter : '#';
}

function getSongGroupList() {
  const groups = [];
  for (const song of state.songs) {
    const group = getSongGroup(getSortKey(song));
    if (!groups.includes(group)) {
      groups.push(group);
    }
  }
  return groups;
}

function getCurrentTopGroup() {
  const index = Math.min(
    state.songs.length - 1,
    Math.max(0, Math.floor(elements.songTableWrapper.scrollTop / getVirtualRowHeight()))
  );
  return state.songs.length ? getSongGroup(getSortKey(state.songs[index])) : null;
}

function scrollToSongIndex(index) {
  elements.songTableWrapper.scrollTop = index * getVirtualRowHeight();
  scheduleVirtualRender();
}

function scrollToTop() {
  elements.songTableWrapper.scrollTop = 0;
  scheduleVirtualRender();
}

function scrollToBottom() {
  elements.songTableWrapper.scrollTop = elements.songTableWrapper.scrollHeight;
  scheduleVirtualRender();
}

function navigateGroup(direction) {
  if (!state.songs.length) return;
  const groups = getSongGroupList();
  if (!groups.length) return;
  const current = getCurrentTopGroup();
  let currentIndex = groups.indexOf(current);
  if (currentIndex < 0) {
    currentIndex = 0;
  }
  const targetIndex = currentIndex + direction;
  if (targetIndex < 0 || targetIndex >= groups.length) return;
  const targetGroup = groups[targetIndex];
  const nextIndex = state.songs.findIndex((song) => getSongGroup(getSortKey(song)) === targetGroup);
  if (nextIndex >= 0) {
    scrollToSongIndex(nextIndex);
  }
}

function updateGotoControls() {
  const shouldShow = state.songs.length > 1;
  elements.gotoControls.classList.toggle('hidden', !shouldShow);
}

function updateGotoDefaultState() {
  if (!elements.gotoControls) return;
  if (window.innerWidth <= 760) {
    elements.gotoControls.classList.remove('collapsed');
    elements.gotoControls.classList.add('expanded');
  } else {
    elements.gotoControls.classList.add('collapsed');
    elements.gotoControls.classList.remove('expanded');
  }
}

function toggleGotoNavigation() {
  if (!elements.gotoControls) return;
  elements.gotoControls.classList.toggle('collapsed');
  elements.gotoControls.classList.toggle('expanded');
}

function updateSortHeaders() {
  elements.tableHeaders.forEach((header) => {
    const sortKey = header.dataset.sort;
    const icon = header.querySelector('.sort-icon');
    if (sortKey === state.sortBy) {
      icon.textContent = state.sortOrder === 'asc' ? '▲' : '▼';
      header.classList.add('active');
    } else {
      icon.textContent = '';
      header.classList.remove('active');
    }
  });
  if (elements.sortButtons) {
    const buttons = Array.from(elements.sortButtons.querySelectorAll('button'));
    buttons.forEach((button) => {
      button.classList.toggle('active', button.dataset.sort === state.sortBy);
    });
  }
}

function toggleRandomMenu() {
  const visible = elements.randomMenu.classList.toggle('hidden');
  elements.randomMenuButton.setAttribute('aria-expanded', String(!visible));
}

function closeRandomMenu() {
  if (!elements.randomMenu.classList.contains('hidden')) {
    elements.randomMenu.classList.add('hidden');
    elements.randomMenuButton.setAttribute('aria-expanded', 'false');
  }
}

function toggleDuplicateFilter() {
  state.filterDuplicates = !state.filterDuplicates;
  elements.duplicateFilterButton.classList.toggle('active', state.filterDuplicates);
  loadSongs();
}

function pickRandom(type) {
  if (manualSelectionReason()) { setStatus(manualSelectionReason(), true); return; }
  if (!state.songs.length) {
    setStatus('No songs available for random selection.', true);
    return;
  }

  let candidates = [...state.songs];
  if (type === 'unpopular') {
    const minPicks = Math.min(...candidates.map((song) => song.picks || 0));
    candidates = candidates.filter((song) => (song.picks || 0) === minPicks);
  } else if (type === 'popular') {
    candidates = candidates.filter((song) => (song.picks || 0) > 0);
    if (!candidates.length) {
      setStatus('No popular songs have been picked yet.', true);
      return;
    }

    const totalWeight = candidates.reduce((sum, song) => sum + (song.picks || 0), 0);
    let seed = Math.random() * totalWeight;
    for (const song of candidates) {
      seed -= (song.picks || 0);
      if (seed < 0) {
        candidates = [song];
        break;
      }
    }
  }

  if (!candidates.length) {
    setStatus('No songs match the selected random criteria.', true);
    return;
  }

  const choice = candidates[Math.floor(Math.random() * candidates.length)];
  closeRandomMenu();
  pickSong(choice.shortname);
}

function toggleSongInList(shortname) {
  if (!state.editingList) return;
  const items = new Set(state.editingList.items || []);
  if (items.has(shortname)) {
    items.delete(shortname);
  } else {
    items.add(shortname);
  }
  state.editingList.items = Array.from(items);
  renderSongTable(false, true);
}

async function refreshLibrary() {
  try {
    setStatus('Refreshing library from Xbox...');
    await apiFetch('/api/songs/refresh', { method: 'POST' });
    await loadSongLists();
    await loadSongs();
    setStatus('Library refreshed successfully.');
  } catch (error) {
    setStatus(`Refresh failed: ${error.message}`, true);
  }
}

async function pickSong(shortname) {
  if (manualSelectionReason()) { setStatus(manualSelectionReason(), true); return; }
  previewPlayer.stop();
  try {
    setStatus(`Sending pick command for ${shortname}...`);
    const result = await apiFetch(`/api/songs/${encodeURIComponent(shortname)}/pick`, { method: 'POST' });
    const song = state.songs.find((item) => item.shortname === shortname);
    if (song) song.picks = result.count;
    renderSongTable();
    setStatus(`Song picked: ${shortname} (picked ${result.count} times).`);
  } catch (error) {
    setStatus(`Pick failed: ${error.message}`, true);
  }
}

async function beginNewList() {
  state.editingList = { id: null, name: '', items: [] };
  state.listMode = true;
  elements.listName.value = '';
  elements.listEditor.classList.remove('hidden');
  setStatus('Song list creation mode enabled. Use + / − buttons to choose songs.');
  await loadSongs();
}

async function beginEditList() {
  if (!state.selectedListId) return;
  try {
    const data = await apiFetch(`/api/songlists/${state.selectedListId}`);
    state.editingList = { id: data.id, name: data.name, items: data.items || [] };
    elements.listName.value = data.name;
    elements.listEditor.classList.remove('hidden');
    setStatus('Editing song list. Use + / − buttons to update membership.');
    await loadSongs();
  } catch (error) {
    setStatus(`Cannot edit list: ${error.message}`, true);
  }
}

async function saveSongList() {
  if (!state.editingList) return;
  const name = elements.listName.value.trim();
  if (!name) {
    setStatus('Song list name is required.', true);
    return;
  }

  try {
    const body = { name, items: state.editingList.items };
    if (state.editingList.id) {
      await apiFetch(`/api/songlists/${state.editingList.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      setStatus('Song list updated.');
    } else {
      await apiFetch('/api/songlists', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      setStatus('Song list created.');
    }
    state.editingList = null;
    elements.listEditor.classList.add('hidden');
    await loadSongLists();
    await loadSongs();
  } catch (error) {
    setStatus(`Cannot save list: ${error.message}`, true);
  }
}

async function deleteSongList() {
  if (!state.selectedListId) return;
  if (!confirm('Are you sure you want to delete the selected song list?')) return;
  const listId = state.selectedListId;
  try {
    await apiFetch(`/api/songlists/${listId}`, { method: 'DELETE' });
    state.selectedListId = '';
    await loadSongLists();
    await loadSongs();
    setStatus('Song list deleted.');
  } catch (error) {
    setStatus(`Cannot delete list: ${error.message}`, true);
  }
}

function cancelSongList() {
  state.editingList = null;
  elements.listEditor.classList.add('hidden');
  setStatus('Song list editing cancelled.');
  loadSongs();
}

function setPage(page, automatic = false) {
  if (pickerOpen && page !== 'queue') closeQueuePicker(false);
  if (!automatic) state.queueViewChosen = true;
  state.currentPage = page;
  if (page !== 'admin') state.adminUnlocked = false;
  if (page !== 'songs') previewPlayer.stop();
  for (const [name, element] of Object.entries(elements.pages)) {
    element.classList.toggle('hidden', page !== name);
    elements.pageButtons[name].classList.toggle('active', page === name);
    elements.pageButtons[name].setAttribute('aria-current', page === name ? 'page' : 'false');
  }
  queueElements.queueCompactStatus.classList.toggle('hidden', page === 'queue' || (!queueClient.snapshot?.session && !queueClient.snapshot?.operation));
  if (page === 'songs') {
    renderSongTable(false, true);
    schedulePreviewLookup();
    loadSongs(false);
  } else if (page === 'admin') {
    loadQueuePreferences();
    loadConfig();
    loadPreviewStatus(true);
    // Sync admin checkboxes with current in-memory state (set at init and kept
    // up-to-date by saveSettings). Calling loadSettings() here would overwrite
    // the current state with a stale server read, unchecking freshly-toggled settings.
    elements.showListManagement.checked = state.showSongListManagement;
    elements.showDuplicateFilterButton.checked = state.showDuplicateFilterButton;
    elements.showShortnameColumn.checked = state.showShortnameColumn;
    elements.showExportCsvButton.checked = state.showExportCsvButton;
  }
}

function attachEvents() {
  queueElements.startQueueButton.addEventListener('click', startQueue);
  elements.pageButtons.queue.addEventListener('click', () => setPage('queue'));
  queueElements.openQueueButton.addEventListener('click', () => setPage('queue'));
  for (const type of ['pause', 'resume', 'skip', 'stop']) {
    queueElements[`queue${type[0].toUpperCase()}${type.slice(1)}Button`].addEventListener('click', () => runQueueAction(type));
  }
  queueElements.queueRetryButton.addEventListener('click', retryQueueAction);
  queueElements.queueAdminRetryButton.addEventListener('click', retryQueueAction);
  queueElements.queueAddSongsButton.addEventListener('click', openQueuePicker);
  queueElements.queuePickerDone.addEventListener('click', () => closeQueuePicker());
  queueElements.queuePickerRetry.addEventListener('click', () => queuePicker.retry());
  queueElements.queuePickerSearch.addEventListener('input', () => {
    clearTimeout(pickerSearchTimer);
    pickerSearchTimer = setTimeout(loadQueuePickerSongs, SEARCH_DEBOUNCE_MS);
  });
  queueElements.queuePickerList.addEventListener('change', () => { clearTimeout(pickerSearchTimer); loadQueuePickerSongs(); });
  queueElements.queuePickerScroller.addEventListener('scroll', () => { renderQueuePicker(); schedulePickerPreviewLookup(); });
  queueElements.queuePicker.addEventListener('keydown', handlePickerKeydown);
  new ResizeObserver(() => { updatePickerLayout(); pickerRange.start = -1; renderQueuePicker(); }).observe(queueElements.queuePickerScroller);
  window.addEventListener('scroll', () => { if (pickerOpen) updatePickerLayout(); }, { passive: true });
  window.visualViewport?.addEventListener('resize', updatePickerLayout);
  window.visualViewport?.addEventListener('scroll', updatePickerLayout);
  queueElements.pauseAfterAttempt.addEventListener('change', saveQueuePreferences);
  queueElements.queueRecoveryAdminButton.addEventListener('click', requestAdminPage);
  queueElements.queueConfirmRestartButton.addEventListener('click', confirmConsoleRestarted);
  queueElements.queueReconcileStorageButton.addEventListener('click', reconcileQueueStorage);
  window.addEventListener('pagehide', () => queueClient.close());
  window.addEventListener('pageshow', event => { if (event.persisted) window.location.reload(); });
  elements.saveConfigButton.addEventListener('click', saveConfig);
  elements.savePreviewsButton.addEventListener('click', savePreviewSettings);
  // Keep fixed letter navigation from covering the required provider credit.
  const previewVisibility = new IntersectionObserver(([entry]) => {
    elements.gotoControls.classList.toggle('preview-credit-visible', entry.isIntersecting && state.previewEnabled);
  }, { rootMargin: '0px 0px 70px 0px' });
  previewVisibility.observe(elements.previewAttribution);
  elements.refreshButton.addEventListener('click', refreshLibrary);
  elements.showListManagement.addEventListener('change', saveSettings);
  elements.showDuplicateFilterButton.addEventListener('change', saveSettings);
  elements.showShortnameColumn.addEventListener('change', saveSettings);
  elements.showExportCsvButton.addEventListener('change', saveSettings);
  elements.duplicateFilterButton.addEventListener('click', toggleDuplicateFilter);
  elements.exportCsvButton.addEventListener('click', exportVisibleGridToCsv);
  elements.gotoTop.addEventListener('click', scrollToTop);
  elements.gotoUp.addEventListener('click', () => navigateGroup(-1));
  elements.gotoDown.addEventListener('click', () => navigateGroup(1));
  elements.gotoBottom.addEventListener('click', scrollToBottom);
  elements.pageButtons.songs.addEventListener('click', () => setPage('songs'));
  elements.pageButtons.admin.addEventListener('click', requestAdminPage);
  elements.defaultTheme.addEventListener('change', saveTheme);
  elements.saveAdminPinButton.addEventListener('click', saveAdminPin);
  elements.clearAdminPinButton.addEventListener('click', clearAdminPin);
  elements.adminPinForm.addEventListener('submit', verifyAdminPin);
  elements.cancelAdminPinButton.addEventListener('click', () => elements.adminPinDialog.classList.add('hidden'));
  elements.searchInput.addEventListener('input', (event) => {
    state.searchText = event.target.value;
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(() => loadSongs(), SEARCH_DEBOUNCE_MS);
  });
  elements.songListSelect.addEventListener('change', async (event) => {
    state.selectedListId = event.target.value;
    loadQueueSeedCount();
    await loadSongs();
    renderSongListOptions();
  });
  elements.randomButton.addEventListener('click', () => pickRandom('any'));
  elements.randomMenuButton.addEventListener('click', (event) => {
    event.stopPropagation();
    toggleRandomMenu();
  });
  elements.randomUnpopularButton.addEventListener('click', () => pickRandom('unpopular'));
  elements.randomPopularButton.addEventListener('click', () => pickRandom('popular'));
  document.addEventListener('click', closeRandomMenu);
  elements.gotoToggle?.addEventListener('click', toggleGotoNavigation);
  window.addEventListener('resize', () => {
    updateGotoDefaultState();
    state.virtualStart = -1;
    state.virtualEnd = -1;
    renderSongTable();
  });
  elements.songTableWrapper.addEventListener('scroll', scheduleVirtualRender);
  elements.newListButton.addEventListener('click', beginNewList);
  elements.editListButton.addEventListener('click', beginEditList);
  elements.deleteListButton.addEventListener('click', deleteSongList);
  elements.saveListButton.addEventListener('click', saveSongList);
  elements.cancelListButton.addEventListener('click', cancelSongList);
  elements.tableHeaders.forEach((header) => {
    header.addEventListener('click', async () => {
      const sortKey = header.dataset.sort;
      if (state.sortBy === sortKey) {
        state.sortOrder = state.sortOrder === 'asc' ? 'desc' : 'asc';
      } else {
        state.sortBy = sortKey;
        state.sortOrder = 'asc';
      }
      updateSortHeaders();
      await loadSongs();
    });
  });
}

function renderSortButtons() {
  if (!elements.sortButtons) return;
  elements.sortButtons.classList.remove('hidden');
  elements.sortButtons.innerHTML = '';
  for (const header of elements.tableHeaders) {
    const sortKey = header.dataset.sort;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'sort-button';
    const label = header.textContent.replace(/\s*[▲▼]/g, '').trim();
    const arrow = state.sortBy === sortKey ? (state.sortOrder === 'asc' ? '▲' : '▼') : '';
    button.textContent = `${label} ${arrow}`.trim();
    button.dataset.sort = sortKey;
    if (state.sortBy === sortKey) {
      button.classList.add('active');
    }
    button.addEventListener('click', async () => {
      if (state.sortBy === sortKey) {
        state.sortOrder = state.sortOrder === 'asc' ? 'desc' : 'asc';
      } else {
        state.sortBy = sortKey;
        state.sortOrder = 'asc';
      }
      renderSortButtons();
      updateSortHeaders();
      await loadSongs();
    });
    elements.sortButtons.append(button);
  }
}

async function init() {
  attachEvents();
  applyTheme('default');
  await loadConfig();
  updateGotoDefaultState();
  renderSortButtons();
  updateSortHeaders();
  renderQrImage();
  await loadVersion();
  if (elements.duplicateFilterButton) {
    elements.duplicateFilterButton.classList.add('hidden');
    elements.duplicateFilterButton.style.display = 'none';
  }
  if (elements.exportCsvButton) {
    elements.exportCsvButton.classList.add('hidden');
    elements.exportCsvButton.style.display = 'none';
  }
  await loadSettings();
  await loadSongLists();
  await loadPreviewStatus(true);
  setPage('songs', true);
  renderQueue();
  queueClient.connect();
  setTimeout(pollPreviews, 10000);
}

init().catch((error) => setStatus(`Initialization failed: ${error.message}`, true));
