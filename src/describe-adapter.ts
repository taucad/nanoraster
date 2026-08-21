/** Adapter probe: JSON over the FFI natively, `navigator.gpu` in browsers. */

import type { CreateRendererOptions } from '#create-renderer.js';
import { serializeCreateOptions } from '#create-renderer.js';
import { RenderError } from '#render-error.js';
import { describeAdapterRaw, isNodeRuntime } from '#renderer.js';

/**
 * The GPU adapter a renderer binds.
 *
 * @public
 */
export type AdapterInfo = {
  /** Graphics API in use. Browsers always report `'webgpu'`. */
  readonly backend: 'metal' | 'vulkan' | 'dx12' | 'webgpu';
  /** Device name, or `''` when the runtime withholds it. */
  readonly name: string;
  /**
   * Device class. `'cpu'` is software rasterization (SwiftShader, lavapipe,
   * WARP); `'unknown'` means the runtime withholds it, as browsers do for
   * every adapter that is not a declared fallback.
   */
  readonly deviceType: 'discrete-gpu' | 'integrated-gpu' | 'virtual-gpu' | 'cpu' | 'unknown';
};

const backends: ReadonlyArray<string> = ['metal', 'vulkan', 'dx12', 'webgpu'];
const deviceTypes: ReadonlyArray<string> = [
  'discrete-gpu',
  'integrated-gpu',
  'virtual-gpu',
  'cpu',
  'unknown',
];

/** The slice of WebGPU this probe reads; the package ships no DOM types. */
type BrowserGpu = {
  readonly requestAdapter: (options?: { readonly powerPreference: string }) => Promise<{
    readonly info: {
      readonly vendor: string;
      readonly architecture: string;
      readonly description: string;
      readonly isFallbackAdapter: boolean;
    };
  } | null>;
};

const parseAdapterInfo = (json: string): AdapterInfo => {
  const info = JSON.parse(json) as AdapterInfo;
  if (
    !backends.includes(info.backend) ||
    !deviceTypes.includes(info.deviceType) ||
    typeof info.name !== 'string'
  ) {
    throw new RenderError('unknown', `unrecognized adapter description: ${json}`);
  }
  return info;
};

const browserAdapterInfo = async (
  powerPreference: CreateRendererOptions['powerPreference'],
): Promise<AdapterInfo> => {
  const gpu = (globalThis.navigator as { gpu?: BrowserGpu } | undefined)?.gpu;
  if (gpu === undefined) {
    throw new RenderError(
      'adapter-unavailable',
      'adapter-unavailable: this environment exposes no navigator.gpu',
    );
  }
  const adapter = await gpu.requestAdapter(powerPreference === undefined ? undefined : { powerPreference });
  if (adapter === null) {
    throw new RenderError('adapter-unavailable', 'adapter-unavailable: navigator.gpu returned no adapter');
  }
  const { vendor, architecture, description, isFallbackAdapter } = adapter.info;
  return {
    backend: 'webgpu',
    // WebGPU splits the name across fields, blanks the ones it will not
    // disclose (Chrome fills vendor and architecture, Firefox neither) and
    // repeats one word across all of them in Safari.
    name: [...new Set([vendor, architecture, description])].filter((part) => part !== '').join(' '),
    // The spec withholds the device class, so `unknown` is the honest answer
    // for everything but a fallback adapter — and a browser that has only
    // software hands out no adapter at all rather than a silent one.
    deviceType: isFallbackAdapter ? 'cpu' : 'unknown',
  };
};

/**
 * Describe the adapter a renderer created with these options would bind — the
 * preflight for telling absent WebGPU from a software rasterizer, which
 * renders correctly but an order of magnitude slower. A browser exposing
 * `navigator.gpu` rules out neither.
 *
 * @public
 * @param options - The same GPU selection hints {@link createRenderer} takes
 * @returns The adapter's backend, device name, and device class
 */
export const describeAdapter = async (options?: CreateRendererOptions): Promise<AdapterInfo> => {
  try {
    const optionsJson = serializeCreateOptions(options);
    return isNodeRuntime()
      ? parseAdapterInfo(await describeAdapterRaw(optionsJson))
      : await browserAdapterInfo(options?.powerPreference);
  } catch (error) {
    throw RenderError.from(error);
  }
};
