// Routes incoming WhatsApp messages based on per-user conversation state.
// See docs/SPECIFICATION.md section 12.1 (Conversation State Machine)
// and section 12.2 (Per-User Idempotency & Locking).

export async function handleIncomingMessage(message) {
  // TODO: 1. check message_log for wa_message_id (idempotency)
  // TODO: 2. acquire per-user lock (see domain/context.js)
  // TODO: 3. look up users.state, dispatch to the matching state handler
  // TODO: 4. release lock after processing completes
}
