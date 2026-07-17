import type { ReactNode } from 'react';
import { Inter, JetBrains_Mono } from 'next/font/google';
import { SessionProvider } from 'next-auth/react';
import { ThemeProvider } from '@/components/theme-provider';
import { Toaster } from '@/components/ui/sonner';
import './globals.css';

// Ported from Lovable's design (src/routes/__root.tsx) - using next/font
// instead of manual <link> tags, which is the Next.js-idiomatic way to
// load Google Fonts (self-hosted at build time, no runtime request to
// fonts.googleapis.com, better performance than the original approach).
const inter = Inter({ subsets: ['latin'], variable: '--font-inter' });
const jetbrainsMono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-mono' });

export const metadata = {
  title: 'Nera — Personal finance, clarified',
  description:
    'Nera is a calm, premium personal finance dashboard for tracking spending, cashflow, and savings goals.',
};

// Prevents a flash of the wrong theme on first paint - reads the same
// localStorage key the ThemeProvider uses, applies the class before React
// hydrates. Ported as-is from Lovable's root route.
const themeInitScript = `(function(){try{var t=localStorage.getItem('nera-theme')||'system';var m=window.matchMedia('(prefers-color-scheme: dark)').matches;var d=t==='dark'||(t==='system'&&m);var r=document.documentElement;if(d)r.classList.add('dark');r.style.colorScheme=d?'dark':'light';}catch(e){}})();`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${jetbrainsMono.variable}`}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body>
        <SessionProvider>
          <ThemeProvider>
            {children}
            <Toaster position="top-right" richColors closeButton />
          </ThemeProvider>
        </SessionProvider>
      </body>
    </html>
  );
}
