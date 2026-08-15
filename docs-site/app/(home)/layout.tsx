import type { ReactNode } from 'react';
import { HomeLayout } from 'fumadocs-ui/layouts/home';

import { baseOptions, homeLinks } from '../layout.config';

const HomeShellLayout = ({ children }: { readonly children: ReactNode }): React.JSX.Element => (
  <HomeLayout {...baseOptions} links={homeLinks}>
    {children}
  </HomeLayout>
);

export default HomeShellLayout;
