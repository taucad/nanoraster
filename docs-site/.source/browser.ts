// @ts-nocheck
import { browser } from 'fumadocs-mdx/runtime/browser';
import type * as Config from '../source.config';

const create = browser<typeof Config, import("fumadocs-mdx/runtime/types").InternalTypeConfig & {
  DocData: {
  }
}>();
const browserCollections = {
  docs: create.doc("docs", {"api.mdx": () => import("../content/docs/api.mdx?collection=docs"), "errors.mdx": () => import("../content/docs/errors.mdx?collection=docs"), "index.mdx": () => import("../content/docs/index.mdx?collection=docs"), "options.mdx": () => import("../content/docs/options.mdx?collection=docs"), "quick-start.mdx": () => import("../content/docs/quick-start.mdx?collection=docs"), "rendering.mdx": () => import("../content/docs/rendering.mdx?collection=docs"), }),
};
export default browserCollections;