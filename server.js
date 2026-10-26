const express = require('express');
const path = require('path');
const ConfigStore = require('./config-store');
const Database = require('./database');
const XboxService = require('./xbox-service');
const { createApiRouter } = require('./api-router');
const PreviewStore = require('./preview-store');
const PreviewWorker = require('./preview-worker');
const ApplePreviewService = require('./apple-preview-service');
const QueueRuntime = require('./queue-runtime');
const { createQueueRouter } = require('./queue-router');

const BASE_DIR = __dirname;
const STATE_DIR = process.env.STATE_DIR ? path.resolve(process.env.STATE_DIR) : BASE_DIR;
const PUBLIC_DIR = path.join(BASE_DIR, 'public');

function createApplication(options = {}) {
  if (typeof fetch !== 'function') {
    throw new Error('Node.js built-in fetch is required. Please use Node 24.20.0 or newer.');
  }
  const stateDir = options.stateDir || STATE_DIR;
  const configStore = options.configStore || new ConfigStore(path.join(stateDir, 'config.json'));
  const db = options.db || new Database(path.join(stateDir, 'songs.sqlite'));
  const xboxService = options.xboxService || new XboxService(configStore);
  const previewStore = options.previewStore || new PreviewStore(db);
  const previewWorker = options.previewWorker || new PreviewWorker(previewStore, new ApplePreviewService());
  const queueRuntime = options.queueRuntime || new QueueRuntime({ db, configStore, xboxService });
  const queueRouter = createQueueRouter({ runtime: queueRuntime, configStore });
  const apiRouter = createApiRouter({ db, configStore, xboxService, previewStore, previewWorker,
    queueController: queueRuntime.controller, queueRuntime });

  const app = express();
  // Full entry-ID reorder commands can exceed the browser API's 100 KB default.
  app.use('/api/queue', express.json({ limit: '1mb' }), queueRouter);
  app.use(express.json());
  app.use(express.static(PUBLIC_DIR));
  app.get('/api/version', (req, res) => {
    const revision = String(process.env.APP_VERSION || 'development').trim();
    res.json({ version: revision === 'development' ? revision : revision.slice(0, 7) });
  });
  app.use('/api', apiRouter);
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    console.error(err);
    res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
  });

  let server, initializing, stopping;
  const initialize = () => {
    if (!initializing) initializing = (async () => {
      await db.ready;
      await previewStore.initialize();
      // Recovery is durable and inactive before any HTTP controls are exposed.
      await queueRuntime.initialize();
    })();
    return initializing;
  };
  const listen = async (port = Number(process.env.PORT) || 3000) => {
    await initialize();
    await new Promise((resolve, reject) => {
      server = app.listen(port, () => {
        server.off('error', reject);
        resolve();
      });
      server.once('error', reject);
    });
    previewWorker.start();
    return server;
  };
  const close = () => {
    if (!stopping) stopping = (async () => {
      const queueClosed = queueRuntime.close();
      queueRouter.close();
      const httpClosed = server ? new Promise(resolve => server.close(resolve)) : Promise.resolve();
      await queueClosed;
      await previewWorker.stop();
      await httpClosed;
      await db.close();
    })();
    return stopping;
  };
  return { app, initialize, listen, close, queueRuntime };
}

async function start() {
  const application = createApplication();
  try {
    const server = await application.listen();
    console.log(`RB3 Song Picker server listening on http://localhost:${server.address().port}`);
    process.once('SIGINT', () => application.close().catch(console.error));
    process.once('SIGTERM', () => application.close().catch(console.error));
  } catch (error) {
    await application.close();
    throw error;
  }
}

if (require.main === module) start().catch(error => {
  console.error('Cannot start server:', error);
  process.exitCode = 1;
});

module.exports = { createApplication };
