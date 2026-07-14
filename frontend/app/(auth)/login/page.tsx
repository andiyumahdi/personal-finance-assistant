// Login page. Functional only for now - visual design comes from Lovable
// once finalized (see docs/ROADMAP.md "Revised Priority Order" - avoiding
// wiring the UI twice). Auth is Google OAuth via Auth.js, bound to a
// WhatsApp phone number through a one-time link token (see
// docs/SPECIFICATION.md section 2.5 and ../../link/route.ts).

import { signIn } from '@/auth';

const ERROR_MESSAGES: Record<string, string> = {
  no_link_token:
    'Kamu perlu chat bot WhatsApp dulu buat dapetin link login - belum bisa login langsung dari sini.',
  invalid_link_token: 'Link login ini nggak valid. Coba minta link baru dari bot WhatsApp.',
  expired_link_token: 'Link login ini udah kedaluwarsa. Coba minta link baru dari bot WhatsApp.',
  link_failed: 'Gagal nyambungin akun Google kamu. Coba lagi ya.',
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; callbackUrl?: string }>;
}) {
  const params = await searchParams;
  const errorMessage = params.error ? ERROR_MESSAGES[params.error] : null;

  return (
    <div>
      <h1>Masuk ke Dashboard</h1>
      {errorMessage && <p role="alert">{errorMessage}</p>}
      <form
        action={async () => {
          'use server';
          await signIn('google', { redirectTo: params.callbackUrl || '/dashboard' });
        }}
      >
        <button type="submit">Login dengan Google</button>
      </form>
    </div>
  );
}
