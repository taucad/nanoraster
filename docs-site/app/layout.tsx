import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { RootProvider } from 'fumadocs-ui/provider/next';

import './global.css';

export const metadata: Metadata = {
  description: 'Tiny headless WebGPU GLTF renderer for deterministic PNG, WebP, and JPEG output.',
  icons: {
    apple: '/favicon.ico',
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
