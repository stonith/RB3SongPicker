const GameState = require('../game-state');
const { decodePacket, Rb3Events } = require('../rb3-events');
const packets = require('./fixtures/rb3-events/packets.json');
const { EventEmitter } = require('node:events');

describe('bounded observed game-state evidence', () => {
  let game, now, transitions;
  const sourceAddress = '192.0.2.10';
  function send(type, value) { game.observe({ type, value, receivedAt: now, sourceAddress, platform: 0 }); }
  function fixture(name) { game.observe(decodePacket(Buffer.from(packets[name], 'hex'), { address: sourceAddress }, { sourceAddress, receivedAt: now })); }
  function select() { fixture('songSelect'); }
  function start(shortname = 'alpha') { send('SONG_SHORTNAME', shortname); send('SONG_NAME', 'Title'); fixture('band'); fixture('start'); }
  beforeEach(() => {
    now = 1000; transitions = [];
    game = new GameState({ now: () => now, identityWindowMs: 1000 });
    game.on('transition', event => transitions.push(event));
  });
  test('song-selection observation immediately authorizes an opportunity without ALIVE or age gate', () => {
    expect(game.snapshot().canSelect).toBe(false);
    select(); expect(game.snapshot().canSelect).toBe(true);
    const opportunity = game.snapshot().screen.opportunityId;
    now += 86400000; game.expire();
    expect(game.snapshot()).toMatchObject({ canSelect: true, lastObservedAt: 1000 });
    expect(game.snapshot().screen.opportunityId).toBe(opportunity);
  });
  test('consuming an opportunity is once-only; duplicate selection notifications cannot create another', () => {
    select(); const id = game.snapshot().screen.opportunityId;
    expect(game.consumeSelectionOpportunity('wrong')).toBe(false);
    expect(game.consumeSelectionOpportunity(id)).toBe(true);
    select(); expect(game.consumeSelectionOpportunity(id)).toBe(false);
    expect(game.snapshot().canSelect).toBe(false);
    send('SCREEN_NAME', 'main_screen'); select();
    expect(game.snapshot().canSelect).toBe(true);
    expect(game.snapshot().screen.opportunityId).not.toBe(id);
  });
  test('construction identity/metadata/state and destruction make one attempt, never a completion claim', () => {
    select(); start(); const attempt = game.snapshot().attempt;
    expect(attempt).toMatchObject({ shortname: 'alpha', startedAt: now });
    expect(game.snapshot().canSelect).toBe(false);
    fixture('start'); fixture('shortname'); fixture('band');
    fixture('end'); fixture('end');
    expect(transitions.filter(e => e.type === 'attempt-started')).toHaveLength(1);
    expect(transitions.filter(e => e.type === 'attempt-ended')).toHaveLength(1);
    expect(game.snapshot().lastEndedAttempt).toMatchObject({ id: attempt.id, shortname: 'alpha', endedAt: now });
    expect(game.snapshot().lastEndedAttempt).not.toHaveProperty('outcome');
    expect(game.snapshot().attempt).toBeNull();
    expect(game.snapshot().canSelect).toBe(false);
    send('SCREEN_NAME', 'results_screen'); expect(game.snapshot().canSelect).toBe(false);
    select(); expect(game.snapshot().canSelect).toBe(true);
  });
  test('consecutive identical songs require fresh identity AND accepted end boundary, with distinct IDs', () => {
    start(); const first = game.snapshot().attempt.id;
    fixture('end'); select(); now++; start();
    expect(game.snapshot().attempt.id).not.toBe(first);
    fixture('end'); expect(transitions.filter(e => e.type === 'attempt-ended')).toHaveLength(2);
  });
  test('a selection screen observed before end is not a post-attempt opportunity', () => {
    start(); select(); expect(game.snapshot().canSelect).toBe(false);
    fixture('end'); expect(game.snapshot().canSelect).toBe(false);
    select(); expect(game.snapshot().canSelect).toBe(true);
  });
  test('ALIVE and silence establish neither screen, disconnect nor completion', () => {
    fixture('alive'); now += 100000; game.expire();
    expect(game.snapshot()).toMatchObject({ canSelect: false, lastAliveAt: 1000, uncertainty: null });
    start(); now += 100000; game.expire();
    expect(game.snapshot().attempt).not.toBeNull();
    expect(transitions.filter(e => e.type === 'attempt-ended')).toHaveLength(0);
  });
  test.each(['startup', 'listener-start', 'endpoint-change', 'listener-stop', 'listener-error', 'console-restarted'])('reset %s clears observations and requires a new screen', reason => {
    select(); const epoch = game.snapshot().epoch;
    game.reset(reason); expect(game.snapshot()).toMatchObject({ epoch: epoch + 1, canSelect: false, screen: null, attempt: null });
    fixture('alive'); expect(game.snapshot().canSelect).toBe(false);
    select(); expect(game.snapshot().canSelect).toBe(true);
  });
  test.each(['missing-identity', 'expired-identity', 'identity-conflict', 'end-before-start', 'identity-during-attempt'])('contradictory/incomplete %s inhibits action without inventing an end', scenario => {
    select();
    if (scenario === 'missing-identity') fixture('start');
    if (scenario === 'expired-identity') { fixture('shortname'); now += 1001; fixture('start'); }
    if (scenario === 'identity-conflict') { fixture('shortname'); send('SONG_SHORTNAME', 'other'); }
    if (scenario === 'end-before-start') { fixture('shortname'); fixture('end'); }
    if (scenario === 'identity-during-attempt') { start(); send('SONG_SHORTNAME', 'other'); }
    expect(game.snapshot().uncertainty).not.toBeNull();
    expect(game.snapshot().canSelect).toBe(false);
    expect(game.snapshot().screen).toBeNull();
    select(); expect(game.snapshot().canSelect).toBe(false);
    expect(transitions.filter(e => e.type === 'attempt-ended')).toHaveLength(0);
  });
  test('STATE before identity is unsupported reordering: later identity cannot retroactively open an attempt', () => {
    fixture('start'); fixture('shortname'); fixture('start');
    expect(game.snapshot().attempt).toBeNull();
    expect(game.snapshot().uncertainty).not.toBeNull();
  });
  test('metadata, band, score, venue and stagekit do not establish identity/readiness', () => {
    for (const type of ['SONG_NAME', 'SONG_ARTIST', 'BAND_INFO', 'SCORE', 'STAGEKIT', 'VENUE_NAME', 'DX_DATA']) send(type, 'alpha');
    expect(game.snapshot()).toMatchObject({ canSelect: false, attempt: null, uncertainty: null });
    fixture('start'); expect(game.snapshot().uncertainty).not.toBeNull();
  });
  test('incomplete construction expires, duplicate identity does not refresh its bound', () => {
    select(); fixture('shortname'); now += 999; fixture('shortname'); now += 2; game.expire();
    expect(game.snapshot().uncertainty).toBe('incomplete-construction');
    expect(game.snapshot().canSelect).toBe(false);
  });
  test('an isolated menu STATE is harmless and duplicates do not erase accepted screen', () => {
    fixture('end'); expect(game.snapshot().uncertainty).toBeNull();
    select(); fixture('end'); expect(game.snapshot().canSelect).toBe(true);
  });
  test('an end without fresh identity cannot manufacture another identical attempt', () => {
    start(); fixture('end'); fixture('start');
    expect(game.snapshot().attempt).toBeNull();
    expect(game.snapshot().uncertainty).toBe('start-without-identity');
    expect(transitions.filter(e => e.type === 'attempt-ended')).toHaveLength(1);
  });
  test('construction window includes its boundary and never delays opening a coherent attempt', () => {
    fixture('shortname'); now += 1000; fixture('start');
    expect(game.snapshot().attempt.shortname).toBe('alpha');
    expect(game.snapshot().uncertainty).toBeNull();
  });
  test('a different screen invalidates unconsumed readiness immediately', () => {
    select(); send('SCREEN_NAME', 'main_screen');
    expect(game.snapshot()).toMatchObject({ canSelect: false, screen: { name: 'main_screen' } });
  });
  test('null decoded input does not alter evidence', () => {
    select(); const before = game.snapshot(); game.observe(null);
    expect(game.snapshot()).toEqual(before);
  });
  test('invalid construction windows are rejected', () => {
    for (const identityWindowMs of [0, -1, Infinity, NaN]) expect(() => new GameState({ identityWindowMs })).toThrow();
  });
  test('snapshots cannot mutate internal evidence', () => {
    start(); game.snapshot().attempt.shortname = 'changed';
    expect(game.snapshot().attempt.shortname).toBe('alpha');
  });
  test('listener lifecycle invalidation can directly reset game evidence', async () => {
    class Socket extends EventEmitter { bind() { this.emit('listening'); } close(cb) { cb?.(); } }
    const socket = new Socket();
    const listener = new Rb3Events({ sourceAddress }, { now: () => now, createSocket: () => socket });
    listener.on('observation', event => game.observe(event));
    listener.on('invalidate', reason => game.reset(reason));
    await listener.start();
    socket.emit('message', Buffer.from(packets.songSelect, 'hex'), { address: sourceAddress });
    expect(game.snapshot().canSelect).toBe(true);
    await listener.stop(); expect(game.snapshot().canSelect).toBe(false);
  });
});
