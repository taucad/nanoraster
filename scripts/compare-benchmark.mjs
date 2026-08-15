#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const THRESHOLD = 0.1;
const MARKER = '<!-- nanoraster-benchmark -->';

const stableJson = (value) => JSON.stringify(value);

export const compareBenchmark = (current, base) => {
  if (!base || current.name !== base.name) {
    return {
      failed: false,
      markdown: `${MARKER}\n### Benchmark\n\nNew benchmark admitted: \`${current.name}\` (${current.medianMs} ms median).`,
    };
  }
  if (
    current.outputBytes !== base.outputBytes ||
    current.outputFnv !== base.outputFnv ||
    stableJson(current.codecConformance) !== stableJson(base.codecConformance)
  ) {
    return {
      failed: true,
      markdown: `${MARKER}\n### Benchmark\n\nByte fingerprints changed for \`${current.name}\`. Rename the benchmark only when the semantic change is intentional.`,
    };
  }

  const change = (current.medianMs - base.medianMs) / base.medianMs;
  const percentage = `${change >= 0 ? '+' : ''}${(change * 100).toFixed(1)}%`;
  return {
    failed: change > THRESHOLD,
    markdown: `${MARKER}\n### Benchmark\n\n| Benchmark | main | PR | Change | Limit |\n| --- | ---: | ---: | ---: | ---: |\n| \`${current.name}\` | ${base.medianMs} ms | ${current.medianMs} ms | ${percentage} | +10.0% |`,
  };
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const currentPath = process.argv[2];
  const basePath = process.argv[3];
  const outputPath = process.argv[4];
  if (!currentPath || !outputPath) {
    throw new Error('usage: node scripts/compare-benchmark.mjs <current.json> <base.json|-> <output.md>');
  }
  const current = JSON.parse(readFileSync(currentPath, 'utf8'));
  const base = basePath && basePath !== '-' ? JSON.parse(readFileSync(basePath, 'utf8')) : undefined;
  const result = compareBenchmark(current, base);
  writeFileSync(outputPath, `${result.markdown}\n`);
  process.stdout.write(`${result.markdown}\n`);
  if (result.failed) process.exitCode = 1;
}
