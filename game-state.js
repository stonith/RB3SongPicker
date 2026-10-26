const { EventEmitter } = require('node:events');

class GameState extends EventEmitter {
  constructor({ now = Date.now, identityWindowMs = 1000 } = {}) {
    super();
    if (!Number.isFinite(identityWindowMs) || identityWindowMs <= 0) throw new TypeError('identityWindowMs must be positive');
    this.now = now;
    this.identityWindowMs = identityWindowMs;
    this.epoch = 0;
    this.attemptSequence = 0;
    this.opportunitySequence = 0;
    this.reset('startup');
  }

  reset(reason = 'explicit-reset') {
    this.epoch++;
    this.screen = null;
    this.attempt = null;
    this.identity = null;
    this.uncertainty = null;
    this.lastObservedAt = null;
    this.lastAliveAt = null;
    this.lastEndedAttempt = null;
    this.emit('transition', { type: 'reset', reason, epoch: this.epoch });
  }

  snapshot() {
    return structuredClone({ epoch: this.epoch, screen: this.screen, attempt: this.attempt,
      lastEndedAttempt: this.lastEndedAttempt, uncertainty: this.uncertainty,
      lastObservedAt: this.lastObservedAt, lastAliveAt: this.lastAliveAt,
      canSelect: !!(this.screen?.name === 'song_select_screen' && !this.screen.consumed &&
        !this.attempt && !this.identity && !this.uncertainty) });
  }

  consumeSelectionOpportunity(opportunityId) {
    if (!this.snapshot().canSelect || this.screen.opportunityId !== opportunityId) return false;
    this.screen.consumed = true;
    return true;
  }

  uncertain(reason) {
    const attempt = this.attempt;
    this.epoch++;
    this.screen = null;
    this.identity = null;
    this.attempt = null;
    this.uncertainty = reason;
    this.emit('transition', { type: 'uncertain', reason, attempt: attempt && { ...attempt }, epoch: this.epoch });
  }

  // Only construction correlation is bounded. Screen age and gameplay silence
  // never expire: v0 has no periodic heartbeat or completion acknowledgement.
  expire(at = this.now()) {
    if (this.identity && at - this.identity.receivedAt > this.identityWindowMs) this.uncertain('incomplete-construction');
    return this.snapshot();
  }

  // Accept decoded observations from Rb3Events, not raw/untrusted browser input.
  observe(observation) {
    if (!observation) return this.snapshot();
    const { type, value, receivedAt } = observation;
    this.expire(receivedAt);
    this.lastObservedAt = receivedAt;
    if (type === 'ALIVE') this.lastAliveAt = receivedAt;
    if (this.uncertainty) return this.snapshot();

    if (type === 'SCREEN_NAME') {
      // A screen received during gameplay cannot serve as the required new
      // post-end observation. Gameplay remains tracked until its end boundary.
      if (!this.attempt && !this.identity) {
        if (this.screen?.name === value) this.screen.receivedAt = receivedAt;
        else this.screen = { name: value, receivedAt, epoch: this.epoch, consumed: false,
          opportunityId: value === 'song_select_screen' ? `${this.epoch}:${++this.opportunitySequence}` : null };
      }
    } else if (type === 'SONG_SHORTNAME') {
      if (this.attempt) {
        if (this.attempt.shortname !== value) this.uncertain('identity-during-attempt');
      } else if (this.identity) {
        if (this.identity.shortname !== value) this.uncertain('conflicting-identity');
      } else {
        this.screen = null;
        this.identity = { shortname: value, receivedAt };
      }
    } else if (type === 'STATE' && value === 1) {
      this.screen = null;
      if (!this.attempt) {
        if (!this.identity) this.uncertain('start-without-identity');
        else {
          this.attempt = { id: `${this.epoch}:${++this.attemptSequence}`, epoch: this.epoch,
            shortname: this.identity.shortname, startedAt: receivedAt };
          this.identity = null;
          this.emit('transition', { type: 'attempt-started', attempt: { ...this.attempt }, epoch: this.epoch });
        }
      }
    } else if (type === 'STATE' && value === 0) {
      if (this.attempt) {
        this.lastEndedAttempt = { ...this.attempt, endedAt: receivedAt };
        this.attempt = null;
        this.screen = null;
        this.emit('transition', { type: 'attempt-ended', attempt: { ...this.lastEndedAttempt }, epoch: this.epoch });
      } else if (this.identity) this.uncertain('end-before-start');
    }
    return this.snapshot();
  }
}

module.exports = GameState;
