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

// ---------------------------------------------------------------------------
// ATTRIBUTION. `--only <step>` runs exactly ONE step and exits with ITS status.
//
// It exists for the machine-wide nightly sweep
// (`~/.claude/scheduled-tasks/nightly-maintenance/static-analysis-runner.mjs`), which
// reads `.claude/static-analysis.json`, runs each declared tool's `command`, and keys
// its report by that tool's `name`. This script used to be declared as ONE entry whose
// name was the whole six-tool list, so a failure anywhere inside it surfaced as a
// single opaque line — `FINDING llm-relay — eslint + sonarjs, knip, madge, …: exit 1`
// — naming none of the six. Splitting the declaration into one entry per step only
// works if each entry can run just its own step, which is what this flag is for.
//
// ⚠ The sweep spawns WITHOUT a shell (see `~/.agent-config/spawn-safe.mjs`), so the
// declared command lines are tokenized once: `npm run analysis:run -- --only eslint`
// is the spelling that survives that, and a step name is therefore safe to quote when
// it holds a hyphen (`--only "dependency-cruiser"`).
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
let only = null;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--only') {
    only = argv[++i] ?? '';
  } else if (argv[i].startsWith('--only=')) {
    only = argv[i].slice('--only='.length);
  } else {
    console.error(`analysis-run: unknown argument "${argv[i]}" (the only flag is --only <step>)`);
    process.exit(2);
  }
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
    // The JSON report is written by jscpd's own reporter (`jscpd-report.json` in the report
    // directory), never by capturing console text under a `.json` name — which is what this step
    // did until 2026-09-04 (audit finding DR-018: `jscpd.json` held ANSI console output).
    name: 'jscpd',
    command: 'npx jscpd src test scripts --reporters console,json --output analysis-reports',
    txt: 'jscpd.txt',
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

      // A `.json` file is written only from STDOUT and only when it parses: stderr noise glued to
      // a JSON report, or a tool that printed console text, used to land under a `.json` name.
      let jsonState = 'none';
      if (step.json) {
        let parsed = false;
        try {
          JSON.parse(stdout);
          parsed = true;
        } catch {
          parsed = false;
        }
        if (parsed) {
          writeFileSync(join(reportDir, step.json), stdout);
          jsonState = 'written';
        } else {
          jsonState = 'stdout was not JSON, no .json written';
        }
      }

      writeFileSync(join(reportDir, `${step.name}.exit.txt`), `${status}`);

      resolve({
        name: step.name,
        status,
        jsonState,
        optional: Boolean(step.optional),
      });
    });

    child.on('error', () => {
      clearTimeout(timer);
      writeFileSync(join(reportDir, `${step.name}.exit.txt`), '1');
      resolve({
        name: step.name,
        status: 1,
        jsonState: 'spawn failed',
        optional: Boolean(step.optional),
      });
    });
  });
}

// The full sweep runs every step CONCURRENTLY; a single-step run is the same code path with a
// one-element list, so the two cannot drift in how a step is spawned, timed or written out.
const selected = only === null ? steps : steps.filter((s) => s.name === only);
if (only !== null && selected.length === 0) {
  console.error(
    `analysis-run: no step named "${only}". Known steps: ${steps.map((s) => s.name).join(', ')}`,
  );
  process.exit(2);
}

const results = await Promise.all(selected.map(runStep));

// The summary states each figure for what it is. Until 2026-09-04 it printed the process EXIT
// CODE under the tool's bare name (`jscpd: 0`) beside `Failures: none`, which read as a finding
// count — while the jscpd run it summarized had reported 572 clone blocks (audit finding DR-018).
// Findings live in the per-tool files; this summary only says whether each tool RAN.
const summary = [
  `Generated: ${new Date().toISOString()}`,
  only === null
    ? 'Scope: the full sweep.'
    : `Scope: ONLY the "${only}" step (--only); other steps are untouched from their last full run.`,
  'Each line is the tool\'s process exit code, not a finding count. Read the per-tool report files for findings.',
];
const failures = [];

for (const res of results) {
  summary.push(`${res.name}: exit ${res.status}${res.jsonState === 'none' ? '' : ` (json: ${res.jsonState})`}`);
  if (res.status !== 0 && !res.optional) {
    failures.push(res.name);
  }
}

summary.push(`\nTools exiting non-zero: ${failures.length ? failures.join(', ') : 'none'}`);
// ⚠ A RUN OF ONE STEP MUST NOT OVERWRITE THE FULL SWEEP'S SUMMARY. The nightly sweep runs each
// step as its own process, i.e. six consecutive single-step runs; writing the summary from each
// would leave `run-summary.txt` describing only whichever step finished last, which reads as a
// clean sweep of one tool. The per-step report files and `<step>.exit.txt` are still written —
// they are the attribution the sweep needs — and the summary is the full sweep's alone.
if (only === null) {
  writeFileSync(join(reportDir, 'run-summary.txt'), `${summary.join('\n')}\n`);
}

// A single-step run is an ATTRIBUTED exit: it reports THAT step's status, so the caller can key
// its report by the step it asked for. A step that legitimately exits non-zero (jscpd reports
// clones with exit 1) is the finding; a step that never ran is exit 2, already handled above.
if (only !== null) {
  process.exitCode = results[0].status;
} else if (failures.length > 0) {
  process.exitCode = 1;
}
