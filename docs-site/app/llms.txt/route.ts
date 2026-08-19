import { llms } from 'fumadocs-core/source';

import { markdownResponse } from '@/lib/get-llm-text';
import { source } from '@/lib/source';

export const dynamic = 'force-static';

export const GET = (): Response =>
  markdownResponse(
    // Point agents at the Markdown projection rather than the HTML page.
    llms(source)
      .index()
      .replaceAll(/\]\((\/docs[^)\s]*)\)/gu, '](https://www.nanoraster.xyz$1.mdx)'),
  );
