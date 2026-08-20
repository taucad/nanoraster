// @ts-nocheck
import { browser } from 'fumadocs-mdx/runtime/browser';
import type * as Config from '../source.config';

const create = browser<typeof Config, import("fumadocs-mdx/runtime/types").InternalTypeConfig & {
  DocData: {
  }
}>();
const browserCollections = {
  docs: create.doc("docs", {"api.mdx": () => import("../content/docs/api.mdx?collection=docs"), "how-it-works.mdx": () => import("../content/docs/how-it-works.mdx?collection=docs"), "index.mdx": () => import("../content/docs/index.mdx?collection=docs"), "install.mdx": () => import("../content/docs/install.mdx?collection=docs"), "tutorial.mdx": () => import("../content/docs/tutorial.mdx?collection=docs"), "guides/format-and-annotate.mdx": () => import("../content/docs/guides/format-and-annotate.mdx?collection=docs"), "guides/frame-the-model.mdx": () => import("../content/docs/guides/frame-the-model.mdx?collection=docs"), "guides/handle-render-failures.mdx": () => import("../content/docs/guides/handle-render-failures.mdx?collection=docs"), "guides/light-the-subject.mdx": () => import("../content/docs/guides/light-the-subject.mdx?collection=docs"), "guides/render-for-llms.mdx": () => import("../content/docs/guides/render-for-llms.mdx?collection=docs"), "guides/render-in-the-browser.mdx": () => import("../content/docs/guides/render-in-the-browser.mdx?collection=docs"), "guides/render-multiple-views.mdx": () => import("../content/docs/guides/render-multiple-views.mdx?collection=docs"), "guides/reuse-the-renderer.mdx": () => import("../content/docs/guides/reuse-the-renderer.mdx?collection=docs"), "guides/work-with-raw-pixels.mdx": () => import("../content/docs/guides/work-with-raw-pixels.mdx?collection=docs"), }),
};
export default browserCollections;