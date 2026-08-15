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
var llmStringifyMdx = (...args) => {
  const [node] = args;
  if (!isMdxJsxElement(node) || node.name !== "TypeTable") return void 0;
  const document = readGeneratedDoc(node);
  return document ? formatDocument(document) : void 0;
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
    remarkPlugins: [[remarkAutoTypeTable, { generator }]]
  }
});
export {
  source_config_default as default,
  docs
};
