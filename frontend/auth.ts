import NextAuth from 'next-auth';
import { cookies } from 'next/headers';
import authConfig from './auth.config';
import { getSupabaseAdminClient } from './lib/supabaseAdmin';

// Full Auth.js v5 config - Node.js runtime only (API routes, Server
// Components, Server Actions). Extends the Edge-safe authConfig
// (auth.config.ts) with the DB-backed callbacks that middleware.ts must
// NOT load. See docs/SPECIFICATION.md section 2.5 (Dashboard Account
// Linking) and section 11.5 (Security Review).
//
// Identity model: WhatsApp phone number is the PRIMARY identity (a users
// row is created the moment someone first messages the bot - see
// backend/src/db/queries/users.js). Google sign-in only ever LINKS an
// existing phone-number row to a google_id - it never creates a new
// identity on its own. A cold Google sign-in with no prior WhatsApp
// contact and no valid link token is rejected outright.

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  session: { strategy: 'jwt' },
  callbacks: {
    /**
     * Decides whether a Google sign-in is allowed to proceed. Returning
     * `true` allows it; returning a string redirects to that path instead
     * (used here to send the user back to /login with an error code).
     */
    async signIn({ profile }) {
      if (!profile?.sub) return false;

      const supabase = getSupabaseAdminClient();

      // Returning user - google_id already linked to a phone-number row.
      const { data: existingUser } = await supabase
        .from('users')
        .select('id')
        .eq('google_id', profile.sub)
        .maybeSingle();

      if (existingUser) {
        return true;
      }

      // First-time sign-in: requires a valid, unexpired, single-use link
      // token - set as a cookie by app/link/route.ts when the user clicks
      // the magic link the bot sent them. No cookie means this is a cold
      // Google sign-in with no prior WhatsApp contact - reject it (see
      // module doc comment above).
      const cookieStore = await cookies();
      const linkToken = cookieStore.get('pfa_link_token')?.value;

      if (!linkToken) {
        return '/login?error=no_link_token';
      }

      const { data: pendingUser, error: lookupError } = await supabase
        .from('users')
        .select('id, link_token_expires')
        .eq('link_token', linkToken)
        .maybeSingle();

      if (lookupError || !pendingUser) {
        return '/login?error=invalid_link_token';
      }
      if (!pendingUser.link_token_expires || new Date(pendingUser.link_token_expires) < new Date()) {
        return '/login?error=expired_link_token';
      }

      // Bind + invalidate the token in the same update - single-use, per
      // SPECIFICATION.md section 11.5.
      const { error: updateError } = await supabase
        .from('users')
        .update({ google_id: profile.sub, link_token: null, link_token_expires: null })
        .eq('id', pendingUser.id);

      if (updateError) {
        return '/login?error=link_failed';
      }

      return true;
    },

    /**
     * Runs on sign-in (profile is only present then) and on every
     * subsequent token refresh (profile is undefined - the previously
     * stored fields just pass through unchanged).
     */
    async jwt({ token, profile }) {
      if (profile?.sub) {
        const supabase = getSupabaseAdminClient();
        const { data } = await supabase
          .from('users')
          .select('id, phone_number, nickname')
          .eq('google_id', profile.sub)
          .maybeSingle();

        if (data) {
          token.dbUserId = data.id;
          token.phoneNumber = data.phone_number;
          token.nickname = data.nickname ?? undefined;
        }
      }
      return token;
    },

    /** Exposes the internal DB user id + phone number on the session object. */
    async session({ session, token }) {
      if (session.user) {
        session.user.id = token.dbUserId as string;
        session.user.phoneNumber = token.phoneNumber as string | undefined;
        session.user.nickname = token.nickname as string | undefined;
      }
      return session;
    },
  },
});
