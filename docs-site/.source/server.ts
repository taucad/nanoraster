// @ts-nocheck
import * as __fd_glob_24 from "../content/docs/guides/render-multiple-views.mdx?collection=docs"
import * as __fd_glob_23 from "../content/docs/guides/render-in-the-browser.mdx?collection=docs"
import * as __fd_glob_22 from "../content/docs/guides/light-the-subject.mdx?collection=docs"
import * as __fd_glob_21 from "../content/docs/guides/handle-render-failures.mdx?collection=docs"
import * as __fd_glob_20 from "../content/docs/guides/frame-the-model.mdx?collection=docs"
import * as __fd_glob_19 from "../content/docs/guides/choose-format-and-quality.mdx?collection=docs"
import * as __fd_glob_18 from "../content/docs/guides/annotate-renders.mdx?collection=docs"
import * as __fd_glob_17 from "../content/docs/getting-started/render-a-view-sheet.mdx?collection=docs"
import * as __fd_glob_16 from "../content/docs/getting-started/quick-start.mdx?collection=docs"
import * as __fd_glob_15 from "../content/docs/getting-started/installation.mdx?collection=docs"
import * as __fd_glob_14 from "../content/docs/api/results.mdx?collection=docs"
import * as __fd_glob_13 from "../content/docs/api/options.mdx?collection=docs"
import * as __fd_glob_12 from "../content/docs/api/operations.mdx?collection=docs"
import * as __fd_glob_11 from "../content/docs/api/errors.mdx?collection=docs"
import * as __fd_glob_10 from "../content/docs/api/constants.mdx?collection=docs"
import * as __fd_glob_9 from "../content/docs/concepts/rendering-pipeline.mdx?collection=docs"
import * as __fd_glob_8 from "../content/docs/concepts/material-model.mdx?collection=docs"
import * as __fd_glob_7 from "../content/docs/concepts/determinism.mdx?collection=docs"
import * as __fd_glob_6 from "../content/docs/concepts/camera-model.mdx?collection=docs"
import * as __fd_glob_5 from "../content/docs/index.mdx?collection=docs"
import { default as __fd_glob_4 } from "../content/docs/concepts/meta.json?collection=docs"
import { default as __fd_glob_3 } from "../content/docs/guides/meta.json?collection=docs"
import { default as __fd_glob_2 } from "../content/docs/getting-started/meta.json?collection=docs"
import { default as __fd_glob_1 } from "../content/docs/api/meta.json?collection=docs"
import { default as __fd_glob_0 } from "../content/docs/meta.json?collection=docs"
import { server } from 'fumadocs-mdx/runtime/server';
import type * as Config from '../source.config';

const create = server<typeof Config, import("fumadocs-mdx/runtime/types").InternalTypeConfig & {
  DocData: {
  }
}>({"doc":{"passthroughs":["extractedReferences"]}});

export const docs = await create.docs("docs", "content/docs", {"meta.json": __fd_glob_0, "api/meta.json": __fd_glob_1, "getting-started/meta.json": __fd_glob_2, "guides/meta.json": __fd_glob_3, "concepts/meta.json": __fd_glob_4, }, {"index.mdx": __fd_glob_5, "concepts/camera-model.mdx": __fd_glob_6, "concepts/determinism.mdx": __fd_glob_7, "concepts/material-model.mdx": __fd_glob_8, "concepts/rendering-pipeline.mdx": __fd_glob_9, "api/constants.mdx": __fd_glob_10, "api/errors.mdx": __fd_glob_11, "api/operations.mdx": __fd_glob_12, "api/options.mdx": __fd_glob_13, "api/results.mdx": __fd_glob_14, "getting-started/installation.mdx": __fd_glob_15, "getting-started/quick-start.mdx": __fd_glob_16, "getting-started/render-a-view-sheet.mdx": __fd_glob_17, "guides/annotate-renders.mdx": __fd_glob_18, "guides/choose-format-and-quality.mdx": __fd_glob_19, "guides/frame-the-model.mdx": __fd_glob_20, "guides/handle-render-failures.mdx": __fd_glob_21, "guides/light-the-subject.mdx": __fd_glob_22, "guides/render-in-the-browser.mdx": __fd_glob_23, "guides/render-multiple-views.mdx": __fd_glob_24, });