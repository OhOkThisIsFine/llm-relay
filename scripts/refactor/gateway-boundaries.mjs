import assert from 'node:assert/strict';
import { execFile, fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

// Companion to gateway-contracts: native bypasses and providers supporting exactly one wire.
const PATHS = { messages: '/v1/messages', chat: '/v1/chat/completions', responses: '/v1/responses' };
const MODELS = { messages: 'claude-3-5-sonnet-20241022', chat: 'gpt-4o-mini', responses: 'gpt-4o-mini' };
const IMAGES = {
  litellm: 'ghcr.io/berriai/litellm@sha256:d295634e09c648dcdb72c4cc2dd226f5fb87823a73e88cbbed6f205e4deb044b',
  bifrost: 'maximhq/bifrost@sha256:a8942692af7b4b89196cd8fc33653b7353488dfd58b24078fe793b8574a8084b',
};
const KEY = 'synthetic-boundary-provider-key';
const TEXT = 'boundary-answer-π';
const EXTENSION = { nested: [null, { value: 'preserve-🧪' }] };
const self = fileURLToPath(import.meta.url);
const exec = promisify(execFile);
const provider = (wire) => wire === 'messages' ? 'anthropic' : 'openai';
const cleanEnv = (dir) => ({ ...Object.fromEntries(['PATH', 'Path', 'SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP', 'TMPDIR'].filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]])), HOME: dir, USERPROFILE: dir, XDG_CONFIG_HOME: dir, XDG_CACHE_HOME: dir, XDG_STATE_HOME: dir });
async function listen(server) { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return `http://127.0.0.1:${server.address().port}`; }
async function stop(server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
async function until(predicate, label, ms = 10000) {
  const deadline = Date.now() + ms;
  while (!predicate()) { if (Date.now() >= deadline) throw new Error(`Timed out: ${label}`); await delay(5); }
}
function request(front, model, token, stream = false) {
  const input = `synthetic task ${token}`;
  return { model, stream, ...(front === 'responses' ? { input, max_output_tokens: 32 } : { messages: [{ role: 'user', content: input }], max_tokens: 32 }) };
}
function reply(wire) {
  if (wire === 'messages') return { id: 'msg_boundary', type: 'message', role: 'assistant', model: MODELS[wire], content: [{ type: 'text', text: TEXT }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 13, output_tokens: 3, cache_creation_input_tokens: 7, cache_read_input_tokens: 11 } };
  if (wire === 'chat') return { id: 'chatcmpl_boundary', object: 'chat.completion', created: 1, model: MODELS[wire], choices: [{ index: 0, message: { role: 'assistant', content: TEXT }, finish_reason: 'stop' }], usage: { prompt_tokens: 31, completion_tokens: 3, total_tokens: 34, prompt_tokens_details: { cached_tokens: 11 } } };
  return { id: 'resp_boundary', object: 'response', created_at: 1, model: MODELS[wire], status: 'completed', error: null, incomplete_details: null, output: [{ type: 'message', id: 'msg_boundary', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: TEXT, annotations: [] }] }], usage: { input_tokens: 31, output_tokens: 3, total_tokens: 34, input_tokens_details: { cached_tokens: 11 } } };
}
function streamParts(wire) {
  const body = reply(wire);
  const event = (value) => `${wire === 'chat' ? '' : `event: ${value.type}\n`}data: ${JSON.stringify(value)}\n\n`;
  if (wire === 'chat') {
    const chunk = (delta, finish_reason = null) => ({ id: body.id, object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason }] });
    return [event(chunk({ role: 'assistant', content: TEXT })), event({ ...chunk({}, 'stop'), usage: body.usage }) + 'data: [DONE]\n\n'];
  }
  if (wire === 'messages') return [
    event({ type: 'message_start', message: { ...body, content: [], stop_reason: null, usage: { ...body.usage, output_tokens: 0 } } }) + event({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) + event({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: TEXT } }),
    event({ type: 'content_block_stop', index: 0 }) + event({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } }) + event({ type: 'message_stop' }),
  ];
  const item = body.output[0];
  return [
    [{ type: 'response.created', response: { ...body, output: [], status: 'in_progress', usage: null } }, { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [], status: 'in_progress' } }, { type: 'response.content_part.added', item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } }, { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: TEXT }].map((value, i) => event({ ...value, sequence_number: i })).join(''),
    [{ type: 'response.output_text.done', item_id: item.id, output_index: 0, content_index: 0, text: TEXT }, { type: 'response.content_part.done', item_id: item.id, output_index: 0, content_index: 0, part: item.content[0] }, { type: 'response.output_item.done', output_index: 0, item }, { type: 'response.completed', response: body }].map((value, i) => event({ ...value, sequence_number: i + 4 })).join(''),
  ];
}
async function text(response) {
  const parts = []; let size = 0;
  for await (const part of response.body) { size += part.byteLength; assert(size <= 262144, 'Unbounded fixture response'); parts.push(part); }
  return Buffer.concat(parts).toString('utf8');
}
function assertNative(body, expected) { assert.deepEqual(body, expected); }
function assertWire(calls, expected) { assert.equal(calls.length, 1, 'Expected one task egress'); assert.equal(calls[0].path, expected, 'Configured provider wire changed'); }
function assertCredentials(headers) {
  assert(!JSON.stringify(headers).includes('synthetic-caller-key'), 'Caller credential leaked');
  assert(JSON.stringify(headers).includes(KEY), 'Configured provider credential not used');
}
async function relayChild(wire) {
  const { createProxy } = await import('../../dist/server.js');
  const { ModelCatalog } = await import('../../dist/catalog.js');
  const server = createProxy({ host: '127.0.0.1', port: 0,
    providers: { fixture: { base: process.env.BOUNDARY_UPSTREAM, kind: wire === 'messages' ? 'anthropic' : 'openai', ...(wire === 'messages' ? {} : { wire }), authEnv: 'BOUNDARY_KEY', authHeader: wire === 'messages' ? 'x-api-key' : 'authorization', credentialMode: 'contained', timeoutMs: 10000 } },
    routing: { default: `fixture/${MODELS[wire]}`, tiers: {}, benchmarkSort: false }, mode: 'detect', repair: { maxAttempts: 2, destructiveTools: [] }, log: { level: 'silent', file: null },
  }, { catalog: new ModelCatalog({ cachePath: null }) });
  process.send({ base: await listen(server) });
}
async function candidateStart(candidate, wire, upstream, dir) {
  if (candidate === 'relay') {
    const child = fork(self, ['--relay-child', wire], { execArgv: [], env: { ...cleanEnv(dir), BOUNDARY_UPSTREAM: upstream, BOUNDARY_KEY: KEY }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true });
    let ready; let error = ''; let spawnError;
    child.on('message', (message) => { ready = message; }); child.on('error', (err) => { spawnError = err; });
    child.stderr.on('data', (chunk) => { error = (error + chunk).slice(-8192); });
    const closed = new Promise((resolve) => child.once('close', resolve));
    try { await until(() => { if (spawnError || child.exitCode !== null || child.signalCode !== null) throw new Error(String(spawnError ?? error)); return ready !== undefined; }, 'relay startup'); }
    catch (error) { child.kill(); await closed; throw error; }
    return { base: ready.base, identity: { implementation: 'checked-out relay' }, close: async () => { child.kill(); await closed; } };
  }
  assert.equal(process.platform, 'linux', 'Docker comparison uses Linux host networking');
  const docker = async (...args) => (await exec('docker', args, { timeout: 240000, maxBuffer: 8 * 1024 * 1024 })).stdout.trim();
  await docker('pull', IMAGES[candidate]);
  const [image] = JSON.parse(await docker('image', 'inspect', IMAGES[candidate]));
  const reserve = createServer(); const base = await listen(reserve); await stop(reserve);
  const port = new URL(base).port; const name = `boundary-${randomUUID()}`;
  const auth = wire === 'messages' ? { 'x-api-key': KEY, 'anthropic-version': '2023-06-01' } : { authorization: `Bearer ${KEY}` };
  const config = candidate === 'litellm' ? {
    model_list: [{ model_name: 'fixture', litellm_params: { model: `${provider(wire)}/${MODELS[wire]}`, api_base: upstream + '/v1', api_key: KEY, max_retries: 0 } }],
    general_settings: { pass_through_endpoints: [{ path: '/native' + PATHS[wire], target: upstream + PATHS[wire], auth: false, forward_headers: false, methods: ['POST'], headers: { ...auth, 'content-type': 'application/json' } }] },
    litellm_settings: { telemetry: false, drop_params: false, num_retries: 0 }, router_settings: { num_retries: 0, fallbacks: [], disable_cooldowns: true },
  } : { providers: { [provider(wire)]: { keys: [{ name: 'fixture', value: KEY, models: ['*'], weight: 1 }], network_config: { base_url: upstream + '/v1', allow_private_network: true, max_retries: 0, default_request_timeout_in_seconds: 10 } } }, config_store: { enabled: false }, logs_store: { enabled: false } };
  writeFileSync(join(dir, 'config.json'), JSON.stringify(config)); chmodSync(dir, 0o777);
  try {
    await docker('run', '--detach', '--name', name, '--network', 'host', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--volume', `${dir}:${candidate === 'litellm' ? '/probe' : '/app/data'}`, '--env', 'DO_NOT_TRACK=1', '--env', 'APP_HOST=127.0.0.1', '--env', `APP_PORT=${port}`, image.Id, ...(candidate === 'litellm' ? ['--config', '/probe/config.json', '--host', '127.0.0.1', '--port', port, '--num_workers', '1'] : []));
    const deadline = Date.now() + 90000;
    for (;;) { if (Date.now() > deadline) throw new Error('Gateway startup timeout'); try { const res = await fetch(base + (candidate === 'litellm' ? '/health/liveliness' : '/health'), { signal: AbortSignal.timeout(1000) }); await res.body?.cancel(); if (res.ok) break; } catch {} await delay(100); }
    return { base, identity: { image: image.Id, digests: image.RepoDigests, bytes: image.Size }, close: async () => { await docker('rm', '--force', name); } };
  } catch (error) { const logs = await docker('logs', '--tail', '20', name).catch(() => 'No logs'); await docker('rm', '--force', name).catch(() => {}); throw new Error(`${error}\n${logs}`); }
}
async function probe(candidate) {
  assert(['relay', 'litellm', 'bifrost'].includes(candidate), 'Choose relay, litellm or bifrost');
  const report = { version: 1, candidate, node: process.version, platform: process.platform, results: [], identities: [], auxiliaryEgresses: 0, infrastructureErrors: [] };
  for (const wire of Object.keys(PATHS)) {
    const dir = mkdtempSync(join(tmpdir(), 'relay-boundary-')); const cases = new Map(); let gateway;
    const upstream = createServer(async (req, res) => {
      try {
        if (req.method !== 'POST') { res.writeHead(404); res.end(); return; }
        req.setEncoding('utf8'); let raw = ''; for await (const chunk of req) { raw += chunk; assert(Buffer.byteLength(raw) <= 262144); }
        const body = JSON.parse(raw); const token = JSON.stringify(body).match(/boundary-task-[0-9a-f-]{36}/)?.[0];
        const test = cases.get(token);
        if (token && !test) throw new Error('Unknown fixture task');
        if (test) { assert(test.calls.length < 100); const call = { path: req.url, headers: req.headers, body, closed: false }; test.calls.push(call); res.on('close', () => { call.closed = true; }); }
        else { report.auxiliaryEgresses++; assert(report.auxiliaryEgresses <= 1000); }
        if (req.url !== PATHS[wire]) { res.writeHead(404, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { type: 'invalid_request_error', message: `Fixture only supports ${PATHS[wire]}` } })); return; }
        if (test?.fail) { res.writeHead(503, { 'content-type': 'application/json' }); res.end(JSON.stringify(test.expected)); return; }
        if (!body.stream) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(test?.expected ?? reply(wire))); return; }
        const [first, last] = streamParts(wire); res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(first);
        if (test?.hold) test.release = () => { if (!res.destroyed) res.end(last); };
        else res.end(last);
      } catch (error) { report.infrastructureErrors.push(String(error)); if (!res.destroyed) res.destroy(); }
    });
    try {
      gateway = await candidateStart(candidate, wire, await listen(upstream), dir); report.identities.push({ wire, ...gateway.identity });
      const check = async (front, native, behavior) => {
        const token = `boundary-task-${randomUUID()}`;
        const test = { calls: [], hold: behavior === 'cancel', fail: behavior === 'error', expected: behavior === 'error' ? { error: { type: 'api_error', message: 'synthetic failure' }, vendor_extension: EXTENSION } : { ...reply(wire), ...(native ? { vendor_extension: EXTENSION } : {}) } };
        cases.set(token, test);
        const model = candidate === 'relay' ? `fixture/${MODELS[wire]}` : native ? MODELS[wire] : candidate === 'litellm' ? 'fixture' : `${provider(wire)}/${MODELS[wire]}`;
        const body = request(front, model, token, ['stream', 'cancel'].includes(behavior)); if (native) body.vendor_extension = EXTENSION;
        const prefix = candidate === 'relay' ? '' : native ? candidate === 'litellm' ? '/native' : `/${provider(wire)}_passthrough` : candidate === 'bifrost' && front === 'messages' ? '/anthropic' : '';
        const result = { wire, front, native, behavior, passed: false };
        const controller = new AbortController();
        try {
          const res = await fetch(gateway.base + prefix + PATHS[front], { method: 'POST', headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', authorization: 'Bearer synthetic-caller-key', 'x-api-key': 'synthetic-caller-key' }, body: JSON.stringify(body), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]) });
          result.status = res.status; assert.equal(res.status, test.fail ? 503 : 200);
          if (behavior === 'cancel') {
            const reader = res.body.getReader(); assert.equal((await reader.read()).done, false);
            assertWire(test.calls, PATHS[wire]); assert.equal(test.calls[0].closed, false); controller.abort();
            await until(() => test.calls[0].closed, 'upstream cancellation', 5000); await reader.cancel().catch(() => {});
          } else {
            const output = await text(res);
            if (native) {
              if (behavior === 'stream') assert.equal(output, streamParts(wire).join(''), 'Native SSE changed');
              else assertNative(JSON.parse(output), test.expected);
            } else assert(output.includes(TEXT), 'Translated answer missing');
          }
          assertWire(test.calls, PATHS[wire]); assertCredentials(test.calls[0].headers);
          if (native) assert.deepEqual(test.calls[0].body.vendor_extension, EXTENSION, 'Native request extension lost');
          result.passed = true;
        } catch (error) { result.error = String(error).slice(0, 1600); }
        finally { controller.abort(); test.release?.(); }
        report.results.push(result); test.result = result;
      };
      for (const front of Object.keys(PATHS)) for (const behavior of ['buffered', 'stream']) await check(front, false, behavior);
      for (const behavior of ['buffered', 'stream', 'cancel', 'error']) await check(wire, true, behavior);
      await gateway.close(); gateway = undefined;
      for (const test of cases.values()) {
        test.result.paths = test.calls.map((call) => call.path);
        try { assertWire(test.calls, PATHS[wire]); } catch (error) { test.result.passed = false; test.result.error ??= String(error); }
      }
    } finally { await gateway?.close(); await stop(upstream); rmSync(dir, { recursive: true, force: true }); }
  }
  report.allContractsPassed = report.results.every((r) => r.passed) && report.infrastructureErrors.length === 0;
  console.log(JSON.stringify(report)); if (report.infrastructureErrors.length > 0) process.exitCode = 1;
}
function selfTest() {
  let assertions = 0;
  for (const wire of Object.keys(PATHS)) {
    assertNative(reply(wire), reply(wire)); assertions++;
    assert.throws(() => assertNative({ ...reply(wire), usage: {} }, reply(wire))); assertions++;
    assert(streamParts(wire).join('').includes(TEXT)); assertions++;
    assertWire([{ path: PATHS[wire] }], PATHS[wire]); assertions++;
    assert.throws(() => assertWire([{ path: '/wrong' }], PATHS[wire])); assertions++;
    assert.throws(() => assertWire([{ path: PATHS[wire] }, { path: PATHS[wire] }], PATHS[wire])); assertions++;
  }
  assert.throws(() => assertCredentials({ authorization: 'Bearer synthetic-caller-key' })); assertions++;
  assertCredentials({ authorization: `Bearer ${KEY}` }); assertions++;
  console.log(JSON.stringify({ selfTest: true, assertions }));
}
if (process.argv[2] === '--self-test') selfTest();
else if (process.argv[2] === '--relay-child') await relayChild(process.argv[3]);
else await probe(process.argv[2]);
