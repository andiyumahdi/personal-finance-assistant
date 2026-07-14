import type { DefaultSession } from 'next-auth';

// Type augmentation for the custom fields attached in auth.ts's session/jwt
// callbacks. Without this, TypeScript doesn't know about session.user.id /
// phoneNumber / nickname, or the equivalent JWT fields.

declare module 'next-auth' {
  interface Session {
    user: {
      id?: string;
      phoneNumber?: string;
      nickname?: string;
    } & DefaultSession['user'];
  }
}

declare module 'next-auth/jwt' {
  interface JWT {
    dbUserId?: string;
    phoneNumber?: string;
    nickname?: string;
  }
}
