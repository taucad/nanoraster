type Node = { type: string; lang?: string | null; value?: string; children?: Node[] };

const toMermaidElement = (chart: string): Node =>
  ({
    type: 'mdxJsxFlowElement',
    name: 'Mermaid',
    attributes: [{ type: 'mdxJsxAttribute', name: 'chart', value: chart }],
    children: [],
  }) as Node;

const isMermaidFence = (node: Node): boolean =>
  node.type === 'code' && node.lang === 'mermaid' && typeof node.value === 'string';

/** Replace mermaid fences in place, depth-first. */
const convert = (node: Node): void => {
  if (!node.children) return;

  node.children = node.children.map((child) =>
    isMermaidFence(child) ? toMermaidElement(child.value ?? '') : child,
  );

  for (const child of node.children) convert(child);
};

/**
 * Turn ```mermaid fences into `<Mermaid>` elements before the syntax
 * highlighter reaches them, so humans get a drawn diagram.
 *
 * The agent-facing markdown is restored by the matching case in
 * `llm-stringify-mdx.ts`, which writes the fence back out. The two must stay
 * paired: without the stringifier case, converting here would delete every
 * diagram from the markdown endpoints.
 *
 * Walks the tree directly rather than depending on `unist-util-visit`, which
 * this project does not otherwise need.
 */
export const remarkMermaid =
  () =>
  (tree: Node): void => {
    convert(tree);
  };
