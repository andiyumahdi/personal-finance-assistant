// Consumes the one-time magic link the WhatsApp bot sends
// (SPECIFICATION.md section 2.5): https://<dashboard>/link?token=<token>
//
// This route is NOT explicitly listed in the originally bootstrapped
// folder structure (SPECIFICATION.md section 6 only listed
// app/(auth)/login/) - it's added now because section 2.5's flow requires
// somewhere to land the magic link and hand off into Google sign-in. It's
// a Route Handler, not a page, because setting a cookie requires request/
// response access that a plain Server Component doesn't have.
//
// The actual token validation + single-use consumption happens in
// auth.ts's signIn callback - this route only carries the token from the
// URL into a short-lived httpOnly cookie, then redirects into the Google
// sign-in flow.

import { NextRequest, NextResponse } from 'next/server';

export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get('token');

  if (!token) {
    return NextResponse.redirect(new URL('/login?error=no_link_token', request.url));
  }

  const response = NextResponse.redirect(
    new URL('/api/auth/signin/google?callbackUrl=/dashboard', request.url),
  );

  response.cookies.set('pfa_link_token', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    // Matches the link token's own expiry window (SPECIFICATION.md
    // section 2.5: "~10 minutes" for the one-time link).
    maxAge: 60 * 10,
    path: '/',
  });

  return response;
}
