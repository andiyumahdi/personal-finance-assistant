// Outbound message sender via the WhatsApp Cloud API (Graph API), with a
// single retry on transient failure. See SPECIFICATION.md section 11.2.
//
// Replaces the Baileys-based sender. The old Baileys client
// (src/whatsapp/client.js) and its session (auth_state/) remain in the
// codebase as deprecated, not deleted, until this Cloud API path is
// confirmed stable in real use - see docs/whatsapp-cloud-api-setup.md
// "Baileys Cleanup".

import { logger } from '../utils/logger.js';

const GRAPH_API_VERSION = 'v23.0';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Sends a plain text message to `phoneNumber` (WhatsApp-format, no "+",
 * e.g. "6281234567890"). Retries once on a transient failure; logs and
 * gives up after that rather than throwing back into the webhook handler,
 * per the "one message failing shouldn't take down the batch" policy in
 * webhook.js.
 */
export async function sendMessage(phoneNumber, text) {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;

  if (!phoneNumberId || !accessToken) {
    throw new Error('Missing WHATSAPP_PHONE_NUMBER_ID or WHATSAPP_ACCESS_TOKEN environment variable.');
  }

  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}/messages`;
  const body = {
    messaging_product: 'whatsapp',
    to: phoneNumber,
    type: 'text',
    text: { body: text },
  };

  const attempt = async () => {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`WhatsApp send failed (${response.status}): ${errorBody}`);
    }

    return response.json();
  };

  try {
    return await attempt();
  } catch (firstError) {
    logger.warn('sendMessage failed, retrying once', { error: firstError.message });
    await sleep(1000);
    try {
      return await attempt();
    } catch (secondError) {
      logger.error('sendMessage failed after retry - giving up', { error: secondError.message });
      return null;
    }
  }
}
