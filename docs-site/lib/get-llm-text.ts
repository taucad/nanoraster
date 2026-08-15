import { source } from '@/lib/source';

const origin = 'https://nanoraster.xyz';

export const getMarkdownPath = (pageUrl: string): string =>
  pageUrl === '/docs' ? '/docs/md/index' : `/docs/md${pageUrl.slice('/docs'.length)}`;

export const getLlmText = async (page: (typeof source)['$inferPage']): Promise<string> => {
  const processed = (await page.data.getText('processed')).trim();
  return `# ${page.data.title}\n\n${page.data.description}\n\nCanonical page: ${origin}${page.url}\n\n${processed}`;
};

export const markdownResponse = (body: string, status = 200): Response =>
  new Response(body, {
    status,
    headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
  });
