const { EventEmitter } = require('node:events');
const QueueStore = require('./queue-store');
const QueueController = require('./queue-controller');
const GameState = require('./game-state');
const { Rb3Events } = require('./rb3-events');

// Application-owned composition: browsers never own the listener or execution.
class QueueRuntime extends EventEmitter {
  constructor({ db, configStore, xboxService, createListener = config => new Rb3Events(config), storeOptions }) {
    super();
    this.configStore = configStore;
    this.createListener = createListener;
    this.store = new QueueStore(db, storeOptions);
    this.game = new GameState();
    this.controller = new QueueController({ store: this.store, gameState: this.game, xboxService,
      pauseAfterAttempt: () => this.configStore.load().pauseAfterAttempt === true });
    this.listener = null;
    this.listenerError = null;
    this.accepting = false;
    this.closed = false;
    this.tail = Promise.resolve();
    this.onObservation = observation => {
      if (!this.accepting || this.closed) return;
      this.controller.observe(observation);
      this.emit('diagnostics', this.diagnostics());
    };
    this.onInvalidate = reason => {
      this.game.reset(reason);
      this.emit('diagnostics', this.diagnostics());
    };
    this.onDiagnostics = () => this.emit('diagnostics', this.diagnostics());
    this.controller.on('diagnostics', this.onDiagnostics);
  }

  endpoint(config) {
    return { sourceAddress: config.xboxIp, bindAddress: config.eventsBindAddress, port: config.eventsPort };
  }

  serialize(work) {
    const task = this.tail.then(work);
    this.tail = task.catch(() => {});
    return task;
  }

  async initialize() {
    await this.controller.initialize();
    await this.configure(this.configStore.load());
  }

  configure(config) {
    // Invalidate synchronously, including reservations currently waiting on SQLite.
    this.accepting = false;
    this.game.reset('endpoint-change');
    return this.serialize(async () => {
      if (this.closed) return;
      this.listenerError = null;
      try {
        if (!this.listener) {
          this.listener = this.createListener(this.endpoint(config));
          this.listener.on('observation', this.onObservation);
          this.listener.on('invalidate', this.onInvalidate);
          await this.listener.start();
        } else await this.listener.configure(this.endpoint(config));
      } catch (error) {
        this.listenerError = error.message;
      }
      this.accepting = !this.closed && !this.listenerError && this.listener?.diagnostics().status === 'listening';
      await this.controller.idle();
      this.emit('diagnostics', this.diagnostics());
    });
  }

  diagnostics() {
    return { ...this.controller.diagnostics(), listener: this.listenerError
      ? { status: 'error', error: this.listenerError, ...this.endpoint(this.configStore.load()) }
      : this.listener?.diagnostics() || { status: 'stopped' } };
  }

  async close() {
    if (this.closed) return this.tail;
    this.closed = true;
    this.accepting = false;
    // close() inhibits immediately, before waiting for listener or browser disposal.
    const closing = this.controller.close();
    await this.serialize(async () => {
      await closing;
      if (this.listener) {
        this.listener.off('observation', this.onObservation);
        this.listener.off('invalidate', this.onInvalidate);
        await this.listener.stop();
      }
      this.controller.off('diagnostics', this.onDiagnostics);
      this.emit('close');
    });
  }
}
module.exports = QueueRuntime;
