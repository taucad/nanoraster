import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { RootProvider } from 'fumadocs-ui/provider/next';

import './global.css';

export const metadata: Metadata = {
  description: 'Tiny headless WebGPU glTF renderer for deterministic PNG, WebP, JPEG, and raw RGBA output.',
  icons: {
    // iOS masks the icon itself, so this one is full-bleed and opaque
    // rather than the rounded, transparent-cornered tile.
    apple: { sizes: '180x180', url: '/apple-touch-icon.png' },
    icon: [
      { url: '/favicon.svg', type: 'image/svg+xml' },
      { url: '/favicon.ico', sizes: '32x32' },
    ],
  },
  metadataBase: new URL('https://nanoraster.xyz'),
  title: { default: 'nanoraster', template: `%s — nanoraster` },
};

const Layout = ({ children }: { readonly children: ReactNode }): React.JSX.Element => (
  <html lang="en" suppressHydrationWarning>
    <body className="flex min-h-screen flex-col">
      <RootProvider>{children}</RootProvider>
    </body>
  </html>
);

export default Layout;
