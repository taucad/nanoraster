import type { ReactNode } from 'react';
import { DocsLayout } from 'fumadocs-ui/layouts/docs';

import { TauAttributionFooter } from '@/components/tau-attribution-footer';
import { source } from '@/lib/source';
import packageManifest from '../../../package.json';

const Layout = ({ children }: { readonly children: ReactNode }): React.JSX.Element => (
  <DocsLayout
    nav={{
      title: (
        <>
          <img alt="" className="h-5 w-5" src="/logo.svg" />
          {`nanoraster ${packageManifest.version}`}
        </>
      ),
    }}
    sidebar={{ footer: <TauAttributionFooter /> }}
    tree={source.pageTree}
  >
    {children}
  </DocsLayout>
);

export default Layout;
