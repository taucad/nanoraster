import { test } from 'vitest';

test('native singular and batch renders are byte-identical across all 336 cases', async () => {
  await import('./napi-parity.mjs');
});
