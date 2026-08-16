// source.config.ts
import { defineConfig, defineDocs } from "fumadocs-mdx/config";
import { createGenerator, remarkAutoTypeTable } from "fumadocs-typescript";

// lib/llm-stringify-mdx.ts
var collapseWhitespace = (value) => value.replaceAll(/\s+/g, " ").trim();
var relaxMdxCurlyEscapes = (value) => value.replaceAll(/\\([{}])/g, "$1");
var isRecord = (value) => typeof value === "object" && value !== null;
var isRawTag = (value) => isRecord(value) && typeof value["name"] === "string" && typeof value["text"] === "string";
var isDocEntry = (value) => isRecord(value) && typeof value["name"] === "string" && typeof value["description"] === "string" && typeof value["type"] === "string" && typeof value["simplifiedType"] === "string" && Array.isArray(value["tags"]) && value["tags"].every(isRawTag) && typeof value["required"] === "boolean" && typeof value["deprecated"] === "boolean";
var isGeneratedDoc = (value) => isRecord(value) && typeof value["id"] === "string" && typeof value["name"] === "string" && (value["description"] === void 0 || typeof value["description"] === "string") && Array.isArray(value["entries"]) && value["entries"].every(isDocEntry);
var isMdxJsxElement = (value) => isRecord(value) && (value["type"] === "mdxJsxFlowElement" || value["type"] === "mdxJsxTextElement") && typeof value["name"] === "string" && Array.isArray(value["attributes"]) && value["attributes"].every(
  (attribute) => isRecord(attribute) && attribute["type"] === "mdxJsxAttribute" && typeof attribute["name"] === "string"
);
var readGeneratedDoc = (node) => {
  const attribute = node.attributes.find(({ name }) => name === "type");
  const raw = typeof attribute?.value === "string" ? attribute.value : attribute?.value?.type === "mdxJsxAttributeValueExpression" ? attribute.value.value : void 0;
  if (!raw) return void 0;
  try {
    const value = JSON.parse(raw);
    return isGeneratedDoc(value) ? value : void 0;
  } catch {
    return void 0;
  }
};
var formatEntry = (entry) => {
  const metadata = [`\`${collapseWhitespace(entry.type)}\``, entry.required ? "required" : "optional"];
  if (entry.deprecated) metadata.push("deprecated");
  const defaultTag = entry.tags.find(({ name }) => name === "default");
  if (defaultTag) metadata.push(`default \`${relaxMdxCurlyEscapes(defaultTag.text)}\``);
  const description = collapseWhitespace(entry.description);
  return `- **\`${entry.name}\`** (${metadata.join(", ")})${description ? ` \u2014 ${description}` : ""}`;
};
var formatDocument = (document) => {
  const description = document.description ? ` \u2014 ${collapseWhitespace(document.description)}` : "";
  const properties = document.entries.length ? document.entries.map(formatEntry).join("\n") : "_No properties._";
  return `**\`${document.name}\`**${description}

${properties}`;
};
var formatMermaid = (node) => {
  const attribute = node.attributes.find(({ name }) => name === "chart");
  const chart = typeof attribute?.value === "string" ? attribute.value : void 0;
  return chart === void 0 ? void 0 : `\`\`\`mermaid
${chart}
\`\`\``;
};
var formatRenderDemo = (node) => {
  const attribute = node.attributes.find(({ name }) => name === "code");
  const code = typeof attribute?.value === "string" ? attribute.value : void 0;
  return code === void 0 ? void 0 : `\`\`\`typescript
${code}
\`\`\``;
};
var llmStringifyMdx = (...args) => {
  const [node] = args;
  if (!isMdxJsxElement(node)) return void 0;
  if (node.name === "Mermaid") return formatMermaid(node);
  if (node.name === "RenderDemo") return formatRenderDemo(node);
  if (node.name !== "TypeTable") return void 0;
  const document = readGeneratedDoc(node);
  return document ? formatDocument(document) : void 0;
};

// lib/remark-mermaid.ts
var toMermaidElement = (chart) => ({
  type: "mdxJsxFlowElement",
  name: "Mermaid",
  attributes: [{ type: "mdxJsxAttribute", name: "chart", value: chart }],
  children: []
});
var isMermaidFence = (node) => node.type === "code" && node.lang === "mermaid" && typeof node.value === "string";
var convert = (node) => {
  if (!node.children) return;
  node.children = node.children.map(
    (child) => isMermaidFence(child) ? toMermaidElement(child.value ?? "") : child
  );
  for (const child of node.children) convert(child);
};
var remarkMermaid = () => (tree) => {
  convert(tree);
};

// lib/remark-render-demo.ts
var firstCodeChild = (node) => node.children?.find((child) => child.type === "code" && typeof child.value === "string");
var inject = (node) => {
  if (node.type === "mdxJsxFlowElement" && node.name === "RenderDemo") {
    const code = firstCodeChild(node);
    if (code?.value !== void 0) {
      node.attributes ??= [];
      node.attributes.push({ type: "mdxJsxAttribute", name: "code", value: code.value });
    }
  }
  for (const child of node.children ?? []) inject(child);
};
var remarkRenderDemo = () => (tree) => {
  inject(tree);
};

// source.config.ts
var generator = createGenerator({ tsconfigPath: "./tsconfig.json" });
var docs = defineDocs({
  dir: "content/docs",
  docs: {
    postprocess: {
      includeProcessedMarkdown: {
        stringify: (...args) => llmStringifyMdx(...args)
      }
    }
  }
});
var source_config_default = defineConfig({
  mdxOptions: {
    remarkPlugins: [[remarkAutoTypeTable, { generator }], remarkMermaid, remarkRenderDemo]
  }
});
export {
  source_config_default as default,
  docs
};
