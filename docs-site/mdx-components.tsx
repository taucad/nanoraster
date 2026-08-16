import defaultMdxComponents from 'fumadocs-ui/mdx';
import type { MDXComponents } from 'mdx/types';

import { ApiTypeTable } from '@/components/api-type-table';
import { Mermaid } from '@/components/mermaid';
import { RenderDemo } from '@/components/render-demo';

export const getMDXComponents = (components?: MDXComponents): MDXComponents => ({
  ...defaultMdxComponents,
  Mermaid,
  RenderDemo,
  TypeTable: ApiTypeTable,
  ...components,
});
