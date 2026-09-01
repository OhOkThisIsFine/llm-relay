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
import { spawn } from 'node:child_process';

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

async function runStep(step) {
  return new Promise((resolve) => {
    const child = spawn(step.command, {
      cwd: process.cwd(),
      shell: true,
      env: process.env,
    });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (data) => {
      stdout += data.toString('utf8');
    });

    child.stderr?.on('data', (data) => {
      stderr += data.toString('utf8');
    });

    const timer = setTimeout(() => {
      child.kill();
    }, 120000);

    child.on('close', (code) => {
      clearTimeout(timer);
      const output = `${stdout}${stderr}`.trim();
      const status = code ?? 1;

      const txtFile = join(reportDir, step.txt);
      writeFileSync(txtFile, output.length ? output : '(no output)');

      if (step.json) {
        writeFileSync(join(reportDir, step.json), output.length ? output : '[]');
      }

      writeFileSync(join(reportDir, `${step.name}.exit.txt`), `${status}`);

      resolve({
        name: step.name,
        status,
        optional: Boolean(step.optional),
      });
    });

    child.on('error', () => {
      clearTimeout(timer);
      writeFileSync(join(reportDir, `${step.name}.exit.txt`), '1');
      resolve({
        name: step.name,
        status: 1,
        optional: Boolean(step.optional),
      });
    });
  });
}

const results = await Promise.all(steps.map(runStep));

const summary = [`Generated: ${new Date().toISOString()}`];
const failures = [];

for (const res of results) {
  summary.push(`${res.name}: ${res.status}`);
  if (res.status !== 0 && !res.optional) {
    failures.push(res.name);
  }
}

summary.push(`\nFailures: ${failures.length ? failures.join(', ') : 'none'}`);
writeFileSync(join(reportDir, 'run-summary.txt'), `${summary.join('\n')}\n`);

if (failures.length > 0) {
  process.exitCode = 1;
}
