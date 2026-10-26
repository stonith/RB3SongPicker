const PreviewPlayer = require('../public/preview-player');
function audioMock() {
  const handlers = {};
  return { src: '', currentSrc: '', ended: false, error: null,
    pause: jest.fn(), load: jest.fn(), play: jest.fn().mockResolvedValue(),
    removeAttribute: jest.fn(function () { this.src = ''; }),
    addEventListener: (event, handler) => { handlers[event] = handler; },
    emit: (event) => handlers[event]() };
}
const song = (name = 'one') => ({ shortname: name, preview: { status: 'matched', previewUrl: `https://audio-ssl.itunes.apple.com/${name}.m4a` } });

test('one shared player toggles, stops and does not preload audio', async () => {
  const audio = audioMock(), change = jest.fn();
  const player = new PreviewPlayer(audio, change);
  expect(audio.load).not.toHaveBeenCalled();
  await player.play(song());
  expect(player.state.status).toBe('playing');
  await player.play(song());
  expect(player.state).toMatchObject({ status: 'stopped', song: { shortname: 'one' } });
  expect(audio.src).toBe('');
  await player.play(song('two'));
  player.stop();
  expect(player.state.song.shortname).toBe('two');
  player.clear();
  expect(player.state).toEqual({ status: 'idle', song: null });
});
test('stale play promise rejection cannot break a newer preview', async () => {
  const audio = audioMock();
  let reject;
  audio.play.mockImplementationOnce(() => new Promise((resolve, fail) => { reject = fail; }));
  const player = new PreviewPlayer(audio, jest.fn());
  const previous = player.play(song());
  await player.play(song('two'));
  reject(new Error('old play interrupted'));
  await previous;
  expect(player.state).toMatchObject({ status: 'playing', song: { shortname: 'two' } });
});
test('play failure is surfaced once without retries or metadata calls', async () => {
  const audio = audioMock();
  audio.play.mockRejectedValue(new Error('not allowed'));
  const player = new PreviewPlayer(audio, jest.fn());
  await player.play(song());
  expect(player.state.status).toBe('error');
  expect(audio.play).toHaveBeenCalledTimes(1);
  audio.currentSrc = audio.src; audio.ended = true; audio.emit('ended');
  expect(player.state).toMatchObject({ status: 'finished', song: { shortname: 'one' } });
});

test('stopping a loading clip keeps its identity and ignores stale completion', async () => {
  const audio = audioMock();
  let resolve;
  audio.play.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  const player = new PreviewPlayer(audio, jest.fn());
  const playing = player.play(song());
  player.stop();
  resolve();
  await playing;
  expect(player.state).toMatchObject({ status: 'stopped', song: { shortname: 'one' } });
  await player.play(player.state.song);
  expect(player.state.status).toBe('playing');
});
