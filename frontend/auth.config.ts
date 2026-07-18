import type { NextAuthConfig } from 'next-auth';
import Google from 'next-auth/providers/google';

// Edge Runtime-safe subset of the Auth.js config - imported by
// middleware.ts (which runs on Vercel's Edge Runtime and cannot use
// Node.js-only APIs). Deliberately excludes the signIn/jwt/session
// callbacks in auth.ts, since those call getSupabaseAdminClient()
// (Node-only) to check/bind google_id <-> phone_number. Middleware only
// needs to know "is there a session at all", not the DB-backed details -
// see auth.ts for the full config used everywhere else (API routes,
// Server Components).

export default {
  // Workaround for a widely-reported unresolved next-auth v5 beta bug
  // (many open/closed GitHub issues, no single confirmed root cause) where
  // the PKCE code_verifier cookie fails to parse on the OAuth callback,
  // surfacing as "InvalidCheck: pkceCodeVerifier value could not be
  // parsed." trustHost avoids a related class of host-mismatch cookie
  // issues some reporters found this fixed.
  trustHost: true,
  providers: [
    Google({
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      // PKCE is most valuable for PUBLIC clients that can't hold a
      // secret (e.g. mobile/SPA apps). This is a confidential client -
      // GOOGLE_CLIENT_SECRET is validated server-side on every token
      // exchange - so dropping PKCE and keeping the "state" check
      // (CSRF protection) is a reasonable, deliberate tradeoff to route
      // around the cookie bug above, not a meaningful security
      // reduction for this setup.
      checks: ['state'],
    }),
  ],
  pages: {
    signIn: '/login',
  },
} satisfies NextAuthConfig;
