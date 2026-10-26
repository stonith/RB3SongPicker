const { randomUUID } = require('node:crypto');

// The controller serializes reservations/results. HTTP is deliberately detached
// from that queue so Pause, Stop and evidence invalidation never wait for HTTP.
class SelectionCoordinator {
  constructor({ xboxService, onResult }) {
    this.xboxService = xboxService;
    this.onResult = onResult;
  }

  reservation({ owner, sessionId = null, entryId = null, shortname, epoch = null,
    opportunityId = null, generation }) {
    return { id: randomUUID(), owner, sessionId, entryId, shortname, epoch,
      opportunityId, generation, status: 'reserved' };
  }

  dispatch(operation) {
    let request;
    try { request = this.xboxService.selectSong(operation.shortname); }
    catch (error) { request = Promise.reject(error); }
    Promise.resolve(request).then(
      () => this.onResult(operation.id, { ok: true, returned: true }),
      error => this.onResult(operation.id, { ok: false, returned: error.transportReturned === true,
        message: error.message || 'Selection transport failed' })
    ).catch(() => { /* Controller records/latches persistence failures. */ });
  }
}

module.exports = SelectionCoordinator;
