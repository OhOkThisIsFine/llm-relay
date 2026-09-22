import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const self = fileURLToPath(import.meta.url);
const role = process.argv[2];
const PRODUCER_BURST_BYTES = 64 * 1024;
const listen = async (server) => {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
};
const summary = (samples) => {
  assert(samples.length > 0 && samples.every(Number.isFinite));
  const sorted = [...samples].sort((a, b) => a - b);
  return { samples, median: sorted[Math.floor(sorted.length / 2)], p95: sorted[Math.ceil(sorted.length * .95) - 1] };
};

async function upstream() {
  let settings = { bytes: 1024, hold: false, token: 0 };
  const server = createServer(async (req, res) => {
    try {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const request = JSON.parse(raw);
      const { bytes, hold, token } = settings;
      res.on('close', () => process.send?.({ event: 'closed', token, finished: res.writableFinished }));
      if (!request.stream) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'bench', object: 'chat.completion', model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: 'served' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const frame = (delta, finish_reason = null) => `data: ${JSON.stringify({ id: 'bench', object: 'chat.completion.chunk', model: 'm', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
      res.write(frame({ role: 'assistant' }));
      for (let sent = 0; sent < bytes && !res.destroyed; sent += 4096) {
        if (!res.write(frame({ content: 'x'.repeat(Math.min(4096, bytes - sent)) }))) {
          await new Promise((resolve) => {
            const done = () => { res.off('drain', done); res.off('close', done); resolve(); };
            res.once('drain', done); res.once('close', done);
          });
        }
        // Bound synthetic pacing to one timer per burst, not per 4 KiB frame.
        // Windows timer granularity can otherwise dominate a multi-MiB measurement.
        if ((sent + 4096) % PRODUCER_BURST_BYTES === 0) await delay(1);
      }
      if (!hold && !res.destroyed) res.end(frame({}, 'stop') + 'data: [DONE]\n\n');
    } catch (error) { if (!res.destroyed) res.destroy(error); }
  });
  process.on('message', ({ id, op, value }) => {
    if (op === 'configure') { settings = value; process.send({ id, value: true }); }
  });
  process.send({ event: 'ready', base: await listen(server) });
}

async function relay() {
  const { createProxy } = await import('../../dist/server.js');
  const { ModelCatalog } = await import('../../dist/catalog.js');
  const { transactionalUpdateJsonSync } = await import('../../dist/storage/json-store.js');
  const config = {
    host: '127.0.0.1', port: 0,
    providers: { bench: { base: process.env.RELAY_BENCH_UPSTREAM, kind: 'openai', authHeader: 'authorization', credentialMode: 'contained', timeoutMs: 10000 } },
    routing: { default: 'bench/m', tiers: {}, benchmarkSort: false },
    mode: 'detect', repair: { maxAttempts: 2, destructiveTools: [] }, log: { level: 'silent', file: null },
  };
  const server = createProxy(config, { catalog: new ModelCatalog({ cachePath: null }) });
  let before;
  let peak;
  let timer;
  const sample = () => {
    const now = process.memoryUsage();
    for (const key of Object.keys(now)) peak[key] = Math.max(peak[key], now[key]);
  };
  process.on('message', ({ id, op }) => {
    try {
      let value;
      if (op === 'sample-start') {
        global.gc?.();
        before = process.memoryUsage(); peak = { ...before };
        timer = setInterval(sample, 10);
        value = true;
      } else if (op === 'sample-stop') {
        clearInterval(timer); sample();
        value = { before, peak, growth: Object.fromEntries(Object.keys(peak).map((k) => [k, peak[k] - before[k]])) };
      } else if (op === 'storage') {
        value = {};
        for (const count of [64, 512]) {
          const path = join(process.env.RELAY_BENCH_HOME, `rows-${count}.json`);
          const rows = Array.from({ length: count }, (_, i) => ({ id: i, text: 'x'.repeat(256) }));
          transactionalUpdateJsonSync(path, () => ({ rows, revision: 0 }), { strict: true });
          const samples = [];
          for (let i = 0; i < 30; i++) {
            const start = performance.now();
            transactionalUpdateJsonSync(path, (current) => ({ ...current, revision: i + 1 }), { strict: true });
            samples.push(performance.now() - start);
          }
          value[count] = summary(samples);
        }
      } else throw new Error(`Unknown operation: ${op}`);
      process.send({ id, value });
    } catch (error) { process.send({ id, error: String(error) }); }
  });
  process.send({ event: 'ready', base: await listen(server) });
}

async function measure() {
  const dir = mkdtempSync(join(tmpdir(), 'relay-refactor-baseline-'));
  const workers = [];
  let sequence = 0;
  function start(kind, extra = {}) {
    const home = join(dir, String(workers.length)); mkdirSync(home);
    // Do not inherit provider keys, user config, proxy variables, or NODE_OPTIONS.
    const env = Object.fromEntries(['PATH', 'Path', 'SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP', 'TMPDIR'].filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]]));
    Object.assign(env, { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: home, XDG_CACHE_HOME: home, RELAY_BENCH_HOME: home }, extra);
    const child = fork(self, [kind], { env, execArgv: ['--expose-gc'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-8192); });
    child.stdout.resume();
    const pending = new Map();
    const events = [];
    child.on('message', (msg) => {
      if (msg.id !== undefined) pending.get(msg.id)?.(msg);
      else events.push(msg);
    });
    const closed = once(child, 'close');
    const waitEvent = async (predicate) => {
      const deadline = performance.now() + 20000;
      for (;;) {
        const index = events.findIndex(predicate);
        if (index >= 0) return events.splice(index, 1)[0];
        if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Worker exited: ${stderr}`);
        if (performance.now() > deadline) throw new Error(`Worker barrier timed out: ${stderr}`);
        await delay(5);
      }
    };
    const rpc = async (op, value) => {
      const id = ++sequence;
      const result = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`RPC timeout: ${op}`)); }, 20000);
        pending.set(id, (msg) => { clearTimeout(timeout); pending.delete(id); msg.error ? reject(new Error(msg.error)) : resolve(msg.value); });
      });
      child.send({ id, op, value });
      return result;
    };
    const worker = { child, closed, waitEvent, rpc }; workers.push(worker); return worker;
  }
  try {
    const up = start('upstream');
    const upstreamBase = (await up.waitEvent((m) => m.event === 'ready')).base;
    const startups = [];
    let proxy;
    let base;
    for (let i = 0; i < 3; i++) {
      const t = performance.now();
      proxy = start('relay', { RELAY_BENCH_UPSTREAM: upstreamBase });
      base = (await proxy.waitEvent((m) => m.event === 'ready')).base;
      startups.push(performance.now() - t);
      if (i < 2) { proxy.child.kill(); await proxy.closed; }
    }
    const timerSamples = [];
    for (let i = 0; i < 12; i++) {
      const t = performance.now(); await delay(1); timerSamples.push(performance.now() - t);
    }
    const timerDelayMs = summary(timerSamples);
    process.stderr.write(JSON.stringify({ probe: 'runtime-baseline', stage: 'timer-calibration', timerDelayMs }) + '\n');
    const result = { version: 2, node: process.version, platform: process.platform, arch: process.arch, producerBurstBytes: PRODUCER_BURST_BYTES, timerDelayMs, startupMs: summary(startups), fronts: {}, storageMs: null };
    for (const path of ['/v1/messages', '/v1/chat/completions', '/v1/responses']) {
      const body = (stream) => path === '/v1/responses'
        ? { model: 'bench/m', input: 'hello', max_output_tokens: 32, stream }
        : { model: 'bench/m', messages: [{ role: 'user', content: 'hello' }], max_tokens: 32, stream };
      const post = (stream, signal = AbortSignal.timeout(20000)) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body(stream)), signal });
      const samples = [];
      for (let i = 0; i < 33; i++) {
        const t = performance.now(); const response = await post(false);
        assert.equal(response.status, 200); assert.match(await response.text(), /served/);
        if (i >= 3) samples.push(performance.now() - t);
      }
      const streams = [];
      for (const bytes of [1024 * 1024, 8 * 1024 * 1024]) {
        process.stderr.write(JSON.stringify({ probe: 'runtime-baseline', stage: 'stream', path, bytes }) + '\n');
        await up.rpc('configure', { bytes, hold: false, token: ++sequence });
        await proxy.rpc('sample-start');
        const t = performance.now(); const response = await post(true); assert.equal(response.status, 200);
        let wireBytes = 0; let firstChunkMs;
        for await (const chunk of response.body) {
          firstChunkMs ??= performance.now() - t; wireBytes += chunk.byteLength;
          await delay(2);
        }
        assert(wireBytes >= bytes, 'Stream must contain the complete synthetic text');
        streams.push({ payloadBytes: bytes, wireBytes, firstChunkMs, elapsedMs: performance.now() - t, memory: await proxy.rpc('sample-stop') });
      }
      const cancellation = [];
      for (let i = 0; i < 3; i++) {
        const token = ++sequence;
        await up.rpc('configure', { bytes: 4096, hold: true, token });
        const controller = new AbortController();
        const response = await post(true, controller.signal); assert.equal(response.status, 200);
        const reader = response.body.getReader(); assert.equal((await reader.read()).done, false);
        const t = performance.now(); controller.abort();
        const closed = await up.waitEvent((m) => m.event === 'closed' && m.token === token);
        assert.equal(closed.finished, false);
        cancellation.push(performance.now() - t);
        await reader.cancel().catch(() => {});
      }
      await up.rpc('configure', { bytes: 1024, hold: false, token: ++sequence });
      result.fronts[path] = { responseMs: summary(samples), streams, cancellationMs: summary(cancellation) };
    }
    result.storageMs = await proxy.rpc('storage');
    console.log(JSON.stringify(result));
  } finally {
    for (const worker of workers) if (worker.child.exitCode === null && worker.child.signalCode === null) worker.child.kill();
    await Promise.allSettled(workers.map((w) => w.closed));
    rmSync(dir, { recursive: true, force: true });
  }
}
if (role === 'upstream') await upstream();
else if (role === 'relay') await relay();
else if (role === undefined) await measure();
else throw new Error(`Unknown role: ${role}`);
