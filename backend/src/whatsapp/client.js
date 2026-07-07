// Baileys WhatsApp connection + session lifecycle.
// Session state must persist to disk (WA_SESSION_PATH) across process
// restarts. See docs/SPECIFICATION.md section 8 (Deployment Architecture)
// and section 11.3 (Health Monitoring).

export async function connectWhatsApp() {
  // TODO: initialize Baileys socket using auth state from WA_SESSION_PATH
  // TODO: register connection.update listener, implement reconnect-with-backoff
  // TODO: ignore all messages originating from group chats (see spec section 1.2)
}

export function getConnectionStatus() {
  // TODO: return current connection state, used by the health endpoint
  // (see docs/OPERATIONS.md - Health Monitoring)
}
