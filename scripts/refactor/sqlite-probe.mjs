import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, openSync, closeSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';

function synchronous(mode) { return mode === 'DELETE' ? 'EXTRA' : 'FULL'; }

function open(path, mode) {
  const db = new DatabaseSync(path, { allowExtension: false, enableForeignKeyConstraints: true });
  db.exec(`PRAGMA journal_mode=${mode}; PRAGMA synchronous=${synchronous(mode)}; PRAGMA busy_timeout=100;`);
  return db;
}

if (!isMainThread) {
  const db = open(workerData.path, workerData.mode);
  parentPort.on('message', () => {
    const t = performance.now();
    try { db.exec("INSERT INTO jobs VALUES ('busy', 'busy', 'running')"); parentPort.postMessage({ inserted: true }); }
    catch (error) { parentPort.postMessage({ inserted: false, code: error.code, message: error.message, elapsedMs: performance.now() - t }); }
  });
  parentPort.postMessage('ready');
} else if (process.argv[2] === 'crash-writer') {
  const db = open(process.argv[3], process.argv[4]);
  db.exec("BEGIN IMMEDIATE; INSERT INTO jobs VALUES ('uncertain', 'uncertain', 'running');");
  process.send('uncommitted');
  // The parent kills this process only after receiving the transaction barrier.
  setInterval(() => {}, 1000);
} else {
  const dir = mkdtempSync(join(tmpdir(), 'relay-sqlite-probe-'));
  const results = [];
  try {
    for (const mode of ['DELETE', 'WAL']) {
      const path = join(dir, `${mode}.db`);
      closeSync(openSync(path, 'wx', 0o600));
      let db = open(path, mode);
      let worker;
      let crashed;
      let crashExit;
      try {
        db.exec(`CREATE TABLE jobs (id TEXT PRIMARY KEY, submission TEXT NOT NULL UNIQUE, status TEXT NOT NULL) STRICT;
          CREATE TABLE results (job_id TEXT PRIMARY KEY REFERENCES jobs(id), output TEXT NOT NULL) STRICT;
          PRAGMA user_version=1;`);
        assert.equal(db.prepare('PRAGMA synchronous').get().synchronous, mode === 'DELETE' ? 3 : 2);
        assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
        assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, mode.toLowerCase());
        assert.throws(() => db.enableLoadExtension(true));
        assert.throws(() => db.exec("SELECT load_extension('never-load')"));
        assert.throws(() => db.exec("INSERT INTO results VALUES ('absent', 'fixture')"));
        db.exec("INSERT INTO jobs VALUES ('done', 'key', 'running')");
        assert.throws(() => db.exec("INSERT INTO jobs VALUES ('duplicate', 'key', 'running')"));
        db.exec("BEGIN IMMEDIATE; UPDATE jobs SET status='completed' WHERE id='done'; INSERT INTO results VALUES ('done','synthetic result'); ROLLBACK;");
        assert.equal(db.prepare("SELECT status FROM jobs WHERE id='done'").get().status, 'running');
        assert.equal(db.prepare('SELECT count(*) AS n FROM results').get().n, 0);
        db.exec("BEGIN IMMEDIATE; UPDATE jobs SET status='completed' WHERE id='done'; INSERT INTO results VALUES ('done','synthetic result'); COMMIT;");
        const query = () => db.prepare('SELECT status, output FROM jobs JOIN results ON id=job_id').get();
        assert.deepEqual({ ...query() }, { status: 'completed', output: 'synthetic result' });

        worker = new Worker(new URL(import.meta.url), { workerData: { path, mode } });
        assert.equal((await once(worker, 'message'))[0], 'ready');
        db.exec('BEGIN IMMEDIATE');
        let ticks = 0;
        const timer = setInterval(() => ticks++, 5);
        const waiting = once(worker, 'message');
        worker.postMessage('write');
        const [busy] = await waiting;
        clearInterval(timer);
        db.exec('ROLLBACK');
        assert.equal(busy.inserted, false);
        assert.match(busy.message, /locked|busy/i);
        assert(ticks > 0, 'Database contention must not block the parent event loop');
        await worker.terminate(); worker = undefined;

        crashed = fork(fileURLToPath(import.meta.url), ['crash-writer', path, mode], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], execArgv: [] });
        let crashError = '';
        crashed.stderr.on('data', (chunk) => { crashError = (crashError + chunk).slice(-4096); });
        crashExit = once(crashed, 'close');
        const barrier = await Promise.race([once(crashed, 'message').then(([m]) => m), crashExit.then(() => { throw new Error(crashError || 'Writer exited before barrier'); })]);
        assert.equal(barrier, 'uncommitted');
        crashed.kill(); await crashExit; crashed = undefined;
        db.close(); db = open(path, mode);
        assert.equal(db.prepare('SELECT count(*) AS n FROM jobs WHERE id=?').get('uncertain').n, 0);
        assert.deepEqual({ ...query() }, { status: 'completed', output: 'synthetic result' });
        assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');

        const timings = [];
        const insert = db.prepare('INSERT INTO jobs VALUES (?,?,?)');
        for (let i = 0; i < 100; i++) {
          const t = performance.now();
          db.exec('BEGIN IMMEDIATE'); insert.run(`job-${i}`, `submission-${i}`, 'running'); db.exec('COMMIT');
          timings.push(performance.now() - t);
        }
        timings.sort((a, b) => a - b);
        const files = readdirSync(dir).filter((name) => name.startsWith(mode)).map((name) => ({ name, bytes: statSync(join(dir, name)).size, mode: statSync(join(dir, name)).mode & 0o777 }));
        if (process.platform !== 'win32') assert(files.every((f) => (f.mode & 0o077) === 0), 'Database and sidecars must stay private');
        results.push({ mode, synchronous: synchronous(mode), busy, parentTimerTicks: ticks, commitMs: { median: timings[50], p95: timings[94] }, files });
      } finally {
        if (crashed) { crashed.kill(); await crashExit; }
        await worker?.terminate();
        db.close();
      }
    }
    console.log(JSON.stringify({ node: process.version, platform: process.platform, sqlite: process.versions.sqlite, results }));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
