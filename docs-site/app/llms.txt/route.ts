import { llms } from 'fumadocs-core/source';

import { getMarkdownPath, markdownResponse } from '@/lib/get-llm-text';
import { source } from '@/lib/source';

export const dynamic = 'force-static';

export const GET = (): Response => {
  const index = source
    .getPages()
    .reduce(
      (markdown, page) =>
        markdown.replace(`](${page.url})`, `](https://nanoraster.xyz${getMarkdownPath(page.url)})`),
      llms(source).index(),
    );
  return markdownResponse(index);
};
