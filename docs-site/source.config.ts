import { defineConfig, defineDocs } from 'fumadocs-mdx/config';
import { createGenerator, remarkAutoTypeTable } from 'fumadocs-typescript';

import { llmStringifyMdx } from './lib/llm-stringify-mdx';
import { remarkMermaid } from './lib/remark-mermaid';
import { remarkRenderDemo } from './lib/remark-render-demo';

const generator = createGenerator({ tsconfigPath: './tsconfig.json' });

export const docs = defineDocs({
  dir: 'content/docs',
  docs: {
    postprocess: {
      includeProcessedMarkdown: {
        stringify: (...args) => llmStringifyMdx(...args),
      },
    },
  },
});

export default defineConfig({
  mdxOptions: {
    remarkPlugins: [[remarkAutoTypeTable, { generator }], remarkMermaid, remarkRenderDemo],
  },
});
