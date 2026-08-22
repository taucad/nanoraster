/**
 * The Node addon backend: the host precondition npm selectors cannot express,
 * then the NAPI-RS-generated loader, then this package's failure taxonomy.
 */

import { endianness } from 'node:os';

import { RenderError } from '#render-error.js';
import type { NapiModule } from '#renderer.js';

const compatibility = 'https://github.com/taucad/nanoraster/blob/main/compatibility.md';

/**
 * Load the addon the `node` export condition resolves.
 *
 * npm's `cpu: "ppc64"` selector does not encode endianness, so a big-endian
 * POWER host installs the little-endian package it cannot run; that check
 * happens before the loader so the answer is a typed failure rather than a
 * relocation error. Every loader failure keeps its `cause` chain, which names
 * each candidate the loader tried.
 *
 * @internal
 * @returns The addon's renderer factory and adapter probe
 */
export const nativeAddonLoader = async (): Promise<NapiModule> => {
  if (process.arch === 'ppc64' && endianness() !== 'LE') {
    throw new RenderError(
      'adapter-unavailable',
      `adapter-unavailable: nanoraster builds ppc64 little-endian only, and this host is ` +
        `big-endian ${process.platform}-${process.arch}. See ${compatibility}.`,
    );
  }
  try {
    return (await import('./native/index.js')) as unknown as NapiModule;
  } catch (error) {
    throw new RenderError(
      'adapter-unavailable',
      `adapter-unavailable: the native render addon did not load on ` +
        `${process.platform}-${process.arch} (node ${process.versions.node}). See ${compatibility}.`,
      error,
    );
  }
};
