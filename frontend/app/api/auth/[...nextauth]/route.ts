// Auth.js v5 route handler - all config lives in the root auth.ts file
// per v5 convention. See auth.ts for providers, callbacks, and the
// Google<->phone-number linking logic.

import { handlers } from '@/auth';

export const { GET, POST } = handlers;
