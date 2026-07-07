// Idempotency guard. See docs/SPECIFICATION.md section 12.2.

export async function hasProcessedMessage(waMessageId) {
  // TODO: check message_log for wa_message_id
}

export async function recordProcessedMessage(userId, waMessageId) {
  // TODO: insert into message_log (unique constraint on wa_message_id)
}
