// SPECIFICATION.md section 8: Render sends SIGTERM on every deploy/restart
// - the handler must drain in-flight requests, then exit; force-exit after
// the timeout; a repeated signal while draining stops waiting immediately.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createShutdownHandler } from '../../src/utils/shutdown.js';

function makeLogger() {
  const lines = [];
  return {
    lines,
    info: (message, meta) => lines.push({ level: 'info', message, meta }),
    warn: (message, meta) => lines.push({ level: 'warn', message, meta }),
    error: (message, meta) => lines.push({ level: 'error', message, meta }),
  };
}

/** Fake http.Server: close(cb) records the call and completes on demand. */
function makeServer({ closeError = null, hasIdleConnections = true } = {}) {
  const server = {
    closeCalls: 0,
    idleCloseCalls: 0,
    pendingCallback: null,
    close(cb) {
      server.closeCalls += 1;
      server.pendingCallback = cb;
    },
    completeClose() {
      server.pendingCallback(closeError);
    },
  };
  if (hasIdleConnections) {
    server.closeIdleConnections = () => {
      server.idleCloseCalls += 1;
    };
  }
  return server;
}

describe('createShutdownHandler', () => {
  test('SIGTERM drains the server then exits 0', () => {
    const logger = makeLogger();
    const server = makeServer();
    const exits = [];
    const shutdown = createShutdownHandler({
      server,
      logger,
      exit: (code) => exits.push(code),
    });

    shutdown('SIGTERM');
    assert.equal(server.closeCalls, 1);
    assert.equal(server.idleCloseCalls, 1, 'idle keep-alive sockets must be dropped');
    assert.deepEqual(exits, [], 'no exit while draining');

    server.completeClose();
    assert.deepEqual(exits, [0]);
    assert.ok(logger.lines.some((l) => l.message === 'Shutdown initiated'));
    assert.ok(logger.lines.some((l) => l.message === 'Shutdown complete'));
  });

  test('force-exits 1 when the drain exceeds the timeout', async () => {
    const logger = makeLogger();
    const server = makeServer(); // never completes close
    const exits = [];
    const shutdown = createShutdownHandler({
      server,
      logger,
      timeoutMs: 10,
      exit: (code) => exits.push(code),
    });

    shutdown('SIGTERM');
    assert.deepEqual(exits, []);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(exits, [1]);
    assert.ok(logger.lines.some((l) => l.message === 'Shutdown timed out - forcing exit'));
  });

  test('a repeated signal while draining exits immediately', () => {
    const logger = makeLogger();
    const server = makeServer();
    const exits = [];
    const shutdown = createShutdownHandler({
      server,
      logger,
      exit: (code) => exits.push(code),
    });

    shutdown('SIGTERM');
    shutdown('SIGTERM'); // impatient second signal
    assert.deepEqual(exits, [1]);
    assert.equal(server.closeCalls, 1, 'must not close twice');
    assert.ok(logger.lines.some((l) => l.level === 'warn'));
  });

  test('close callback error exits 1', () => {
    const logger = makeLogger();
    const server = makeServer({ closeError: new Error('boom') });
    const exits = [];
    const shutdown = createShutdownHandler({
      server,
      logger,
      exit: (code) => exits.push(code),
    });

    shutdown('SIGINT');
    server.completeClose();
    assert.deepEqual(exits, [1]);
  });

  test('servers without closeIdleConnections still work', () => {
    const logger = makeLogger();
    const server = makeServer({ hasIdleConnections: false });
    const exits = [];
    const shutdown = createShutdownHandler({
      server,
      logger,
      exit: (code) => exits.push(code),
    });

    shutdown('SIGTERM');
    server.completeClose();
    assert.deepEqual(exits, [0]);
  });
});
