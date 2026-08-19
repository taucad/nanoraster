import sizes from '../lib/sizes.json';

import styles from '../app/(home)/page.module.css';

/** Format a byte count the way a package registry does: decimal units, one decimal place. */
export const formatSize = (bytes: number): string => {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  const kilobytes = bytes / 1_000;
  return `${kilobytes >= 100 ? kilobytes.toFixed(0) : kilobytes.toFixed(1)} KB`;
};

// The strip quotes the darwin-arm64 build (the blueprint's ruling); the hint lists all three.
const nativeHint = `native addon per platform: ${Object.entries(sizes.native)
  .map(([platform, bytes]) => `${platform} ${formatSize(bytes)}`)
  .join(', ')}`;

const cells = [
  { bytes: sizes.wasm.brotli, hint: 'WebAssembly renderer, brotli-compressed', label: 'Browser' },
  { bytes: sizes.native['darwin-arm64'], hint: nativeHint, label: 'Node.js' },
  { bytes: sizes.js.gzip, hint: 'JavaScript entrypoint, gzip-compressed', label: 'JS API' },
];

/** Render the measured download size of each nanoraster surface. */
export const SizeStrip = (): React.JSX.Element => (
  <dl className={styles.specStrip}>
    {cells.map(({ bytes, hint, label }, index) => (
      <div className={index === 0 ? styles.specLead : undefined} key={label} title={hint}>
        <dt>{label}</dt>
        <dd>{formatSize(bytes)}</dd>
      </div>
    ))}
  </dl>
);
