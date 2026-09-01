import { createReadStream, globSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';

import { chromium } from 'playwright';

const out = join(import.meta.dirname, '..', 'out');
const contentTypes = {
  '.css': 'text/css',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.webp': 'image/webp',
};

const fileFor = (pathname) => {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\//u, '');
  const candidate = extname(relative) === '' ? `${relative}.html` : relative;
  const file = normalize(join(out, candidate));
  return file.startsWith(out) ? file : undefined;
};

const server = createServer((request, response) => {
  const file = fileFor(new URL(request.url ?? '/', 'http://localhost').pathname);
  if (file === undefined) {
    response.writeHead(404).end();
    return;
  }
  try {
    const stat = statSync(file);
    response.writeHead(200, {
      'content-length': stat.size,
      'content-type': contentTypes[extname(file)] ?? 'application/octet-stream',
    });
    createReadStream(file).pipe(response);
  } catch {
    response.writeHead(404).end();
  }
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
if (address === null || typeof address === 'string') throw new Error('docs route server did not bind');
const origin = `http://127.0.0.1:${address.port}`;
const routes = globSync('**/*.html', { cwd: out })
  .filter((file) => file !== '404.html' && file !== '_not-found.html')
  .map((file) => (file === 'index.html' ? '/' : `/${file.slice(0, -'.html'.length)}`))
  .toSorted();

const browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-webgpu'] });
try {
  for (const route of routes) {
    const page = await browser.newPage();
    const failures = [];
    page.on('console', (message) => {
      if (message.type() === 'error') failures.push(`console: ${message.text()}`);
    });
    page.on('pageerror', (error) => failures.push(`page: ${error.message}`));
    const response = await page.goto(`${origin}${route}`, { waitUntil: 'networkidle' });
    if (response?.status() !== 200) failures.push(`HTTP ${response?.status() ?? 'no response'}`);
    const demos = page.locator('[data-render-demo]');
    for (let index = 0; index < (await demos.count()); index += 1) {
      await demos.nth(index).waitFor({ state: 'visible' });
      await page.waitForFunction(
        ([selector, item]) =>
          globalThis.document.querySelectorAll(selector)[item]?.getAttribute('data-render-state') === 'idle',
        ['[data-render-demo]', index],
        { timeout: 120_000 },
      );
    }
    const renderedFailures = await page.getByText(/^Render failed:/u).allTextContents();
    failures.push(...renderedFailures);
    await page.close();
    if (failures.length > 0) throw new Error(`${route}\n${failures.join('\n')}`);
  }
  console.log(`docs route sweep passed (${routes.length} routes)`);
} finally {
  await browser.close();
  server.close();
}
