import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
export function evalFingerprint(root) {
  const files = [
    ...readdirSync(join(root, 'src'))
      .filter((name) => name.endsWith('.ts'))
      .map((name) => `src/${name}`),
    'locales/en.json',
    'locales/es.json',
    'evals/cases.json',
    'scripts/eval-fixture.ts',
    'scripts/eval-agents.mjs',
    'scripts/eval-grade.mjs',
    'scripts/eval-fingerprint.mjs',
  ].sort();
  const hash = createHash('sha256');
  for (const name of files)
    hash
      .update(name)
      .update('\0')
      .update(readFileSync(join(root, name)))
      .update('\0');
  return hash.digest('hex');
}
