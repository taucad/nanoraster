import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { RootProvider } from 'fumadocs-ui/provider/next';

import './global.css';

export const metadata: Metadata = {
  description: 'Tiny headless WebGPU GLTF renderer for deterministic PNG, WebP, and JPEG output.',
  metadataBase: new URL('https://nanoraster.tau.new'),
  title: { default: 'nanoraster', template: `%s — nanoraster` },
};

const Layout = ({ children }: { readonly children: ReactNode }): React.JSX.Element => (
  <html lang="en" suppressHydrationWarning>
    <body>
      <RootProvider>{children}</RootProvider>
    </body>
  </html>
);

export default Layout;
