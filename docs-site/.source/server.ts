// @ts-nocheck
import * as __fd_glob_11 from "../content/docs/guides/render-multiple-views.mdx?collection=docs"
import * as __fd_glob_10 from "../content/docs/guides/render-in-the-browser.mdx?collection=docs"
import * as __fd_glob_9 from "../content/docs/guides/handle-render-failures.mdx?collection=docs"
import * as __fd_glob_8 from "../content/docs/guides/frame-the-model.mdx?collection=docs"
import * as __fd_glob_7 from "../content/docs/guides/format-and-annotate.mdx?collection=docs"
import * as __fd_glob_6 from "../content/docs/tutorial.mdx?collection=docs"
import * as __fd_glob_5 from "../content/docs/install.mdx?collection=docs"
import * as __fd_glob_4 from "../content/docs/index.mdx?collection=docs"
import * as __fd_glob_3 from "../content/docs/how-it-works.mdx?collection=docs"
import * as __fd_glob_2 from "../content/docs/api.mdx?collection=docs"
import { default as __fd_glob_1 } from "../content/docs/guides/meta.json?collection=docs"
import { default as __fd_glob_0 } from "../content/docs/meta.json?collection=docs"
import { server } from 'fumadocs-mdx/runtime/server';
import type * as Config from '../source.config';

const create = server<typeof Config, import("fumadocs-mdx/runtime/types").InternalTypeConfig & {
  DocData: {
  }
}>({"doc":{"passthroughs":["extractedReferences"]}});

export const docs = await create.docs("docs", "content/docs", {"meta.json": __fd_glob_0, "guides/meta.json": __fd_glob_1, }, {"api.mdx": __fd_glob_2, "how-it-works.mdx": __fd_glob_3, "index.mdx": __fd_glob_4, "install.mdx": __fd_glob_5, "tutorial.mdx": __fd_glob_6, "guides/format-and-annotate.mdx": __fd_glob_7, "guides/frame-the-model.mdx": __fd_glob_8, "guides/handle-render-failures.mdx": __fd_glob_9, "guides/render-in-the-browser.mdx": __fd_glob_10, "guides/render-multiple-views.mdx": __fd_glob_11, });