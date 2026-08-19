import type { ReactNode } from 'react';
import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';

import packageManifest from '../../package.json';

/**
 * Nav brand: the mark plus the name. The mark ships with no ground of its
 * own, so it sits directly on the nav surface in either theme.
 */
export const NavTitle = (): ReactNode => (
  <span className="flex items-center gap-2 font-semibold tracking-tight">
    {/* Plain img, not next/image: an inline SVG mark needs no optimisation. */}
    <img alt="" className="h-6 w-6" src="/logo.svg" />
    nanoraster
  </span>
);

/**
 * Shared chrome for the marketing page and the docs, so the two carry one
 * nav, one theme switch, and one GitHub link between them.
 */
export const baseOptions: BaseLayoutProps = {
  githubUrl: 'https://github.com/taucad/nanoraster',
  nav: { title: <NavTitle /> },
};

/**
 * Top-level links for the marketing page only. The docs already carry the
 * same destinations in their sidebar tree, where repeating them reads as
 * duplicated navigation.
 */
export const homeLinks: BaseLayoutProps['links'] = [
  { text: 'Quick start', url: '/docs' },
  { text: 'Guides', url: '/docs/guides/frame-the-model' },
  { text: 'API', url: '/docs/api' },
];

/** The published version, shown beside the docs nav title. */
export const packageVersion = packageManifest.version;
