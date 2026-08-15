import defaultMdxComponents from 'fumadocs-ui/mdx';
import type { MDXComponents } from 'mdx/types';

import { ApiTypeTable } from '@/components/api-type-table';

export const getMDXComponents = (components?: MDXComponents): MDXComponents => ({
  ...defaultMdxComponents,
  TypeTable: ApiTypeTable,
  ...components,
});
