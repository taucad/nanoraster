import type { DocEntry, GeneratedDoc, RawTag } from 'fumadocs-typescript';

type MdxJsxAttribute = {
  readonly type: 'mdxJsxAttribute';
  readonly name: string;
  readonly value:
    | string
    | undefined
    | { readonly type: 'mdxJsxAttributeValueExpression'; readonly value: string };
};

type MdxJsxElement = {
  readonly type: 'mdxJsxFlowElement' | 'mdxJsxTextElement';
  readonly name: string;
  readonly attributes: readonly MdxJsxAttribute[];
};

const collapseWhitespace = (value: string): string => value.replaceAll(/\s+/g, ' ').trim();
const relaxMdxCurlyEscapes = (value: string): string => value.replaceAll(/\\([{}])/g, '$1');

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isRawTag = (value: unknown): value is RawTag =>
  isRecord(value) && typeof value['name'] === 'string' && typeof value['text'] === 'string';

const isDocEntry = (value: unknown): value is DocEntry =>
  isRecord(value) &&
  typeof value['name'] === 'string' &&
  typeof value['description'] === 'string' &&
  typeof value['type'] === 'string' &&
  typeof value['simplifiedType'] === 'string' &&
  Array.isArray(value['tags']) &&
  value['tags'].every(isRawTag) &&
  typeof value['required'] === 'boolean' &&
  typeof value['deprecated'] === 'boolean';

const isGeneratedDoc = (value: unknown): value is GeneratedDoc =>
  isRecord(value) &&
  typeof value['id'] === 'string' &&
  typeof value['name'] === 'string' &&
  (value['description'] === undefined || typeof value['description'] === 'string') &&
  Array.isArray(value['entries']) &&
  value['entries'].every(isDocEntry);

const isMdxJsxElement = (value: unknown): value is MdxJsxElement =>
  isRecord(value) &&
  (value['type'] === 'mdxJsxFlowElement' || value['type'] === 'mdxJsxTextElement') &&
  typeof value['name'] === 'string' &&
  Array.isArray(value['attributes']) &&
  value['attributes'].every(
    (attribute) =>
      isRecord(attribute) && attribute['type'] === 'mdxJsxAttribute' && typeof attribute['name'] === 'string',
  );

const readGeneratedDoc = (node: MdxJsxElement): GeneratedDoc | undefined => {
  const attribute = node.attributes.find(({ name }) => name === 'type');
  const raw =
    typeof attribute?.value === 'string'
      ? attribute.value
      : attribute?.value?.type === 'mdxJsxAttributeValueExpression'
        ? attribute.value.value
        : undefined;
  if (!raw) return undefined;

  try {
    const value: unknown = JSON.parse(raw);
    return isGeneratedDoc(value) ? value : undefined;
  } catch {
    return undefined;
  }
};

const formatEntry = (entry: DocEntry): string => {
  const metadata = [`\`${collapseWhitespace(entry.type)}\``, entry.required ? 'required' : 'optional'];
  if (entry.deprecated) metadata.push('deprecated');
  const defaultTag = entry.tags.find(({ name }) => name === 'default');
  if (defaultTag) metadata.push(`default \`${relaxMdxCurlyEscapes(defaultTag.text)}\``);

  const description = collapseWhitespace(entry.description);
  return `- **\`${entry.name}\`** (${metadata.join(', ')})${description ? ` — ${description}` : ''}`;
};

const formatDocument = (document: GeneratedDoc): string => {
  const description = document.description ? ` — ${collapseWhitespace(document.description)}` : '';
  const properties = document.entries.length
    ? document.entries.map(formatEntry).join('\n')
    : '_No properties._';
  return `**\`${document.name}\`**${description}\n\n${properties}`;
};

/** Write a `<Mermaid>` element back out as the ```mermaid fence it came from. */
const formatMermaid = (node: MdxJsxElement): string | undefined => {
  const attribute = node.attributes.find(({ name }) => name === 'chart');
  const chart = typeof attribute?.value === 'string' ? attribute.value : undefined;
  return chart === undefined ? undefined : `\`\`\`mermaid\n${chart}\n\`\`\``;
};

/**
 * Render components as text for agents: TypeTable data as property bullets,
 * and Mermaid elements as the diagram source they were authored from.
 */
export const llmStringifyMdx = (...args: readonly unknown[]): string | undefined => {
  const [node] = args;
  if (!isMdxJsxElement(node)) return undefined;
  if (node.name === 'Mermaid') return formatMermaid(node);
  if (node.name !== 'TypeTable') return undefined;
  const document = readGeneratedDoc(node);
  return document ? formatDocument(document) : undefined;
};
