// Graceful shutdown for SIGTERM/SIGINT. Render sends SIGTERM on every
// deploy/restart (SPECIFICATION.md section 8: unmanaged VM, external
// orchestrator owns the lifecycle). Without a handler, Node's default is
// to kill the process immediately, cutting off whatever webhook batch or
// recap run is mid-flight - Meta would see a broken response and retry,
// and a recap could stop half-written.
//
// server.close() stops accepting new connections and lets in-flight
// requests finish; a periodic closeIdleConnections() sweep drops idle
// keep-alive sockets (which would otherwise hold the close open until
// keepAliveTimeout) WITHOUT ever touching an active request - sockets
// that are active at shutdown time are simply swept on a later tick,
// once their response has finished. A force-exit timer covers requests
// that never finish.

export function createShutdownHandler({
  server,
  logger,
  timeoutMs = 10000,
  exit = (code) => process.exit(code),
} = {}) {
  let initiated = false;
  // Declared at handler scope (not inside the returned function) so a
  // repeated signal - which must clear the FIRST invocation's timers -
  // never touches them while they are still in their temporal dead zone.
  let forceTimer = null;
  let idleSweeper = null;

  // Single exit point so no timer survives past the decision to exit
  // (a lingering interval would keep an exiting process's event loop
  // alive, and in tests would keep the suite running).
  function finish(code, logMessage, level = 'error') {
    if (forceTimer) clearTimeout(forceTimer);
    if (idleSweeper) clearInterval(idleSweeper);
    if (logMessage) logger[level](logMessage, { timeoutMs });
    exit(code);
  }

  return function shutdown(signal) {
    if (initiated) {
      // Second signal while draining: the operator is impatient (or
      // something is wedged) - stop draining and exit now.
      finish(1, 'Repeated shutdown signal - forcing exit', 'warn');
      return;
    }
    initiated = true;
    logger.info('Shutdown initiated', { signal });

    forceTimer = setTimeout(() => {
      finish(1, 'Shutdown timed out - forcing exit');
    }, timeoutMs);

    server.close((err) => {
      if (err) {
        finish(1, 'Error while closing server');
        return;
      }
      if (forceTimer) clearTimeout(forceTimer);
      if (idleSweeper) clearInterval(idleSweeper);
      logger.info('Shutdown complete', { signal });
      exit(0);
    });

    if (typeof server.closeIdleConnections === 'function') {
      server.closeIdleConnections();
      idleSweeper = setInterval(() => server.closeIdleConnections(), 200);
    }
  };
}
