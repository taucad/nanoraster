#!/usr/bin/env node
// Dead-link checker. Sources: the exported site (docs-site/out/**/*.html), the
// agent Markdown projection (out/docs.mdx, out/docs/**/*.mdx, out/llms.txt) and
// the repository's root Markdown. Internal targets must resolve to a file under
// out/, a `#fragment` must match an `id` in the target HTML, and external URLs
// must answer. Pass --internal-only to skip the network.

import { existsSync, statSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'docs-site', 'out');
// Origins the built site is deployed under: resolve them against out/ rather
// than over the network, so the check gates this build and not the live deploy.
const SITE_ORIGINS = ['https://nanoraster.xyz', 'https://www.nanoraster.xyz'];
// Hosts that answer non-browser requests with a hard 403 (verified by hand).
const ALLOWLIST = ['https://www.npmjs.com/'];
const SKIP_SCHEME = /^(?:mailto:|tel:|data:|javascript:|blob:)/i;
const SKIP_HOST = /^https?:\/\/(?:localhost|127\.0\.0\.1|[^/]*example\.com)/i;
const UA = 'nanoraster-link-check';

const internalOnly = process.argv.includes('--internal-only');
const failures = [];
const stats = {
  internal: 0,
  internalFailed: 0,
  anchors: 0,
  anchorsFailed: 0,
  external: 0,
  externalFailed: 0,
};
const external = new Map(); // url -> [source files]
const idCache = new Map();

const isFile = (p) => existsSync(p) && statSync(p).isFile();
const fail = (file, target, reason) => failures.push(`${path.relative(ROOT, file)} -> ${target} (${reason})`);

async function walk(dir, match) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    const full = path.join(entry.parentPath, entry.name);
    if (entry.isFile() && match(full)) found.push(full);
  }
  return found;
}

/** Site URL a built file is served at: index.html -> /, docs.html -> /docs. */
function pageUrl(file) {
  const rel = path.relative(OUT, file).replaceAll(path.sep, '/');
  return '/' + rel.replace(/(?:^|(?<=\/))index\.html$/, '').replace(/\.html$/, '');
}

/** First file under out/ that would serve `pathname`, or null. */
function resolveInternal(pathname) {
  const rel = decodeURIComponent(pathname).replace(/^\/+/, '').replace(/\/+$/, '');
  const candidates = rel === '' ? ['index.html'] : [rel, `${rel}.html`, `${rel}/index.html`];
  // Decoded separators could climb out of out/ (`/%2F..%2Fpackage.json`) and
  // accept a target the deployed site would 404.
  return (
    candidates
      .map((c) => path.resolve(OUT, c))
      .find((c) => c.startsWith(OUT + path.sep) && isFile(c)) ?? null
  );
}

async function hasId(file, id) {
  let ids = idCache.get(file);
  if (!ids) {
    const html = await readFile(file, 'utf8');
    ids = new Set(Array.from(html.matchAll(/\bid="([^"]+)"/g), (m) => m[1]));
    idCache.set(file, ids);
  }
  return ids.has(id);
}

/** Check one link found in `source`, resolved against `base` (a site URL). */
async function check(source, raw, base) {
  const target = raw.trim();
  if (!target || target === '#' || SKIP_SCHEME.test(target)) return;
  const url = new URL(target, `https://nanoraster.xyz${base}`);
  const isSite = /^https?:/i.test(target) ? SITE_ORIGINS.includes(url.origin) : true;

  if (!isSite) {
    if (SKIP_HOST.test(url.href) || ALLOWLIST.some((p) => url.href.startsWith(p))) return;
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
    external.set(url.href, [...(external.get(url.href) ?? []), source]);
    return;
  }
  if (url.pathname.startsWith('/_next/')) return;

  stats.internal += 1;
  const file = resolveInternal(url.pathname);
  if (!file) {
    stats.internalFailed += 1;
    return fail(source, target, 'no file under docs-site/out');
  }
  const id = url.hash.slice(1);
  if (!id || !file.endsWith('.html')) return;
  stats.anchors += 1;
  if (!(await hasId(file, id))) {
    stats.anchorsFailed += 1;
    fail(source, target, `no id="${id}" in ${path.relative(OUT, file)}`);
  }
}

/** Repo-relative target in root Markdown: the file must exist. */
function checkRepoPath(source, target) {
  stats.internal += 1;
  if (!existsSync(path.join(path.dirname(source), decodeURIComponent(target.split('#')[0])))) {
    stats.internalFailed += 1;
    fail(source, target, 'file not in the repository');
  }
}

async function checkExternal(url) {
  let reason = 'unreachable';
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    for (const method of ['HEAD', 'GET']) {
      try {
        const res = await fetch(url, {
          method,
          redirect: 'follow',
          headers: { 'user-agent': UA },
          signal: AbortSignal.timeout(10_000),
        });
        if (res.status < 400) return null;
        reason = `HTTP ${res.status}`;
      } catch (error) {
        reason = error.name === 'TimeoutError' ? 'timeout after 10s' : error.message;
      }
    }
  }
  return reason;
}

if (!existsSync(OUT)) {
  console.error(`docs-site/out is missing — run \`pnpm run docs:build\` first.`);
  process.exit(1);
}

for (const file of await walk(OUT, (f) => f.endsWith('.html'))) {
  const html = await readFile(file, 'utf8');
  const base = pageUrl(file);
  for (const [, target] of html.matchAll(/(?:href|src)="([^"]*)"/g)) await check(file, target, base);
}

if (isFile(path.join(OUT, 'docs.mdx'))) {
  const projection = [
    path.join(OUT, 'docs.mdx'),
    path.join(OUT, 'llms.txt'),
    ...(await walk(path.join(OUT, 'docs'), (f) => f.endsWith('.mdx'))),
  ];
  for (const file of projection) {
    const base = '/' + path.relative(OUT, file).replaceAll(path.sep, '/');
    const text = await readFile(file, 'utf8');
    for (const [, target] of text.matchAll(/\[[^\]]*\]\(([^)\s]+)/g)) await check(file, target, base);
  }
} else {
  console.log(
    'notice: out/docs.mdx is absent — skipping the Markdown projection (expected before the .mdx routes build).',
  );
}

for (const file of await walk(ROOT, (f) => path.dirname(f) === ROOT && f.endsWith('.md'))) {
  const text = await readFile(file, 'utf8');
  const targets = [
    ...Array.from(text.matchAll(/\[[^\]]*\]\(([^)\s]+)/g), (m) => m[1]),
    ...Array.from(text.matchAll(/(?:href|src)="([^"]*)"/g), (m) => m[1]),
    ...Array.from(text.matchAll(/(?<![("])\bhttps?:\/\/[^\s)<>"'`\]]+/g), (m) =>
      m[0].replace(/[.,;:]+$/, ''),
    ),
  ];
  for (const target of new Set(targets)) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//')) await check(file, target, '/');
    else if (target.startsWith('#')) continue;
    else checkRepoPath(file, target);
  }
}

if (!internalOnly) {
  const queue = [...external.keys()];
  stats.external = queue.length;
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      for (let url = queue.pop(); url !== undefined; url = queue.pop()) {
        const reason = await checkExternal(url);
        if (reason) {
          stats.externalFailed += 1;
          for (const source of new Set(external.get(url))) fail(source, url, reason);
        }
      }
    }),
  );
}

for (const line of failures) console.error(line);
console.log(
  `internal ${stats.internal} checked, ${stats.internalFailed} failed · ` +
    `anchors ${stats.anchors} checked, ${stats.anchorsFailed} failed · ` +
    (internalOnly
      ? `external skipped (--internal-only)`
      : `external ${stats.external} checked, ${stats.externalFailed} failed`),
);
process.exit(failures.length > 0 ? 1 : 0);
