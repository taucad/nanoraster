/** Adapter probe shared by both artifacts. */

import { RenderError } from '#render-error.js';
import { describeAdapterRaw } from '#renderer.js';

/**
 * Backend and device name of the adapter the environment selects, e.g.
 * `"Metal / Apple M2 Pro (IntegratedGpu)"`. A `(Cpu)` device type means
 * software rasterization (SwiftShader, lavapipe, WARP) — renders work but
 * expect an order of magnitude slower; `navigator.gpu` existing does not
 * rule this out.
 *
 * @public
 * @returns The adapter description
 */
export const describeAdapter = async (): Promise<string> => {
  try {
    return await describeAdapterRaw();
  } catch (error) {
    throw RenderError.from(error);
  }
};
