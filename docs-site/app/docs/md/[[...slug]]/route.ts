import { getLlmText, markdownResponse } from '@/lib/get-llm-text';
import { source } from '@/lib/source';

type Props = { readonly params: Promise<{ readonly slug?: string[] }> };

export const dynamic = 'force-static';
export const dynamicParams = false;

export const generateStaticParams = (): Array<{ slug: string[] }> =>
  source.generateParams().map(({ slug }) => ({ slug: slug.length === 0 ? ['index'] : slug }));

export const GET = async (_request: Request, { params }: Props): Promise<Response> => {
  const { slug } = await params;
  const page = source.getPage(slug?.length === 1 && slug[0] === 'index' ? undefined : slug);
  return page ? markdownResponse(await getLlmText(page)) : markdownResponse('# Not found', 404);
};
