// Route protection. Redirects unauthenticated requests away from
// /dashboard/* to /login, preserving the originally-requested path so
// the login page can send them back after signing in.
//
// See docs/SPECIFICATION.md section 2 (Dashboard Philosophy) - the
// dashboard is never public, every route under it requires a linked
// Google session (see auth.ts).
//
// Uses auth.config.ts (Edge Runtime-safe) rather than importing auth.ts
// directly - middleware runs on Vercel's Edge Runtime, which cannot load
// auth.ts's Node.js-only DB callbacks (getSupabaseAdminClient).

import NextAuth from 'next-auth';
import { NextResponse } from 'next/server';
import authConfig from './auth.config';

const { auth } = NextAuth(authConfig);

export default auth((req) => {
  const isLoggedIn = Boolean(req.auth);
  const isProtectedRoute = req.nextUrl.pathname.startsWith('/dashboard');

  if (isProtectedRoute && !isLoggedIn) {
    const loginUrl = new URL('/login', req.nextUrl.origin);
    loginUrl.searchParams.set('callbackUrl', req.nextUrl.pathname);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
});

export const config = {
  matcher: ['/dashboard/:path*'],
};
