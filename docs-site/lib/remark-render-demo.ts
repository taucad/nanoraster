type Attribute = { type: 'mdxJsxAttribute'; name: string; value?: unknown };
type Node = {
  type: string;
  name?: string;
  lang?: string | null;
  value?: string;
  attributes?: Attribute[];
  children?: Node[];
};

const firstCodeChild = (node: Node): Node | undefined =>
  node.children?.find((child) => child.type === 'code' && typeof child.value === 'string');

/**
 * Copy a `<RenderDemo>`'s fenced example into a `code` attribute, so the
 * component receives the source verbatim rather than the highlighter's output.
 *
 * The fence stays a child, which is what renders on the page and what the
 * stringifier emits for the markdown endpoints. The example is therefore
 * authored once and read three ways — displayed, executed, and serialised —
 * so a demo cannot drift from the code beside it.
 */
const inject = (node: Node): void => {
  if (node.type === 'mdxJsxFlowElement' && node.name === 'RenderDemo') {
    const code = firstCodeChild(node);
    if (code?.value !== undefined) {
      node.attributes ??= [];
      node.attributes.push(
        { type: 'mdxJsxAttribute', name: 'code', value: code.value },
        { type: 'mdxJsxAttribute', name: 'lang', value: code.lang ?? 'typescript' },
      );
    }
  }

  for (const child of node.children ?? []) inject(child);
};

export const remarkRenderDemo = () => (tree: Node): void => {
  inject(tree);
};
