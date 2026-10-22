#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// Reads .corpus/verdicts.ndjson (written by mine-public-corpus.ts) and prints a
// category histogram + sampled raw errors per category, UNKNOWN first — so a human
// can pick real gaps to investigate against the matching .corpus/<repo>/<runId>/
// extracted artifact before proposing any new rule (Rule 0: never invent evidence).
//
// Usage: node dist/tools/corpus-report.js [--sample 5]
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

interface CorpusVerdict {
  repo: string; runId: number; runUrl: string;
  testName: string; project: string; suite: string | null;
  category: string; errorMessage: string | null;
}

function loadVerdicts(path: string): CorpusVerdict[] {
  const raw = readFileSync(path, 'utf8').trim();
  if (!raw) return [];
  return raw.split('\n').map(line => JSON.parse(line) as CorpusVerdict);
}

function truncate(s: string, len: number): string {
  return s.length <= len ? s : s.slice(0, len) + '…';
}

function main(): void {
  const flags: Record<string, string> = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) { flags[argv[i].slice(2)] = argv[i + 1]; i++; }
  }
  const sampleSize = Number(flags.sample ?? 5);

  const path = join('.corpus', 'verdicts.ndjson');
  const verdicts = loadVerdicts(path);
  if (!verdicts.length) {
    console.log(`No verdicts found at ${path}. Run mine-public-corpus.js first.`);
    return;
  }

  const counts: Record<string, number> = {};
  for (const v of verdicts) counts[v.category] = (counts[v.category] ?? 0) + 1;

  console.log(`Total mined failures: ${verdicts.length}\n`);
  console.log('Category histogram:');
  const ordered = Object.entries(counts).sort(([a], [b]) => (a === 'UNKNOWN' ? -1 : a.localeCompare(b)));
  for (const [category, n] of ordered) {
    const pct = ((n / verdicts.length) * 100).toFixed(1);
    console.log(`  ${category.padEnd(18)} ${String(n).padStart(5)}  (${pct}%)`);
  }

  console.log(`\nSampled cases per category (up to ${sampleSize}, UNKNOWN first):`);
  const byCategory = new Map<string, CorpusVerdict[]>();
  for (const v of verdicts) {
    if (!byCategory.has(v.category)) byCategory.set(v.category, []);
    byCategory.get(v.category)!.push(v);
  }
  const categoriesInOrder = ['UNKNOWN', ...[...byCategory.keys()].filter(c => c !== 'UNKNOWN').sort()];
  for (const category of categoriesInOrder) {
    const items = byCategory.get(category) ?? [];
    console.log(`\n── ${category} (${items.length}) ──`);
    for (const v of items.slice(0, sampleSize)) {
      console.log(`  ${v.repo}#${v.runId} [${v.project}] ${truncate(v.testName, 70)}`);
      console.log(`    ${truncate((v.errorMessage ?? '(no error message)').replace(/\n/g, ' '), 140)}`);
      console.log(`    ${v.runUrl}  →  .corpus/${v.repo.replace('/', '-')}/${v.runId}/`);
    }
  }
}

main();
