import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { DocsBody, DocsDescription, DocsPage, DocsTitle } from 'fumadocs-ui/page';
import { MarkdownCopyButton } from 'fumadocs-ui/layouts/docs/page';
import { buttonVariants } from 'fumadocs-ui/components/ui/button';

import { getMDXComponents } from '@/mdx-components';
import { getMarkdownPath } from '@/lib/get-llm-text';
import { source } from '@/lib/source';

type Props = { readonly params: Promise<{ readonly slug?: string[] }> };

const Page = async ({ params }: Props): Promise<React.JSX.Element> => {
  const page = source.getPage((await params).slug);
  if (!page) notFound();
  const Body = page.data.body;
  const markdownPath = getMarkdownPath(page.url);
  return (
    <DocsPage toc={page.data.toc} full={page.data.full}>
      <DocsTitle>{page.data.title}</DocsTitle>
      <DocsDescription>{page.data.description}</DocsDescription>
      <div className="flex items-center gap-2 border-b pb-6 pt-2">
        <MarkdownCopyButton markdownUrl={markdownPath} />
        <a href={markdownPath} className={buttonVariants({ color: 'secondary', size: 'sm' })}>
          Open Markdown
        </a>
      </div>
      <DocsBody>
        <Body components={getMDXComponents()} />
      </DocsBody>
    </DocsPage>
  );
};

export default Page;

export const generateStaticParams = (): Array<{ slug: string[] }> => source.generateParams();

export const generateMetadata = async ({ params }: Props): Promise<Metadata> => {
  const page = source.getPage((await params).slug);
  return page ? { title: page.data.title, description: page.data.description } : {};
};
