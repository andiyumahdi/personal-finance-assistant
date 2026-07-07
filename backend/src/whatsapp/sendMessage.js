// Outbound message sender with a single retry on transient failure.
// See docs/SPECIFICATION.md section 11.2 (Error Handling & Retry Policy).

export async function sendMessage(phoneNumber, text) {
  // TODO: send via Baileys socket
  // TODO: on failure, retry once; log and continue on second failure
  // (never crash the process over a failed outbound send)
}
