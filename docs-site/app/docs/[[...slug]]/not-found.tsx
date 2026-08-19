import Link from 'next/link';
import { DocsBody, DocsDescription, DocsPage, DocsTitle } from 'fumadocs-ui/page';

/**
 * Renders the `notFound()` thrown by the docs page for an unknown slug, so a mistyped
 * `/docs/*` URL reads as a 404 inside the docs shell rather than as Next's bare fallback.
 * Production serves `out/404.html` instead; this is what `next dev` shows.
 *
 * With `output: 'export'` the dev server also validates the requested URL against
 * `generateStaticParams()` before rendering, and answers 500 when its static-paths cache is
 * cold. Once the cache is warm — any real page loaded first, i.e. every case that starts
 * from a link — the render proceeds and this page answers.
 */
const NotFound = (): React.JSX.Element => (
  <DocsPage>
    <DocsTitle>Page not found</DocsTitle>
    <DocsDescription>That documentation URL does not exist.</DocsDescription>
    <DocsBody>
      <p>
        Start again from the <Link href="/docs">quick start</Link>, or pick a page from the sidebar.
      </p>
    </DocsBody>
  </DocsPage>
);

export default NotFound;
