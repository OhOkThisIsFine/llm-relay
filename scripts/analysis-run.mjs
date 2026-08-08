/**
 * `npm run analysis:run` — the ADVISORY static-analysis sweep. Writes every tool's raw output to
 * `analysis-reports/` (gitignored) for a human to read.
 *
 * ⚠ Deliberately NOT part of `npm run check`, and CI does not run it. The gate stays the two
 * typechecks plus the suite. These tools disagree with this codebase on purpose in places — a
 * loopback-only proxy is *supposed* to name `http://127.0.0.1`, the dispatch ladder is *supposed*
 * to name CLIs resolved from PATH, and the tests are *supposed* to use temp directories. Those
 * rules are switched off in `eslint.config.mjs` with the invariant each contradicts named next to
 * it; what remains as a warning (cognitive complexity, super-linear regexes) is worth reading, not
 * worth blocking a release over.
 *
 * The tools are invoked through `npx`, so knip cannot see the references — hence the
 * `ignoreDependencies` list in `knip.config.json`. Keep the two in step when adding a step here.
 */
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const reportDir = join(process.cwd(), 'analysis-reports');
if (!existsSync(reportDir)) {
  mkdirSync(reportDir, { recursive: true });
}

const steps = [
  {
    name: 'eslint-after-fixes',
    command: 'npx eslint "src/**/*.ts" "test/**/*.ts" "scripts/**/*.mjs" --format json',
    json: 'eslint-after-fixes.json',
    txt: 'eslint-after-fixes.txt',
  },
  {
    name: 'knip-after-fixes',
    command: 'npx knip --include dependencies,unlisted --config knip.config.json --reporter json',
    json: 'knip-after-fixes.txt',
    txt: 'knip-after-fixes.txt',
  },
  {
    name: 'madge',
    command: 'npx madge --circular --json src test scripts',
    json: 'madge.txt',
    txt: 'madge.txt',
  },
  {
    name: 'dependency-cruiser',
    command: 'npx dependency-cruiser src test scripts',
    txt: 'dependency-cruiser.txt',
  },
  {
    name: 'ts-prune',
    command: 'npx ts-prune',
    txt: 'ts-prune.txt',
  },
  {
    name: 'jscpd',
    command: 'npx jscpd src test scripts',
    txt: 'jscpd.txt',
    json: 'jscpd.json',
  },
  {
    name: 'similarity-ts-attempt',
    command: 'npx similarity-ts',
    txt: 'similarity-ts.txt',
    optional: true,
    json: null,
  },
];

const failures = [];
const summary = [`Generated: ${new Date().toISOString()}`];

for (const step of steps) {
  const result = spawnSync(step.command, {
    cwd: process.cwd(),
    encoding: 'utf8',
    shell: true,
    env: process.env,
    timeout: 120000,
  });

  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  const output = `${stdout}${stderr}`.trim();
  const status = result.status ?? 1;

  const txtFile = join(reportDir, step.txt);
  writeFileSync(txtFile, output.length ? output : '(no output)');

  if (step.json) {
    writeFileSync(join(reportDir, step.json), output.length ? output : '[]');
  }

  writeFileSync(join(reportDir, `${step.name}.exit.txt`), `${status}`);
  summary.push(`${step.name}: ${status}`);

  if (status !== 0 && !step.optional) {
    failures.push(step.name);
  }
}

summary.push(`\nFailures: ${failures.length ? failures.join(', ') : 'none'}`);
writeFileSync(join(reportDir, 'run-summary.txt'), `${summary.join('\n')}\n`);

if (failures.length > 0) {
  process.exitCode = 1;
}
