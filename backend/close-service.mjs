// Stop accepting work, disconnect browser sockets, and let existing handlers
// settle before closing SQLite. A socket closing alone does not end its handler.
export async function closeService(service) {
  const closed = new Promise((done, reject) => service.server.close(error => {
    if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') reject(error); else done();
  }));
  service.server.closeAllConnections();
  await service.whenIdle();
  // A handler already in progress can publish a job while it settles; cancel
  // jobs only after handlers drain so no new job can escape this shutdown.
  await Promise.all([service.assessment.shutdown(), service.indexer.shutdown()]);
  await closed;
  service.store.close();
}
