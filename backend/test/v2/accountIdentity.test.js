// V2 Phase 5 (UX contract A-1/A-2/A-3/A-4/A-5/A-7/A-10, DEC-1, audit G5/G6):
// account identity and auth replies through the real pipeline. Locks:
//   - A-2 (DEC-1): the WHICH-account ask answers the EXACT stored
//     users.google_email when linked, brief section 18 branch 2 when the
//     legacy row has none, "Belum ada akun Google ..." + the bot token flow
//     when unlinked - never a guess, zero AI, zero writes;
//   - A-3: the linked-state replies CARRY the identity on the same line -
//     "akun Google yang sama" may never appear without google_email (the
//     source-level grep pin lives in test/unit/accountCopyPins.test.js);
//   - A-4: "ganti akun Google" gets the switching flow (logout -> login
//     akun lain + CR-4 "data stays with the WhatsApp number"), never the
//     generic login bullets, and never mints a credential;
//   - A-5: "cara logout?" gets the concrete dashboard logout steps, never a
//     help-menu dump, never 'unclear'/classifier improvisation;
//   - A-1: "webnya mana?" still answers with the configured URL only;
//   - A-7: identity replies are per-row - user B's email never reaches
//     user A's reply (and vice versa);
//   - A-10 (chat side): the bot-issued token stays 10-min single-use;
//   - routing pins: the new gates claim their phrases and steal nothing
//     (nomor change, money sentences, amount-bearing record intents and
//     recap/list routes are all unchanged);
//   - zero AI on every static path (GC-6): aiProvider.extract THROWS by
//     default; generateReply/classifier/product calls are counted.
//
// All copy asserted here is the pinned UX-contract copy - changing an
// expectation means changing the contract first (SPEC/product contract
// wins over implementation).

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  handleIncomingMessage,
  detectIntent,
} from '../../src/whatsapp/messageHandler.js';
import { aiProvider } from '../../src/ai/aiProvider.js';
import {
  setSupabaseClientForTests,
  resetSupabaseClientForTests,
} from '../../src/db/supabaseClient.js';
import { createFakeSupabase } from '../helpers/fakeSupabase.js';

const PHONE_A = '+62811000777';
const PHONE_B = '+62811000888';

const HOUR = 60 * 60 * 1000;
function ago(ms) {
  return new Date(Date.now() - ms).toISOString();
}

const originalExtract = aiProvider.extract;
const originalGenerateReply = aiProvider.generateReply;
const originalClassifyIntent = aiProvider.classifyIntent;
const originalAnswerProductQuestion = aiProvider.answerProductQuestion;

let fake;
let counts;

function seedRow(id, phone, overrides = {}) {
  return {
    id,
    phone_number: phone,
    state: 'IDLE',
    state_context: {},
    last_deleted_transaction_id: null,
    google_id: null,
    google_email: null,
    link_token: null,
    link_token_expires: null,
    created_at: ago(10 * 24 * HOUR),
    ...overrides,
  };
}

beforeEach(() => {
  fake = createFakeSupabase({
    users: [seedRow('user-a', PHONE_A)],
    wallets: [],
    transactions: [],
  });
  setSupabaseClientForTests(fake);

  counts = { replies: 0, extracts: 0, classified: 0, products: 0 };
  aiProvider.extract = async () => {
    counts.extracts += 1;
    throw new Error('unexpected Gemini extraction call in a static account flow');
  };
  aiProvider.generateReply = async (intent) => {
    counts.replies += 1;
    return { text: `STUB_REPLY:${intent}`, prompt_version: 'v-test' };
  };
  aiProvider.classifyIntent = async () => {
    counts.classified += 1;
    throw new Error('unexpected classifier call in a static account flow');
  };
  aiProvider.answerProductQuestion = async () => {
    counts.products += 1;
    return { text: 'STUB_PRODUCT_ANSWER', prompt_version: 'v-test' };
  };
});

afterEach(() => {
  aiProvider.extract = originalExtract;
  aiProvider.generateReply = originalGenerateReply;
  aiProvider.classifyIntent = originalClassifyIntent;
  aiProvider.answerProductQuestion = originalAnswerProductQuestion;
  resetSupabaseClientForTests();
});

function userRow(phone = PHONE_A) {
  return fake.tables.users.find((u) => u.phone_number === phone);
}

function linkUser({ email = null } = {}) {
  const row = userRow(PHONE_A);
  row.google_id = 'google-a';
  row.google_email = email;
  return row;
}

function assertNoAi() {
  assert.equal(counts.extracts, 0, 'no extraction call');
  assert.equal(counts.replies, 0, 'no persona reply call');
  assert.equal(counts.classified, 0, 'no classifier call');
  assert.equal(counts.products, 0, 'no product-knowledge call');
}

const tokenIn = (text) => /\/link\?token=/.test(String(text));

describe('A-2: the WHICH-account ask answers the exact identity (DEC-1)', () => {
  test('linked + stored email -> the exact address + the section-18 switch hint', async () => {
    linkUser({ email: 'andi@example.com' });
    const snapshot = JSON.stringify(userRow());

    const trace = await handleIncomingMessage(PHONE_A, 'akun google gua yang mana?');

    assert.equal(trace.intent, 'dashboard_link');
    assert.equal(trace.dashboardLinkOutcome, 'identity_read');
    assert.match(trace.reply, /Dashboard lo sekarang terhubung ke: \*andi@example\.com\*/);
    assert.match(trace.reply, /lo bisa logout lalu login pakai akun Google lain/);
    assert.match(trace.reply, /Data lo tetap nempel di nomor WhatsApp lo/);
    assert.ok(!tokenIn(trace.reply), 'an identity read never carries a credential');
    assert.equal(userRow().link_token, null, 'and never stores one');
    assert.equal(JSON.stringify(userRow()), snapshot, 'a read writes nothing');
    assert.equal(trace.dbAction, undefined);
    assertNoAi();
  });

  test('linked + NO stored email (legacy row) -> section 18 branch 2, no address invented', async () => {
    linkUser({ email: null });

    const trace = await handleIncomingMessage(PHONE_A, 'akun google gua yang mana?');

    assert.equal(trace.dashboardLinkOutcome, 'identity_read');
    assert.match(
      trace.reply,
      /Gue belum bisa melihat email Google yang terhubung dari sisi chat/,
      'the honest "cannot see" branch, brief section 18',
    );
    assert.match(trace.reply, /Settings -> Profile/);
    assert.ok(!trace.reply.includes('@'), 'never a fabricated address');
    assert.ok(!tokenIn(trace.reply));
    assertNoAi();
  });

  test('unlinked -> "Belum ada akun Google ..." + the real token flow, nothing minted', async () => {
    const trace = await handleIncomingMessage(PHONE_A, 'akun google gua yang mana?');

    assert.equal(trace.dashboardLinkOutcome, 'identity_read');
    assert.match(trace.reply, /Belum ada akun Google yang terhubung ke nomor ini/);
    assert.match(trace.reply, /Ketik \*dashboard\*/);
    assert.match(trace.reply, /berlaku 10 menit, sekali pakai/);
    assert.ok(!trace.reply.includes('@'), 'an unlinked user has no email to show');
    assert.ok(!tokenIn(trace.reply), 'asking never mints a credential');
    assert.equal(userRow().link_token, null);
    assertNoAi();
  });

  test('the identity sub-route also owns the sibling phrasings', async () => {
    linkUser({ email: 'andi@example.com' });

    for (const phrase of ['login pakai akun apa?', 'email gua yang mana?', 'akun google gue apa?']) {
      const trace = await handleIncomingMessage(PHONE_A, phrase);
      assert.equal(trace.dashboardLinkOutcome, 'identity_read', phrase);
      assert.match(trace.reply, /andi@example\.com/, phrase);
    }
    assertNoAi();
  });
});

describe('A-3: linked-state replies carry the identity (never bare "yang sama")', () => {
  test('question path, linked + email -> address AND the reassurance on the same reply', async () => {
    linkUser({ email: 'andi@example.com' });

    const trace = await handleIncomingMessage(PHONE_A, 'gimana cara login?');

    assert.equal(trace.dashboardLinkOutcome, 'informational');
    assert.match(trace.reply, /udah tersambung ke Google: andi@example\.com/);
    assert.match(trace.reply, /akun Google yang sama/);
    assert.equal(userRow().link_token, null);
    assertNoAi();
  });

  test('question path, linked + NO email -> reassurance without the bare "yang sama" phrase', async () => {
    linkUser({ email: null });

    const trace = await handleIncomingMessage(PHONE_A, 'gimana cara login?');

    assert.match(trace.reply, /udah tersambung ke Google/, 'the linked fact stays');
    assert.ok(
      !trace.reply.includes('akun Google yang sama'),
      'A-3: never "the same Google account" without an identity',
    );
    assert.match(trace.reply, /cek bagian Settings - Profile/, '...and says where to look');
    assertNoAi();
  });

  test('question path, unlinked -> no address, no linked claims (existing honesty pin)', async () => {
    const trace = await handleIncomingMessage(PHONE_A, 'gimana cara login?');

    assert.ok(!trace.reply.includes('@'), 'no invented email');
    assert.doesNotMatch(trace.reply, /Akun kamu udah tersambung/);
    assert.match(trace.reply, /link connect dari bot/);
    assertNoAi();
  });

  test('the plain "dashboard" command for a linked user names the account too', async () => {
    linkUser({ email: 'andi@example.com' });

    const trace = await handleIncomingMessage(PHONE_A, 'dashboard');

    assert.equal(trace.dashboardLinkOutcome, 'already_linked');
    assert.match(trace.reply, /udah kesambung ke dashboard kok: andi@example\.com/);
    assert.match(trace.reply, /akun Google yang sama/);
    assert.equal(userRow().link_token, null, 'no second credential is minted');
    assertNoAi();
  });

  test('...and when the legacy row has no email it points at Settings, never "yang sama"', async () => {
    linkUser({ email: null });

    const trace = await handleIncomingMessage(PHONE_A, 'dashboard');

    assert.equal(trace.dashboardLinkOutcome, 'already_linked');
    assert.match(trace.reply, /udah kesambung ke dashboard kok/);
    assert.ok(!trace.reply.includes('akun Google yang sama'), 'A-3 grep pin, behavior half');
    assert.match(trace.reply, /cek bagian Settings - Profile/);
    assert.equal(userRow().link_token, null);
    assertNoAi();
  });

  test('an email question with the linked state answers with the exact address', async () => {
    linkUser({ email: 'andi@example.com' });

    const trace = await handleIncomingMessage(PHONE_A, 'kenapa email gua dipake?');

    assert.ok(trace.reply.includes('andi@example.com'), 'exact value, DEC-1');
    assert.ok(!tokenIn(trace.reply));
    assert.equal(userRow().link_token, null);
    assertNoAi();
  });
});

describe('A-4: "ganti akun Google" -> the switching flow, never generic bullets', () => {
  test('statement form -> logout/login steps + CR-4, no credential, no AI', async () => {
    linkUser({ email: 'andi@example.com' });
    const snapshot = JSON.stringify(userRow());

    const trace = await handleIncomingMessage(PHONE_A, 'ganti akun google');

    assert.equal(trace.intent, 'dashboard_link', "never 'unclear' (audit G5)");
    assert.equal(trace.dashboardLinkOutcome, 'switch_help');
    assert.match(trace.reply, /\*Cara ganti akun Google:\*/);
    assert.match(trace.reply, /pilih \*Log out\*/, 'the real logout step, A-5-verified UI');
    assert.match(trace.reply, /Data lo tetap nempel di nomor WhatsApp lo/, 'CR-4');
    assert.match(trace.reply, /kegabung sama akun lain/, 'never merges (brief section 19)');
    assert.match(trace.reply, /Sambungin ulang ke akun baru dari nomor ini belum tersedia/, 'honest limit (PK 10)');
    assert.ok(
      !trace.reply.includes('- Login pakai akun Google.'),
      'the generic login bullets are exactly what this must never become',
    );
    assert.ok(!tokenIn(trace.reply), 'an explanation never mints a credential');
    assert.equal(userRow().link_token, null);
    assert.equal(JSON.stringify(userRow()), snapshot, 'zero writes');
    assertNoAi();
  });

  test('question form -> the same dedicated flow, not the facts bullets', async () => {
    linkUser({ email: 'andi@example.com' });

    const trace = await handleIncomingMessage(PHONE_A, 'cara ganti akun google?');

    assert.equal(trace.dashboardLinkOutcome, 'switch_help');
    assert.match(trace.reply, /\*Cara ganti akun Google:\*/);
    assert.ok(!trace.reply.includes('- Login pakai akun Google.'));
    assertNoAi();
  });

  test('unlinked -> "belum tersambung" + the fresh bot-token path (rebind is HERE)', async () => {
    const trace = await handleIncomingMessage(PHONE_A, 'ganti akun google dong');

    assert.equal(trace.dashboardLinkOutcome, 'switch_help');
    assert.match(trace.reply, /belum tersambung ke akun Google mana pun/);
    assert.match(trace.reply, /Ketik \*dashboard\*/);
    assert.ok(!tokenIn(trace.reply), 'the reply POINTS at the flow; it does not run it');
    assert.equal(userRow().link_token, null);
    assertNoAi();
  });
});

describe('A-5: "cara logout?" -> concrete steps, never a help dump or improvisation', () => {
  test('question form -> the verified avatar-menu steps, deterministic (intent pinned)', async () => {
    const trace = await handleIncomingMessage(PHONE_A, 'cara logout?');

    assert.equal(trace.intent, 'dashboard_link', "never 'unclear' -> classifier (audit G5)");
    assert.equal(trace.dashboardLinkOutcome, 'logout_help');
    assert.match(trace.reply, /\*Cara logout di dashboard:\*/);
    assert.match(trace.reply, /pojok kanan atas/, 'step 1 - the real UserMenu position');
    assert.match(trace.reply, /Pilih \*Log out\*/, 'step 2 - the real menu item');
    assert.match(trace.reply, /Log out of Nera\?/, 'step 3 - the real confirm dialog title');
    assert.match(trace.reply, /data lo tetap tersimpan/);
    assert.ok(
      !trace.reply.includes('Nera bisa bantu kamu'),
      'no help-menu dump',
    );
    assert.ok(!tokenIn(trace.reply));
    assert.equal(userRow().link_token, null);
    assertNoAi();
  });

  test('statement form and the dashboard-scoped phrasing land on the same steps', async () => {
    for (const phrase of ['logout dong', 'gimana cara logout di dashboard?']) {
      const trace = await handleIncomingMessage(PHONE_A, phrase);
      assert.equal(trace.dashboardLinkOutcome, 'logout_help', phrase);
      assert.match(trace.reply, /Cara logout di dashboard/, phrase);
    }
    assertNoAi();
  });
});

describe('A-1 (keep): web discovery answers with the URL only', () => {
  test('"webnya mana?" -> the configured address, no credential, no identity claims', async () => {
    const previous = process.env.DASHBOARD_BASE_URL;
    process.env.DASHBOARD_BASE_URL = 'https://personal-finance-assistant-delta.vercel.app';
    try {
      const trace = await handleIncomingMessage(PHONE_A, 'webnya mana?');

      assert.equal(trace.intent, 'dashboard_link');
      assert.match(trace.reply, /personal-finance-assistant-delta\.vercel\.app/);
      assert.ok(!tokenIn(trace.reply));
      assert.equal(userRow().link_token, null);
      assertNoAi();
    } finally {
      if (previous === undefined) delete process.env.DASHBOARD_BASE_URL;
      else process.env.DASHBOARD_BASE_URL = previous;
    }
  });
});

describe('A-10 (chat half, keep): the bot-issued token stays 10-min single-use', () => {
  test('"dashboard" -> a real URL + expiry inside the 9.5-10.5 min window', async () => {
    const before = Date.now();
    const trace = await handleIncomingMessage(PHONE_A, 'dashboard');

    assert.equal(trace.dashboardLinkOutcome, 'token_issued');
    const stored = userRow();
    assert.ok(stored.link_token, 'the SPEC 2.5 flow still writes the token');
    const expiresMs = Date.parse(stored.link_token_expires);
    const expectedMs = before + 10 * 60 * 1000;
    assert.ok(
      Math.abs(expiresMs - expectedMs) < 30 * 1000,
      `expiry ${stored.link_token_expires} must be ~10 minutes out`,
    );
    assert.match(trace.reply, new RegExp(`/link\\?token=${stored.link_token}`));
    assertNoAi();
  });
});

describe('A-7: identity replies are per-row (cross-user isolation)', () => {
  test("user A sees A's address, user B sees B's - never the other way", async () => {
    fake.tables.users.push(
      seedRow('user-b', PHONE_B, { google_id: 'google-b', google_email: 'budi@example.com' }),
    );
    linkUser({ email: 'andi@example.com' });

    const replyA = await handleIncomingMessage(PHONE_A, 'akun google gua yang mana?');
    assert.match(replyA.reply, /andi@example\.com/);
    assert.ok(!replyA.reply.includes('budi@example.com'), 'B never leaks into A');

    const replyB = await handleIncomingMessage(PHONE_B, 'akun google gua yang mana?');
    assert.match(replyB.reply, /budi@example\.com/);
    assert.ok(!replyB.reply.includes('andi@example.com'), 'A never leaks into B');
    assertNoAi();
  });
});

describe('routing pins: the Phase 5 gates claim their phrases and steal nothing', () => {
  test('the new claims', () => {
    assert.equal(detectIntent('ganti akun google'), 'dashboard_link', 'A-4 statement');
    assert.equal(detectIntent('cara ganti akun google?'), 'dashboard_link', 'A-4 question');
    assert.equal(detectIntent('cara logout?'), 'dashboard_link', 'A-5 question');
    assert.equal(detectIntent('logout dong'), 'dashboard_link', 'A-5 statement');
    assert.equal(detectIntent('gue mau catat pengeluaran'), 'help', 'A-8 Journey A step 2');
    assert.equal(detectIntent('mau nyatet duit'), 'help', 'the informal spelling family');
  });

  test('everything the new gates must NOT touch', () => {
    assert.equal(detectIntent('ganti nomor wa'), 'product_question', 'PK 8 keeps its route');
    assert.equal(detectIntent('uang keluar dari rekening 50rb'), 'transaction', 'money sentences stay');
    assert.equal(detectIntent('halo, mau catet bayar listrik 150rb'), 'transaction', 'amount-bearing record intents stay');
    assert.equal(detectIntent('cara catat pengeluaran?'), 'product_question', 'how-to stays knowledge');
    assert.equal(detectIntent('gimana cara login?'), 'dashboard_link', 'generic login info unchanged');
    assert.equal(detectIntent('webnya mana?'), 'dashboard_link', 'A-1 discovery unchanged');
    assert.equal(detectIntent('akun google gua yang mana?'), 'dashboard_link', 'A-2 lands on its handler');
    assert.equal(detectIntent('jajan 20rb'), 'transaction', 'the core loop is untouched');
    assert.equal(detectIntent('ganti nama dompet BRI jadi BRI Syariah'), 'wallet_manage', 'wallet rename untouched');
  });
});
