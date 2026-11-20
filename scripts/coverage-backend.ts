import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const root = '/app/coverage-v8';
const input = join(root, 'input');
await mkdir(input, { recursive: true });

let count = 0;
for (const entry of await readdir(root, { withFileTypes: true })) {
  if (!entry.isDirectory() || entry.name === 'input' || entry.name === 'report') continue;
  const folder = join(root, entry.name);
  for (const report of await readdir(folder)) {
    if (!/^coverage-\d+-\d+-\d+\.json$/u.test(report)) continue;
    await copyFile(join(folder, report), join(input, entry.name + '-' + report));
    count += 1;
  }
}

if (!count) throw new Error('Aucun fichier de couverture V8 trouvé après l’arrêt des services.');
const result = spawnSync(
  'c8',
  [
    'report',
    '--temp-directory',
    input,
    '--reports-dir',
    join(root, 'report'),
    '--reporter',
    'text-summary',
    '--reporter',
    'html',
    '--reporter',
    'lcov',
    '--exclude-after-remap',
    '--all',
    '--extension',
    '.ts',
    '--include',
    'apps/{api,receipt,job-runner}/src/**/*.ts',
    '--include',
    'packages/{infra,contracts}/src/**/*.ts',
    '--exclude',
    '**/*.test.ts',
  ],
  { stdio: 'inherit' },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
