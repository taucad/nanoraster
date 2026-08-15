import type { ReactNode } from 'react';
import { DocsLayout } from 'fumadocs-ui/layouts/docs';

import { TauAttributionFooter } from '@/components/tau-attribution-footer';
import { source } from '@/lib/source';
import { baseOptions, packageVersion } from '../layout.config';

const Layout = ({ children }: { readonly children: ReactNode }): React.JSX.Element => (
  <DocsLayout
    {...baseOptions}
    nav={{
      ...baseOptions.nav,
      children: <span className="text-fd-muted-foreground text-xs">{packageVersion}</span>,
    }}
    sidebar={{ footer: <TauAttributionFooter /> }}
    tree={source.pageTree}
  >
    {children}
  </DocsLayout>
);

export default Layout;
