// Process-exit hygiene for the shared one-shot renderer: it is passive memory,
// not an event-loop handle, so a script that renders through the module-level
// functions must exit on its own without a dispose. (This repo has shipped an
// fs.watch handle leak before; a renderer that pinned the loop would strand
// every CLI that renders once and returns.)
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { expect, test } from 'vitest';

const script = `
import { readFileSync } from 'node:fs';
const { renderGlbToImage, renderGlbToPixels } = await import('./src/index.ts');
const glb = Uint8Array.from(readFileSync('tests/fixtures/gear-12.glb'));
const options = { width: 192, height: 192 };
const [image] = await Promise.all([
  renderGlbToImage(glb, { ...options, format: 'png' }),
  renderGlbToPixels(glb, options),
]);
console.log(image.name);
`;

test('a process rendering through the one-shot API exits on its own', async () => {
  const stdout = await new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      ['--input-type=module', '-e', script],
      {
        cwd: fileURLToPath(new URL('..', import.meta.url)),
        // The kill is the assertion: an undisposed shared renderer that held
        // the event loop open would never reach exit.
        timeout: 60_000,
        killSignal: 'SIGKILL',
      },
      (error, out, errorOutput) => {
        if (error) {
          reject(new Error(`${error.message}\n${errorOutput}`));
          return;
        }
        resolve(out);
      },
    );
  });

  expect(stdout.trim()).toBe('thumbnail.png');
});
