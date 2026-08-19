import type { NextConfig } from 'next';
import { createMDX } from 'fumadocs-mdx/next';

const config: NextConfig = {
  output: 'export',
  reactStrictMode: true,
  turbopack: { root: new URL('..', import.meta.url).pathname },
  /**
   * `next dev` only: `output: 'export'` drops custom routes (the `export-no-custom-routes` warning
   * at build is expected). Production serves the same URLs as real files, aliased post-build by
   * `scripts/emit-mdx-aliases.mjs`. A redirect rather than a rewrite: Next 16's dev export check
   * 500s a rewritten URL that is not itself a prerendered path, whereas the redirected request
   * renders the generator route directly.
   */
  redirects: () =>
    Promise.resolve([{ source: '/docs/:path+.mdx', destination: '/llms.mdx/:path*', permanent: false }]),
};

export default createMDX()(config);
