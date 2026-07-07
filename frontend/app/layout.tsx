import type { ReactNode } from 'react';

export const metadata = {
  title: 'Finance Assistant',
  description: 'Personal finance dashboard - companion to the WhatsApp assistant.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  // TODO: wrap with auth/session provider once NextAuth is wired up
  return (
    <html lang="id">
      <body>{children}</body>
    </html>
  );
}
