import { getLlmText, markdownResponse } from '@/lib/get-llm-text';
import { source } from '@/lib/source';

export const dynamic = 'force-static';

export const GET = async (): Promise<Response> => {
  const pages = await Promise.all(source.getPages().map(getLlmText));
  return markdownResponse(pages.join('\n\n---\n\n'));
};
