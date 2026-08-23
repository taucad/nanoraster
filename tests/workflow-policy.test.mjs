import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (relative) => readFileSync(new URL(relative, import.meta.url), 'utf8');

const workflow = read('../.github/workflows/ci.yml');
const packageJson = JSON.parse(read('../package.json'));

const compositeActions = new Map(
  readdirSync(new URL('../.github/actions', import.meta.url)).map((name) => [
    name,
    read(`../.github/actions/${name}/action.yml`),
  ]),
);

/**
 * Split the workflow into its top-level job blocks. Job identifiers are the only
 * keys indented by exactly two spaces after the `jobs:` mapping, so a line scan
 * is enough to isolate each job without a YAML dependency the repository does
 * not ship.
 */
const jobs = (() => {
  const lines = workflow.split('\n');
  const start = lines.indexOf('jobs:');
  assert.notEqual(start, -1, 'ci.yml must declare a jobs mapping');
  const blocks = new Map();
  let current;
  for (const line of lines.slice(start + 1)) {
    const header = /^ {2}([A-Za-z0-9_-]+):\s*$/u.exec(line);
    if (header) {
      current = [];
      blocks.set(header[1], current);
      continue;
    }
    current?.push(line);
  }
  return new Map([...blocks].map(([name, body]) => [name, body.join('\n')]));
})();

const job = (name) => {
  const body = jobs.get(name);
  assert(body, `ci.yml must declare a ${name} job`);
  return body;
};

const needsOf = (name) => {
  const body = job(name);
  const inline = /^ {4}needs:\s*\[([^\]]*)\]/mu.exec(body);
  if (inline)
    return inline[1]
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
  const single = /^ {4}needs:\s*([A-Za-z0-9_-]+)\s*$/mu.exec(body);
  if (single) return [single[1]];
  const block = /^ {4}needs:\s*\n((?: {6,}.*\n)+)/mu.exec(body);
  if (!block) return [];
  return block[1]
    .split('\n')
    .map((line) => line.replace(/[\s[\],-]/gu, ''))
    .filter(Boolean);
};

const occurrences = (haystack, needle) => haystack.split(needle).length - 1;

const builtins = new Set(builtinModules);

const byText = (left, right) => Number(left > right) - Number(left < right);

/**
 * A job installs dependencies through the shared setup action or pnpm itself.
 * The setup action is matched to the end of its line: the composite actions sit
 * beside it in the same directory, and `download-verified-artifact` installs
 * nothing.
 */
const installsDependencies = (body) =>
  /^\s*- uses: \.\/\.github\/actions\/setup\s*$/mu.test(body) || body.includes('pnpm install');

/** Every `node scripts/<file>.mjs` a job body runs, deduplicated. */
const scriptsRunBy = (body) => [
  ...new Set([...body.matchAll(/\bnode (scripts\/[\w./-]+\.mjs)\b/gu)].map((match) => String(match[1]))),
];

/**
 * Module specifiers one file imports, read from its syntax tree. A regular
 * expression would also match the consumer program `test-package.mjs` writes
 * into a template literal, which resolves inside the temporary install rather
 * than in this repository.
 */
const specifiersOf = (file) => {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.ESNext, true);
  const found = [];
  const visit = (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      found.push(node.moduleSpecifier.text);
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] !== undefined &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      found.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
};

/** Package specifiers reachable from one script through its repository-relative imports. */
const packagesReachedBy = (script) => {
  const seen = new Set();
  const packages = new Set();
  const pending = [resolve(root, script)];

  while (pending.length > 0) {
    const file = pending.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    for (const specifier of specifiersOf(file)) {
      if (specifier.startsWith('node:') || builtins.has(specifier)) continue;
      if (specifier.startsWith('.')) pending.push(resolve(dirname(file), specifier));
      else packages.add(specifier);
    }
  }

  return [...packages].sort(byText);
};

const smokeMatrix = () => {
  const rows = [...job('preflight').matchAll(/\{\s*suffix:[^}]*\}/gu)].map((match) => match[0]);
  assert(rows.length > 0, 'preflight must build the smoke matrix rows');
  return rows;
};

describe('CI workflow policy', () => {
  describe('build matrix', () => {
    it('should build exactly the sixteen configured napi targets', () => {
      const targets = packageJson.napi.targets;
      assert.equal(targets.length, 16);
      const body = job('build');
      const matrixTargets = [...body.matchAll(/^ {10}- target: (\S+)$/gmu)].map((match) => match[1]);
      const byName = (left, right) => left.localeCompare(right);
      assert.deepEqual([...matrixTargets].sort(byName), [...targets].sort(byName));
    });

    it('should cross-build the five glibc targets with the napi cross toolchain', () => {
      const body = job('build');
      const glibc = [
        'x86_64-unknown-linux-gnu',
        'aarch64-unknown-linux-gnu',
        'armv7-unknown-linux-gnueabihf',
        'powerpc64le-unknown-linux-gnu',
        's390x-unknown-linux-gnu',
      ];
      for (const target of glibc) {
        const row = new RegExp(`- target: ${target}\\n(?: {12}.*\\n)+`, 'u').exec(body);
        assert(row, `build matrix must contain ${target}`);
        assert(row[0].includes("cross: '--use-napi-cross'"), `${target} must use --use-napi-cross`);
      }
      assert.equal(occurrences(body, "cross: '--use-napi-cross'"), glibc.length);
    });

    it('should cross-build the three musl targets through cargo-zigbuild', () => {
      const body = job('build');
      const musl = [
        'x86_64-unknown-linux-musl',
        'aarch64-unknown-linux-musl',
        'armv7-unknown-linux-musleabihf',
      ];
      for (const target of musl) {
        const row = new RegExp(`- target: ${target}\\n(?: {12}.*\\n)+`, 'u').exec(body);
        assert(row, `build matrix must contain ${target}`);
        assert(row[0].includes("cross: '-x'"), `${target} must cross compile with -x`);
      }
      assert.equal(occurrences(body, "cross: '-x'"), musl.length);
      assert(body.includes('version: 0.15.2'), 'musl rows must pin Zig 0.15.2');
      assert(body.includes('tool: cargo-zigbuild'), 'musl rows must install cargo-zigbuild');
    });

    it('should relax link-time optimization only on the i686 Windows row', () => {
      const body = job('build');
      assert.equal(occurrences(workflow, 'CARGO_PROFILE_RELEASE_LTO=false'), 1);
      assert.equal(occurrences(workflow, 'CARGO_PROFILE_RELEASE_CODEGEN_UNITS=32'), 1);
      const step =
        /- name: [^\n]*\n(?: {8}.*\n)*? {8}if: matrix\.target == 'i686-pc-windows-msvc'\n(?: {8}.*\n)+/u.exec(
          body,
        );
      assert(step, 'the i686 override must be guarded by a matrix.target condition');
      assert(step[0].includes('CARGO_PROFILE_RELEASE_LTO=false'));
      assert(step[0].includes('CARGO_PROFILE_RELEASE_CODEGEN_UNITS=32'));
    });

    it('should upload one bindings artifact per target with an error on an empty match', () => {
      const body = job('build');
      assert(body.includes('name: bindings-${{ matrix.target }}'));
      assert(body.includes('path: src/native/nanoraster.*.node'));
      assert(body.includes('if-no-files-found: error'));
    });
  });

  describe('assembly and freeze', () => {
    it('should assemble, inspect, reconcile, and pack from the downloaded bindings', () => {
      const body = job('assemble');
      for (const command of [
        'pnpm exec napi create-npm-dirs --npm-dir npm',
        'pnpm exec napi artifacts --output-dir artifacts --npm-dir npm',
        'node scripts/inspect-native.mjs',
        'pnpm exec napi pre-publish --skip-optional-publish -t npm --no-gh-release',
        'node scripts/check-prepared-release.mjs',
        'node scripts/pack-test-tarballs.mjs --out tarballs',
        'node scripts/validate-pack.mjs',
      ]) {
        assert(body.includes(command), `assemble must run: ${command}`);
      }
      assert(body.includes('pattern: bindings-*'));
    });

    it('should assert the shipped entry graphs against the freshly built output', () => {
      const body = job('assemble');
      const build = body.indexOf('pnpm run build\n');
      const graph = body.indexOf('pnpm exec vitest run tests/import-graph.test.mjs');
      assert(build !== -1 && graph !== -1 && build < graph, 'the import-graph test must follow the build');
      assert(
        body.includes("NANORASTER_REQUIRE_DIST: '1'"),
        'the dist assertions must be mandatory in assembly',
      );
      assert(
        graph < body.indexOf('pnpm exec napi create-npm-dirs'),
        'the import-graph test must run before the platform directories exist',
      );
    });

    it('should run no pnpm script once napi pre-publish has rewritten the source manifest', () => {
      // pre-publish materializes optionalDependencies in the checkout's
      // package.json; pnpm's pre-run dependency check then rejects the stale
      // lockfile, so everything after it must be plain node or shell.
      const body = job('assemble');
      const reconciled = body.indexOf('pnpm exec napi pre-publish');
      assert(reconciled !== -1, 'assemble must reconcile through napi pre-publish');
      const after = body.slice(reconciled + 'pnpm exec napi pre-publish'.length);
      assert(
        !/pnpm (run|exec) /u.test(after),
        'no pnpm run/exec may follow the manifest reconcile in assemble',
      );
      for (const command of ['pnpm run pkgcheck', 'pnpm run check:size', 'pnpm run build:wasm:bench']) {
        const index = body.indexOf(command);
        assert(index !== -1 && index < reconciled, `${command} must run before the manifest reconcile`);
      }
    });

    it('should retain the prepared release archive for thirty days only on a release run', () => {
      const body = job('assemble');
      assert(
        body.includes("retention-days: ${{ needs.preflight.outputs.kind == 'release' && 30 || 1 }}"),
        'the prepared-release artifact needs the conditional retention split',
      );
      assert.equal(occurrences(body, 'retention-days: 1'), 2);
    });

    it('should refuse a prepared release archive above the artifact ceiling', () => {
      assert(job('assemble').includes('167772160'), 'the freeze step must enforce the 160 MB ceiling');
    });
  });

  describe('runtime evidence', () => {
    it('should run the fast smoke rows on every event and the slow rows on main, release, or dispatch', () => {
      const body = job('preflight');
      assert(
        /slow\s*=\s*kind === 'main' \|\| kind === 'release' \|\| event === 'workflow_dispatch'/u.test(body),
        'preflight must gate the slow smoke rows on the release cadence',
      );
      for (const suffix of [
        'linux-arm-gnueabihf',
        'linux-arm-musleabihf',
        'linux-ppc64-gnu',
        'linux-s390x-gnu',
        'freebsd-x64',
        'darwin-x64',
      ]) {
        const rows = smokeMatrix().filter((row) => row.includes(`suffix: '${suffix}'`));
        assert(rows.length > 0, `${suffix} needs a smoke row`);
        for (const row of rows) assert(row.includes('slow: true'), `${suffix} is a slow lane`);
      }
      for (const suffix of [
        'darwin-arm64',
        'linux-arm64-gnu',
        'linux-arm64-musl',
        'linux-x64-gnu',
        'linux-x64-musl',
        'win32-arm64-msvc',
        'win32-ia32-msvc',
        'win32-x64-msvc',
      ]) {
        const rows = smokeMatrix().filter((row) => row.includes(`suffix: '${suffix}'`));
        assert(rows.length > 0, `${suffix} needs a smoke row`);
        for (const row of rows) assert(!row.includes('slow: true'), `${suffix} is a fast lane`);
      }
    });

    it('should give every emulated and virtualized smoke row a forty-five minute ceiling', () => {
      for (const row of smokeMatrix()) {
        if (!row.includes('qemu: true') && !row.includes("recipe: 'freebsd'")) continue;
        assert(row.includes('timeout: 45'), `emulated row needs timeout 45: ${row}`);
      }
      assert(job('smoke').includes('fail-fast: false'));
      assert(job('smoke').includes('timeout-minutes: ${{ matrix.timeout }}'));
    });

    it('should smoke every non-Android target from the frozen tarballs', () => {
      const published = packageJson.napi.targets.length;
      assert.equal(published, 16);
      const suffixes = new Set(
        smokeMatrix()
          .map((row) => /suffix: '([^']+)'/u.exec(row)?.[1])
          .filter(Boolean),
      );
      assert.equal(suffixes.size, 14, 'fourteen non-Android targets need runtime evidence');
      assert(!suffixes.has('android-arm64'));
      assert(!suffixes.has('android-arm-eabi'));
      const body = job('smoke');
      assert(body.includes('NANORASTER_TARBALL_DIR'));
      assert(body.includes('NANORASTER_NATIVE_SUFFIX'));
      assert(body.includes('node scripts/test-package.mjs'));
      assert(body.includes('name: smoke (${{ matrix.suffix }}, ${{ matrix.lane }})'));
    });

    it('should run the unit tests on the supported Node floor and the current line', () => {
      const body = job('node');
      assert(body.includes("node: ['22.13.0', '26']"));
      assert(body.includes('pnpm nx run nanoraster:test'));
      assert(body.includes('pnpm nx run nanoraster:typecheck'));
    });

    it('should run the browser facade against the frozen root tarball', () => {
      const body = job('browser');
      assert(body.includes('NANORASTER_ROOT_PACKAGE'));
      assert(body.includes('NANORASTER_WASM_MODULE'));
      assert(body.includes('name: test-tarballs'));
    });
  });

  describe('publication', () => {
    it('should grant OIDC only to the publish job', () => {
      assert.equal(occurrences(workflow, 'id-token: write'), 1);
      assert(job('publish').includes('id-token: write'));
    });

    it('should never reference a registry token or a GitHub environment', () => {
      assert(!workflow.includes('NPM_TOKEN'));
      assert(!workflow.includes('NODE_AUTH_TOKEN'));
      assert(!/^\s+environment:\s/mu.test(workflow), 'no job may declare a deployment environment');
    });

    it('should publish platforms through napi and the root exactly once', () => {
      const body = job('publish');
      assert(body.includes("NPM_CONFIG_PROVENANCE: 'true'"));
      assert(body.includes('pnpm exec napi pre-publish --cwd release -t npm --no-gh-release'));
      assert.equal(occurrences(workflow, 'npm publish'), 1);
      assert(body.includes('npm publish ./release'));
      assert(
        body.includes('cannot publish over the previously published versions'),
        'the root guard must treat an existing version as success',
      );
      assert(body.includes('node scripts/validate-pack.mjs'));
    });

    it('should publish every platform package before the root package', () => {
      const body = job('publish');
      const platforms = body.indexOf('pnpm exec napi pre-publish --cwd release -t npm --no-gh-release');
      const rootPackage = body.indexOf('npm publish ./release');
      assert.notEqual(platforms, -1);
      assert.notEqual(rootPackage, -1);
      assert(
        platforms < rootPackage,
        'platform packages must publish before the root: a root whose optional dependencies do not exist yet is uninstallable',
      );
    });

    it('should verify the frozen archive digest before extracting it', () => {
      const body = job('publish');
      const check = /sha256sum --check "\$ARCHIVE\.sha256"/u.exec(body);
      assert(check, 'the publish job must check the .sha256 sidecar of the prepared archive');
      assert(
        body.indexOf(check[0]) < body.indexOf('tar -xzf "prepared-release/$ARCHIVE"'),
        'the digest check must precede the extraction it guards',
      );
      assert(job('assemble').includes('sha256sum "$archive" > "$archive.sha256"'));
    });

    it('should keep the retired candidate publisher out of the workflow', () => {
      assert(!workflow.includes('candidate'));
      assert(!jobs.has('candidate'));
      assert(!jobs.has('consumer'));
      assert(!jobs.has('native'));
    });

    it('should publish only after the frozen tree passed every runtime gate', () => {
      const needs = needsOf('publish');
      for (const dependency of ['preflight', 'assemble', 'smoke', 'browser', 'security']) {
        assert(needs.includes(dependency), `publish must need ${dependency}`);
      }
    });

    it('should consume the frozen artifacts only downstream of assembly', () => {
      for (const [name, body] of jobs) {
        if (name === 'assemble') continue;
        if (!/name: (prepared-release|test-tarballs)\b/u.test(body)) continue;
        assert(
          needsOf(name).includes('assemble'),
          `${name} consumes frozen artifacts and must need assemble`,
        );
      }
    });
  });

  describe('registry verification', () => {
    it('should wait for registry visibility with a bounded backoff', () => {
      const body = job('registry-verify');
      assert(
        body.includes(
          'node scripts/registry-wait.mjs --tarballs tarballs/test-tarballs.json --interval-seconds 30 --timeout-minutes 30',
        ),
      );
      assert(needsOf('registry-verify').includes('publish'));
    });

    it('should verify signatures and provenance against the frozen tarball inventory', () => {
      const body = job('registry-verify');
      assert(body.includes('npm audit signatures --json --include-attestations'));
      assert(body.includes('node scripts/verify-release-attestations.mjs'));
      assert(body.includes('npm install --force --ignore-scripts'));
    });

    it('should prove a normal install on each representative host', () => {
      const body = job('registry-smoke');
      assert(body.includes("NAPI_RS_ENFORCE_VERSION_CHECK: '1'"));
      assert(body.includes('NANORASTER_REGISTRY_VERSION'));
      // Two rows now share `ubuntu-24.04`, so the label names the job.
      assert(body.includes('name: registry-smoke (${{ matrix.label }})'));
      for (const label of ['linux-x64-gnu', 'darwin-arm64', 'win32-x64-msvc', 'linux-arm-gnueabihf-qemu']) {
        assert(body.includes(`label: ${label}`), `registry-smoke must cover ${label}`);
      }
      assert(needsOf('registry-smoke').includes('registry-verify'));
    });

    it('should install the armv7 package under emulation the way a consumer does', () => {
      // The `eabihf` ABI carries no `libc` selector, so npm keeps both armv7
      // packages: this is the only registry row that proves the loader picks
      // one of two. It needs the same qemu action and lavapipe manifest the
      // emulated `smoke` rows use.
      const body = job('registry-smoke');
      assert(body.includes('suffix: linux-arm-gnueabihf'));
      assert(body.includes('platform: linux/arm/v7'));
      assert(body.includes('image: node:22-bookworm-slim'));
      assert(body.includes('VK_DRIVER_FILES=$(ls /usr/share/vulkan/icd.d/lvp_icd*.json)'));
      assert(body.includes('node scripts/test-package.mjs'));
      const [qemu] = [...workflow.matchAll(/docker\/setup-qemu-action@(\w+)/gu)].map((match) => match[1]);
      assert.equal(occurrences(body, `docker/setup-qemu-action@${qemu}`), 1);
      assert(body.includes('timeout-minutes: 60'), 'the emulated row needs a ceiling');
    });

    it('should record the GitHub release only after every registry check passed', () => {
      assert.equal(occurrences(workflow, 'gh release create'), 1);
      const [name] = [...jobs].find(([, body]) => body.includes('gh release create'));
      assert.equal(name, 'registry-release');
      assert(needsOf('registry-release').includes('registry-smoke'));
      assert.equal(occurrences(workflow, 'contents: write'), 1);
      assert(job('registry-release').includes('contents: write'));
    });
  });

  describe('artifact transfer', () => {
    const verified = () => {
      const body = compositeActions.get('download-verified-artifact');
      assert(body, '.github/actions/download-verified-artifact must exist');
      return body;
    };

    it('should download every artifact through the verified action', () => {
      // A silent, empty `actions/download-artifact` left a Windows smoke row to
      // die forty seconds later inside test-package.mjs. Nothing may reach the
      // raw action again: the wrapper is the only place the landing is proved.
      assert.equal(
        occurrences(workflow, 'uses: actions/download-artifact@'),
        0,
        'ci.yml must not call actions/download-artifact directly',
      );
      const consumers = [...jobs].filter(([, body]) => body.includes('download-verified-artifact'));
      assert.deepEqual(
        consumers.map(([name]) => name).sort((left, right) => left.localeCompare(right)),
        ['assemble', 'browser', 'publish', 'registry-verify', 'smoke'],
        'every artifact-consuming job must use the verified download',
      );
      assert.equal(occurrences(workflow, 'uses: ./.github/actions/download-verified-artifact'), 6);
    });

    it('should name the file each frozen artifact must land', () => {
      assert.equal(
        occurrences(workflow, 'expect: test-tarballs.json'),
        3,
        'every test-tarballs consumer must demand the manifest',
      );
      assert(
        job('publish').includes(
          'expect: ${{ needs.assemble.outputs.archive }} ${{ needs.assemble.outputs.archive }}.sha256',
        ),
        'publish must demand the frozen archive and its digest sidecar',
      );
    });

    it('should verify the download, retry once, and verify the retry', () => {
      const body = verified();
      const downloads = occurrences(body, 'uses: actions/download-artifact@');
      assert.equal(downloads, 2, 'the wrapper allows exactly one bounded retry');
      const verifications = [...body.matchAll(/verify-artifact\.sh/gu)];
      assert.equal(verifications.length, 2, 'each download attempt must be verified');
      const [first, retry] = [...body.matchAll(/uses: actions\/download-artifact@\S+/gu)].map(
        (match) => match.index,
      );
      const [check, recheck] = verifications.map((match) => match.index);
      assert(first < check && check < retry && retry < recheck, 'verify, retry, verify');
      assert(
        body.includes("if: steps.verify.outputs.complete == 'false'"),
        'the retry and its recheck must be guarded by the first verification',
      );
      assert(
        !/while|until|for attempt/u.test(body),
        'the retry must stay a single explicit attempt, not a loop',
      );
    });

    it('should keep the pinned download-artifact release the repository already trusts', () => {
      assert.equal(
        occurrences(
          verified(),
          'actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093 # v4.3.0',
        ),
        2,
      );
    });

    it('should fail an empty landing with the artifact name and a listing', () => {
      const script = read('../.github/actions/download-verified-artifact/verify-artifact.sh');
      assert(script.includes('ARTIFACT'), 'the failure must name the artifact');
      assert(/ls -l/u.test(script), 'the failure must print what did land');
      assert(script.startsWith('#!/usr/bin/env bash\n'));
      assert(script.includes('set -euo pipefail'));
    });
  });

  describe('supply chain', () => {
    it('should check out without persisting the workflow credential', () => {
      const checkouts = occurrences(workflow, 'uses: actions/checkout@');
      assert(checkouts > 0, 'ci.yml must check the repository out');
      assert.equal(
        occurrences(workflow, 'persist-credentials: false'),
        checkouts,
        'every checkout in ci.yml must opt out of persisting credentials',
      );
    });

    it('should pin every third-party action to a full commit SHA', () => {
      // The composite actions are workflow surface too: an unpinned `uses:`
      // there is reachable from every job that composes them.
      const sources = [workflow, ...compositeActions.values()];
      const uses = sources.flatMap((source) =>
        [...source.matchAll(/uses: (\S+)/gu)].map((match) => match[1]),
      );
      assert(uses.length > 0);
      for (const reference of uses) {
        if (reference.startsWith('./')) continue;
        assert(
          /@[0-9a-f]{40}$/u.test(reference),
          `${reference} must be pinned to a forty-character commit SHA`,
        );
        assert(
          new RegExp(`uses: ${reference.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')} # v\\S+`, 'u').test(
            sources.join('\n'),
          ),
          `${reference} must carry a # vX.Y.Z comment naming the pinned release`,
        );
      }
    });

    it('should keep the root publish lifecycle build-free', () => {
      assert.equal(packageJson.scripts.prepublishOnly, 'node scripts/validate-pack.mjs');
    });

    it('should keep the retired native surfaces out of the tree', () => {
      for (const script of ['scripts/copy-native.mjs', 'scripts/candidate-manifest.mjs']) {
        assert(!existsSync(new URL(`../${script}`, import.meta.url)), `${script} must not exist`);
      }
      assert.deepEqual(JSON.parse(read('../nx.json')).release.projects, ['nanoraster']);
      assert(
        !/^\s*-\s*['"]?npm\/\*/mu.test(read('../pnpm-workspace.yaml')),
        'generated platform directories must not be workspace projects',
      );

      // The retired three-package layout named its platform packages in source.
      // Nothing may reintroduce that authority beside `package.json.napi`.
      const retired = /nativePackageNames?|nativePackages\b/u;
      const offenders = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' })
        .split('\n')
        .filter((file) => /\.(?:mjs|cjs|js|ts|tsx|json|ya?ml|md|sh|toml)$/u.test(file))
        .filter((file) => file !== 'tests/workflow-policy.test.mjs')
        .filter((file) => retired.test(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')));
      assert.deepEqual(offenders, []);
    });

    it('should run only dependency-free scripts in the jobs that install nothing', () => {
      // A job that verifies registry state or renders from a published package
      // deliberately installs no dependencies: it proves what a consumer gets
      // rather than what this checkout builds. Every script such a job runs has
      // to resolve from Node builtins and repository files alone, so a
      // development dependency reached through any import fails here instead of
      // after the release published.
      const dependencyFree = [...jobs]
        .filter(([, body]) => !installsDependencies(body))
        .map(([name, body]) => ({ name, scripts: scriptsRunBy(body) }))
        .filter(({ scripts }) => scripts.length > 0);

      assert.deepEqual(Object.fromEntries(dependencyFree.map(({ name, scripts }) => [name, scripts])), {
        preflight: ['scripts/ci-release.mjs'],
        'registry-smoke': ['scripts/test-package.mjs'],
        'registry-verify': ['scripts/registry-wait.mjs', 'scripts/verify-release-attestations.mjs'],
        smoke: ['scripts/test-package.mjs'],
      });

      for (const { name, scripts } of dependencyFree) {
        for (const script of scripts) {
          assert.deepEqual(
            packagesReachedBy(script),
            [],
            `${name} installs nothing, so ${script} must import no package`,
          );
        }
      }
    });

    it('should require every gate before declaring the run green', () => {
      const body = job('ci-gate');
      for (const required of [
        'preflight',
        'quality',
        'docs-prose',
        'node',
        'build',
        'assemble',
        'smoke',
        'browser',
        'security',
      ]) {
        assert(body.includes(`'${required}'`), `ci-gate must require ${required}`);
      }
      assert(body.includes("'publish', 'registry-verify', 'registry-smoke', 'registry-release'"));
      assert(body.includes("['success', 'skipped'].includes(needs.benchmark?.result)"));
    });
  });
});
