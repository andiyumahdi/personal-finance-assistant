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
  providers: [
    Google({
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    }),
  ],
  pages: {
    signIn: '/login',
  },
} satisfies NextAuthConfig;
