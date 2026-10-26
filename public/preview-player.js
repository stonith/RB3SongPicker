/* Shared media state is independent of virtualized song rows. */
(function (root) {
  class PreviewPlayer {
    constructor(audio, onChange) {
      this.audio = audio;
      this.onChange = onChange;
      this.generation = 0;
      this.state = { status: 'idle', song: null };
      const isCurrent = () => this.state.song && audio.currentSrc === this.state.song.preview.previewUrl;
      audio.addEventListener('ended', () => { if (isCurrent() && audio.ended) this.stop(); });
      audio.addEventListener('error', () => { if (isCurrent() && audio.error) this.update('error'); });
      audio.addEventListener('pause', () => {
        if (isCurrent() && this.state.status === 'playing' && !audio.ended) this.update('paused');
      });
      audio.addEventListener('play', () => { if (isCurrent()) this.update('playing'); });
    }

    update(status) {
      this.state = { ...this.state, status };
      this.onChange(this.state);
    }

    stop() {
      this.generation++;
      this.state = { status: 'idle', song: null };
      this.audio.pause();
      this.audio.removeAttribute('src');
      this.audio.load();
      this.onChange(this.state);
    }

    async play(song) {
      if (song.preview?.status !== 'matched') return;
      if (this.state.song?.shortname === song.shortname && ['playing', 'loading'].includes(this.state.status)) {
        this.stop();
        return;
      }
      const generation = ++this.generation;
      this.state = { status: 'loading', song };
      this.audio.pause();
      this.audio.src = song.preview.previewUrl;
      this.onChange(this.state);
      try {
        await this.audio.play();
        if (generation === this.generation) this.update('playing');
      } catch {
        if (generation === this.generation) this.update('error');
      }
    }
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = PreviewPlayer;
  else root.PreviewPlayer = PreviewPlayer;
})(typeof globalThis !== 'undefined' ? globalThis : window);
