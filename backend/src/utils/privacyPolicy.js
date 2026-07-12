// Static privacy policy content, served at GET /privacy-policy. This
// exists specifically to satisfy Meta's App Publish requirement (a
// Privacy Policy URL is mandatory before an app can be published,
// regardless of app size) - see docs/whatsapp-cloud-api-setup.md.
//
// Kept honest and proportionate to what this project actually is: a
// personal, non-commercial WhatsApp finance tracker for the developer and
// a small group of friends - not a claim of enterprise-grade data
// handling this project doesn't have.

export const PRIVACY_POLICY_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Privacy Policy - Personal Finance Assistant</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body { font-family: system-ui, sans-serif; max-width: 640px; margin: 40px auto; padding: 0 20px; line-height: 1.6; color: #222; }
    h1 { font-size: 1.5rem; }
    h2 { font-size: 1.1rem; margin-top: 2rem; }
  </style>
</head>
<body>
  <h1>Privacy Policy</h1>
  <p>Last updated: 2026-07-11</p>

  <p>This is a personal, non-commercial project. It is used by its developer
  and a small, invited group of friends to track personal income and
  expenses via WhatsApp. It is not a commercial product, and is not offered
  to the general public.</p>

  <h2>What data is collected</h2>
  <p>When you message this WhatsApp number, the following is stored:</p>
  <ul>
    <li>Your WhatsApp phone number</li>
    <li>The text content of messages you send to the bot</li>
    <li>Financial data extracted from those messages (amount, category, whether it's income or expense)</li>
  </ul>

  <h2>How it's used</h2>
  <p>Solely to record and summarize your own personal financial transactions
  back to you, via WhatsApp replies and an optional web dashboard. Data is
  not sold, shared for advertising, or used for any purpose beyond providing
  this tracking feature to you.</p>

  <h2>Third-party processors</h2>
  <p>The following third-party services process data as part of how this
  project works, strictly as infrastructure providers:</p>
  <ul>
    <li><strong>Meta / WhatsApp</strong> - delivers messages between you and this service</li>
    <li><strong>Google Gemini API</strong> - processes message text to extract transaction data and generate replies</li>
    <li><strong>Supabase</strong> - hosts the database where your data is stored</li>
  </ul>

  <h2>Data retention and deletion</h2>
  <p>Data is retained as long as you continue using the service. Since this
  is a small personal project without a self-service deletion feature yet,
  you can request deletion of your data at any time by contacting the
  developer directly.</p>

  <h2>Contact</h2>
  <p>This project is maintained by its developer for personal use. If you
  have questions about your data, reach out directly via WhatsApp using the
  same number this bot operates on.</p>
</body>
</html>`;
