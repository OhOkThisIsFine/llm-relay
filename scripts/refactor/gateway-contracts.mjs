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

// A bounded compatibility screen, not a replacement request service or performance benchmark.
const FRONT_PATH = { messages: '/v1/messages', chat: '/v1/chat/completions', responses: '/v1/responses' };
const MODEL = { openai: 'gpt-4o-mini', anthropic: 'claude-3-5-sonnet-20241022' };
const IMAGE = { litellm: 'ghcr.io/berriai/litellm:v1.101.0', bifrost: 'maximhq/bifrost:v2.2.1' };
const PREVIOUS = 'call_fixture_previous';
const NEXT = 'call_fixture_next';
const ARGS = { value: 'synthetic-π-🧪' };
const OPAQUE = { nested: [null, { fixture: 'preserve-π' }] };
const TOOL = 'echo_value';
const PARAMETERS = { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false };
const KEY = 'fixture-provider-key';
const runFile = promisify(execFile);
const self = fileURLToPath(import.meta.url);
const timeout = (ms = 10_000) => AbortSignal.timeout(ms);

function requestBody(front, model, stream = false, history = true) {
  const common = { model, stream };
  if (front === 'messages') return { ...common, max_tokens: 128, tools: [{ name: TOOL, input_schema: PARAMETERS }], messages: [
    { role: 'user', content: 'Read the synthetic value.' },
    ...(history ? [{ role: 'assistant', content: [{ type: 'tool_use', id: PREVIOUS, name: TOOL, input: ARGS }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: PREVIOUS, content: 'previous-result' }] }] : []),
  ] };
  if (front === 'chat') return { ...common, max_tokens: 128, tools: [{ type: 'function', function: { name: TOOL, parameters: PARAMETERS } }], messages: [
    { role: 'user', content: 'Read the synthetic value.' },
    ...(history ? [{ role: 'assistant', content: null, tool_calls: [{ type: 'function', id: PREVIOUS, function: { name: TOOL, arguments: JSON.stringify(ARGS) } }] },
      { role: 'tool', tool_call_id: PREVIOUS, content: 'previous-result' }] : []),
  ] };
  return { ...common, max_output_tokens: 128, tools: [{ type: 'function', name: TOOL, parameters: PARAMETERS }], input: [
    { role: 'user', content: 'Read the synthetic value.' },
    ...(history ? [{ type: 'function_call', call_id: PREVIOUS, name: TOOL, arguments: JSON.stringify(ARGS) },
      { type: 'function_call_output', call_id: PREVIOUS, output: 'previous-result' }] : []),
  ] };
}

function responseBody(protocol, text = false) {
  if (protocol === 'messages') return { id: 'msg_fixture', type: 'message', role: 'assistant', model: MODEL.anthropic,
    content: text ? [{ type: 'text', text: 'fixture-prefix' }] : [{ type: 'tool_use', id: NEXT, name: TOOL, input: ARGS }],
    stop_reason: text ? 'end_turn' : 'tool_use', stop_sequence: null,
    usage: { input_tokens: 13, output_tokens: 3, cache_creation_input_tokens: 7, cache_read_input_tokens: 11 } };
  if (protocol === 'chat') return { id: 'chatcmpl_fixture', object: 'chat.completion', created: 1, model: MODEL.openai,
    choices: [{ index: 0, message: text ? { role: 'assistant', content: 'fixture-prefix' } : { role: 'assistant', content: null,
      tool_calls: [{ id: NEXT, type: 'function', function: { name: TOOL, arguments: JSON.stringify(ARGS) } }] }, finish_reason: text ? 'stop' : 'tool_calls' }],
    usage: { prompt_tokens: 31, completion_tokens: 3, total_tokens: 34, prompt_tokens_details: { cached_tokens: 11 } } };
  return { id: 'resp_fixture', object: 'response', created_at: 1, model: MODEL.openai, status: 'completed', error: null, incomplete_details: null,
    output: text ? [{ type: 'message', id: 'msg_fixture', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: 'fixture-prefix', annotations: [] }] }]
      : [{ type: 'function_call', id: 'fc_fixture', status: 'completed', call_id: NEXT, name: TOOL, arguments: JSON.stringify(ARGS) }],
    usage: { input_tokens: 31, output_tokens: 3, total_tokens: 34, input_tokens_details: { cached_tokens: 11 }, output_tokens_details: { reasoning_tokens: 0 } } };
}

function frames(protocol, text = false) {
  const result = responseBody(protocol, text);
  const json = JSON.stringify(ARGS);
  const fragments = [json.slice(0, 13), json.slice(13)];
  if (protocol === 'chat') {
    const chunk = (delta, finish_reason = null, usage) => ({ id: result.id, object: 'chat.completion.chunk', created: 1, model: result.model,
      choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}) });
    return [chunk({ role: 'assistant', content: '' }), ...(text ? [chunk({ content: 'fixture-prefix' })] : [
      chunk({ tool_calls: [{ index: 0, id: NEXT, type: 'function', function: { name: TOOL, arguments: fragments[0] } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: fragments[1] } }] }),
    ]), chunk({}, text ? 'stop' : 'tool_calls', result.usage), '[DONE]'];
  }
  if (protocol === 'messages') return [
    { type: 'message_start', message: { ...result, content: [], stop_reason: null, usage: { ...result.usage, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: text ? { type: 'text', text: '' } : { type: 'tool_use', id: NEXT, name: TOOL, input: {} } },
    ...(text ? [{ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'fixture-prefix' } }]
      : fragments.map((partial_json) => ({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json } }))),
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: result.stop_reason, stop_sequence: null }, usage: { output_tokens: 3 } },
    { type: 'message_stop' },
  ];
  const item = result.output[0];
  return [
    { type: 'response.created', response: { ...result, status: 'in_progress', output: [], usage: null } },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', ...(text ? { content: [] } : { arguments: '' }) } },
    ...(text ? [
      { type: 'response.content_part.added', item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
      { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: 'fixture-prefix' },
      { type: 'response.output_text.done', item_id: item.id, output_index: 0, content_index: 0, text: 'fixture-prefix' },
      { type: 'response.content_part.done', item_id: item.id, output_index: 0, content_index: 0, part: item.content[0] },
    ] : [
      ...fragments.map((delta) => ({ type: 'response.function_call_arguments.delta', item_id: item.id, output_index: 0, delta })),
      { type: 'response.function_call_arguments.done', item_id: item.id, output_index: 0, arguments: json },
    ]),
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: result },
  ].map((event, sequence_number) => ({ ...event, sequence_number }));
}

function wire(protocol, events) {
  return events.map((event) => `${protocol !== 'chat' ? `event: ${event.type}\n` : ''}data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`).join('');
}
function parseSse(body) {
  return body.split(/\r?\n\r?\n/).flatMap((frame) => {
    const data = frame.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
    return data ? [data === '[DONE]' ? data : JSON.parse(data)] : [];
  });
}
function toolsFromBody(front, body) {
  if (front === 'messages') return (body.content ?? []).filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, name: b.name, args: b.input }));
  if (front === 'chat') return (body.choices?.[0]?.message?.tool_calls ?? []).map((b) => ({ id: b.id, name: b.function.name, args: JSON.parse(b.function.arguments) }));
  return (body.output ?? []).filter((b) => b.type === 'function_call').map((b) => ({ id: b.call_id, name: b.name, args: JSON.parse(b.arguments) }));
}
function toolsFromStream(front, events) {
  const calls = new Map();
  for (const event of events) {
    if (typeof event === 'string') continue;
    if (front === 'chat') for (const c of event.choices?.[0]?.delta?.tool_calls ?? []) {
      const call = calls.get(c.index) ?? { id: '', name: '', json: '' };
      if (c.id) call.id = c.id;
      if (c.function?.name) call.name += c.function.name;
      call.json += c.function?.arguments ?? ''; calls.set(c.index, call);
    }
    if (front === 'messages') {
      if (event.type === 'content_block_start' && event.content_block.type === 'tool_use') calls.set(event.index, { id: event.content_block.id, name: event.content_block.name, json: '' });
      if (event.type === 'content_block_delta' && event.delta.type === 'input_json_delta') {
        assert(calls.has(event.index), 'Arguments arrived before tool identity'); calls.get(event.index).json += event.delta.partial_json;
      }
    }
    if (front === 'responses') {
      if (event.type === 'response.output_item.added' && event.item.type === 'function_call') calls.set(event.output_index, { id: event.item.call_id, name: event.item.name, json: '' });
      if (event.type === 'response.function_call_arguments.delta') {
        assert(calls.has(event.output_index), 'Arguments arrived before tool identity'); calls.get(event.output_index).json += event.delta;
      }
    }
  }
  return [...calls.values()].map(({ id, name, json }) => ({ id, name, args: JSON.parse(json) }));
}
function assertTools(calls) { assert.deepEqual(calls, [{ id: NEXT, name: TOOL, args: ARGS }]); }
function assertHistory(protocol, body) {
  if (protocol === 'responses') {
    const call = body.input?.find((item) => item.type === 'function_call');
    const output = body.input?.find((item) => item.type === 'function_call_output');
    assert.equal(call?.call_id, PREVIOUS); assert.equal(call.name, TOOL); assert.deepEqual(JSON.parse(call.arguments), ARGS);
    assert.equal(output?.call_id, PREVIOUS); assert.equal(output.output, 'previous-result');
  } else if (protocol === 'chat') {
    const call = body.messages?.flatMap((m) => m.tool_calls ?? [])[0];
    const output = body.messages?.find((m) => m.role === 'tool');
    assert.equal(call?.id, PREVIOUS); assert.equal(call.function.name, TOOL); assert.deepEqual(JSON.parse(call.function.arguments), ARGS);
    assert.equal(output?.tool_call_id, PREVIOUS); assert.equal(output.content, 'previous-result');
  } else {
    const blocks = body.messages?.flatMap((m) => Array.isArray(m.content) ? m.content : []) ?? [];
    const call = blocks.find((b) => b.type === 'tool_use'); const output = blocks.find((b) => b.type === 'tool_result');
    assert.equal(call?.id, PREVIOUS); assert.equal(call.name, TOOL); assert.deepEqual(call.input, ARGS);
    assert.equal(output?.tool_use_id, PREVIOUS);
    assert.equal(typeof output.content === 'string' ? output.content : output.content?.map((b) => b.text ?? '').join(''), 'previous-result');
  }
}

async function boundedText(response) {
  let bytes = 0; const parts = [];
  for await (const part of response.body) { bytes += part.byteLength; assert(bytes <= 262_144, 'Fixture response exceeded 256 KiB'); parts.push(part); }
  return Buffer.concat(parts).toString('utf8');
}
async function listen(server) {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}
async function stopServer(server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
async function waitUntil(predicate, label, ms = 10_000) {
  const deadline = Date.now() + ms;
  while (!predicate()) { if (Date.now() >= deadline) throw new Error(`Timed out: ${label}`); await delay(5); }
}
function cleanEnv(home) {
  const env = Object.fromEntries(['PATH', 'Path', 'SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP', 'TMPDIR'].filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]]));
  return { ...env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: home, XDG_CACHE_HOME: home, XDG_STATE_HOME: home };
}

async function startCandidate(candidate, upstream, dir) {
  if (candidate === 'relay') {
    const child = fork(self, ['--relay-child'], { execArgv: [], env: { ...cleanEnv(dir), GATEWAY_PROBE_UPSTREAM: upstream, GATEWAY_PROBE_KEY: KEY }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
    let error = ''; let ready; child.stdout.resume(); child.stderr.on('data', (chunk) => { error = (error + chunk).slice(-8192); });
    const closed = once(child, 'close'); child.on('message', (message) => { ready = message; });
    try {
      await waitUntil(() => { if (child.exitCode !== null || child.signalCode !== null) throw new Error(error); return ready !== undefined; }, 'relay startup');
      return { base: ready.base, identity: ready.identity, stop: async () => { child.kill(); await closed; } };
    } catch (error) { child.kill(); await closed; throw error; }
  }
  assert(process.platform === 'linux', 'Container comparison uses Linux host networking; this is not a Windows install claim');
  const reserved = createServer(); const base = await listen(reserved); await stopServer(reserved);
  const port = new URL(base).port;
  const name = `relay-gateway-probe-${randomUUID()}`;
  const docker = async (...args) => (await runFile('docker', args, { timeout: 240_000, maxBuffer: 8 * 1024 * 1024 })).stdout.trim();
  await docker('pull', IMAGE[candidate]);
  const [image] = JSON.parse(await docker('image', 'inspect', IMAGE[candidate]));
  const identity = { tag: IMAGE[candidate], imageId: image.Id, repoDigests: image.RepoDigests, imageBytes: image.Size };
  let args;
  if (candidate === 'litellm') {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({
      model_list: Object.keys(MODEL).map((provider) => ({ model_name: provider, litellm_params: { model: `${provider}/${MODEL[provider]}`, api_base: upstream + '/v1', api_key: KEY, max_retries: 0 } })),
      litellm_settings: { telemetry: false, drop_params: false, num_retries: 0, set_verbose: false },
      router_settings: { num_retries: 0, fallbacks: [], allowed_fails: 1000, disable_cooldowns: true },
    }));
    args = ['--config', '/probe/config.json', '--host', '127.0.0.1', '--port', port, '--num_workers', '1'];
  } else {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({
      providers: Object.fromEntries(Object.keys(MODEL).map((provider) => [provider, {
        keys: [{ name: `${provider}-fixture`, value: KEY, models: ['*'], weight: 1 }],
        network_config: { base_url: upstream + '/v1', allow_private_network: true, max_retries: 0, default_request_timeout_in_seconds: 10 },
      }])), config_store: { enabled: false }, logs_store: { enabled: false },
    }));
    args = [];
  }
  try {
    await docker('run', '--detach', '--name', name, '--network', 'host', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      '--volume', `${dir}:${candidate === 'litellm' ? '/probe' : '/app/data'}`,
      '--env', 'DO_NOT_TRACK=1', '--env', `APP_HOST=127.0.0.1`, '--env', `APP_PORT=${port}`,
      image.Id, ...args);
    // Readiness is followed by a real fixture request that verifies the expected upstream, not just a listener.
    const deadline = Date.now() + 90_000;
    for (;;) {
      if (Date.now() > deadline) throw new Error('Gateway startup timed out');
      try { const response = await fetch(base + (candidate === 'litellm' ? '/health/liveliness' : '/health'), { signal: timeout(1000) }); await response.body?.cancel(); if (response.ok) break; }
      catch { await delay(100); }
    }
    return { base, identity, stop: async () => { await docker('rm', '--force', name).catch(() => {}); } };
  } catch (error) {
    const logs = await docker('logs', '--tail', '30', name).catch(() => 'Container log unavailable');
    await docker('rm', '--force', name).catch(() => {});
    throw new Error(`${error}\n${logs}`);
  }
}

async function relayChild() {
  const { createProxy } = await import('../../dist/server.js');
  const { ModelCatalog } = await import('../../dist/catalog.js');
  const providers = Object.fromEntries(Object.keys(MODEL).map((provider) => [provider, { base: process.env.GATEWAY_PROBE_UPSTREAM, kind: provider === 'openai' ? 'openai' : 'anthropic',
    authEnv: 'GATEWAY_PROBE_KEY', authHeader: provider === 'openai' ? 'authorization' : 'x-api-key', credentialMode: 'contained', timeoutMs: 10_000 }]));
  const server = createProxy({ host: '127.0.0.1', port: 0, providers,
    routing: { default: `openai/${MODEL.openai}`, tiers: {}, benchmarkSort: false },
    mode: 'detect', repair: { maxAttempts: 2, destructiveTools: [] }, log: { level: 'silent', file: null },
  }, { catalog: new ModelCatalog({ cachePath: null }) });
  const lock = JSON.parse(readFileSync(new URL('../../package-lock.json', import.meta.url), 'utf8'));
  process.send({ base: await listen(server), identity: { packageVersion: lock.version, bridge: lock.packages['node_modules/llm-bridge'] } });
}

async function probe(candidate) {
  assert(['relay', 'litellm', 'bifrost'].includes(candidate), 'Choose relay, litellm, or bifrost');
  const dir = mkdtempSync(join(tmpdir(), 'relay-gateway-contracts-'));
  if (candidate !== 'relay') chmodSync(dir, 0o777); // Container writes only disposable synthetic configuration here.
  let active; let gateway;
  const upstream = createServer(async (req, res) => {
    const test = active;
    if (!test || req.method !== 'POST') { res.writeHead(404); res.end(); return; }
    try {
      let raw = ''; for await (const chunk of req) { raw += chunk; assert(raw.length <= 262_144); }
      const body = JSON.parse(raw);
      assert(/\/(messages|responses|chat\/completions)(?:\?|$)/.test(req.url), `Unexpected synthetic endpoint: ${req.url}`);
      const protocol = req.url.includes('/messages') ? 'messages' : req.url.includes('/responses') ? 'responses' : 'chat';
      const call = { protocol, body, headers: req.headers, closed: false };
      test.calls.push(call); res.on('close', () => { call.closed = true; });
      if (test.error) { res.writeHead(503, { 'content-type': 'application/json' }); res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'synthetic upstream failure' } })); return; }
      if (!body.stream) {
        const reply = responseBody(protocol); if (test.opaque) reply.vendor_extension = OPAQUE;
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(reply)); return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const events = frames(protocol, !!test.hold);
      if (test.hold) {
        const cut = protocol === 'messages' ? 3 : protocol === 'chat' ? 2 : 4;
        res.write(wire(protocol, events.slice(0, cut)));
        test.release = () => { if (!res.destroyed) res.end(wire(protocol, events.slice(cut))); };
      } else {
        // Deliberately fragment a UTF-8 sequence and a JSON/SSE frame at the transport boundary.
        const bytes = Buffer.from(wire(protocol, events)); const offset = bytes.indexOf(Buffer.from('π')) + 1;
        assert(offset > 0); res.write(bytes.subarray(0, offset)); await delay(1); res.end(bytes.subarray(offset));
      }
    } catch (error) { test.infrastructureError = String(error); if (!res.destroyed) res.destroy(); }
  });
  const report = { version: 1, candidate, node: process.version, platform: process.platform, scope: 'synthetic fidelity screen; not full R1 acceptance', identity: null, results: [] };
  try {
    const upstreamBase = await listen(upstream);
    gateway = await startCandidate(candidate, upstreamBase, dir); report.identity = gateway.identity;
    const model = (provider) => candidate === 'litellm' ? provider : `${provider}/${MODEL[provider]}`;
    const endpoint = (front) => gateway.base + (candidate === 'bifrost' && front === 'messages' ? '/anthropic' : '') + FRONT_PATH[front];
    const post = (front, body, signal = timeout()) => fetch(endpoint(front), { method: 'POST', headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', authorization: 'Bearer fixture-caller-key', 'x-api-key': 'fixture-caller-key' }, body: JSON.stringify(body), signal });
    const textRequest = (front, provider) => {
      const body = requestBody(front, model(provider), true, false); delete body.tools; return body;
    };
    const check = async (name, test, action) => {
      active = { calls: [], ...test };
      try { await action(active); assert.equal(active.infrastructureError, undefined); report.results.push({ name, passed: true, egresses: active.calls.length }); }
      catch (error) { report.results.push({ name, passed: false, egresses: active.calls.length, error: String(error).slice(0, 1600), infrastructureError: active.infrastructureError }); }
      finally { active.release?.(); active = undefined; }
    };
    for (const provider of Object.keys(MODEL)) for (const front of Object.keys(FRONT_PATH)) {
      for (const stream of [false, true]) await check(`${front} -> ${provider}: ${stream ? 'streamed' : 'buffered'} tool cycle`, {}, async (test) => {
        const response = await post(front, requestBody(front, model(provider), stream)); const text = await boundedText(response);
        assert.equal(response.status, 200, text.slice(0, 1000)); assert.equal(test.calls.length, 1);
        const call = test.calls[0]; assertHistory(call.protocol, call.body);
        assert(!JSON.stringify(call.headers).includes('fixture-caller-key'), 'Caller credential leaked');
        assert(JSON.stringify(call.headers).includes(KEY), 'Configured credential was not used');
        assertTools(stream ? toolsFromStream(front, parseSse(text)) : toolsFromBody(front, JSON.parse(text)));
        if (stream) {
          const events = parseSse(text);
          const terminal = front === 'chat' ? events.filter((e) => e === '[DONE]') : events.filter((e) => e.type === (front === 'messages' ? 'message_stop' : 'response.completed'));
          assert.equal(terminal.length, 1, 'Exactly one terminal event is required');
        }
      });
      await check(`${front} -> ${provider}: incremental delivery before EOF`, { hold: true }, async (test) => {
        const controller = new AbortController(); const signal = AbortSignal.any([controller.signal, timeout()]);
        try {
          const response = await post(front, textRequest(front, provider), signal); assert.equal(response.status, 200);
          const reader = response.body.getReader(); let received = '';
          while (!received.includes('fixture-prefix')) { const chunk = await reader.read(); assert(!chunk.done, 'EOF before content'); received += Buffer.from(chunk.value).toString('utf8'); assert(received.length < 262_144); }
          assert.equal(test.calls.length, 1); assert(test.release, 'Upstream must still be held');
          test.release(); while (!(await reader.read()).done) { /* drain the bounded fixture */ }
        } finally { controller.abort(); }
      });
      await check(`${front} -> ${provider}: caller cancellation reaches upstream`, { hold: true }, async (test) => {
        const controller = new AbortController();
        try {
          const response = await post(front, textRequest(front, provider), AbortSignal.any([controller.signal, timeout()]));
          assert.equal(response.status, 200); const reader = response.body.getReader(); assert.equal((await reader.read()).done, false);
          assert.equal(test.calls.length, 1); assert.equal(test.calls[0].closed, false); controller.abort();
          await waitUntil(() => test.calls[0].closed, 'upstream close after caller abort', 5000); await reader.cancel().catch(() => {});
        } finally { controller.abort(); }
      });
    }
    for (const [front, provider] of [['messages', 'anthropic'], ['chat', 'openai']]) {
      await check(`${front}: native opaque fields and cache usage`, { opaque: true }, async (test) => {
        const body = requestBody(front, model(provider)); body.vendor_extension = OPAQUE;
        const response = await post(front, body); const text = await boundedText(response); assert.equal(response.status, 200, text.slice(0, 1000));
        const reply = JSON.parse(text); assert.equal(test.calls.length, 1); assert.equal(test.calls[0].protocol, front);
        assert.deepEqual(test.calls[0].body.vendor_extension, OPAQUE); assert.deepEqual(reply.vendor_extension, OPAQUE);
        const original = responseBody(front); assert.equal(reply.id, original.id); assert.deepEqual(reply.usage, original.usage); assertTools(toolsFromBody(front, reply));
      });
    }
    // No multi-candidate failover claim: this checks whether an adapter can leave retries to its caller.
    for (const front of Object.keys(FRONT_PATH)) await check(`${front}: zero configured gateway retries`, { error: true }, async (test) => {
      const response = await post(front, requestBody(front, model('openai'), false, false)); await boundedText(response);
      assert(response.status >= 500); assert.equal(test.calls.length, 1, 'Gateway performed an unrequested retry');
    });
    report.allContractsPassed = report.results.every((r) => r.passed);
    console.log(JSON.stringify(report));
    if (report.results.some((r) => r.infrastructureError)) process.exitCode = 1;
  } finally { await gateway?.stop(); await stopServer(upstream); rmSync(dir, { recursive: true, force: true }); }
}

function selfTest() {
  let assertions = 0;
  for (const protocol of Object.keys(FRONT_PATH)) {
    assertHistory(protocol, requestBody(protocol, 'fixture')); assertions++;
    assertTools(toolsFromBody(protocol, responseBody(protocol))); assertions++;
    const events = parseSse(wire(protocol, frames(protocol)));
    assertTools(toolsFromStream(protocol, events)); assertions++;
    const wrong = toolsFromBody(protocol, responseBody(protocol)); wrong[0].id = 'wrong'; assert.throws(() => assertTools(wrong)); assertions++;
    const dropped = requestBody(protocol, 'fixture'); if (protocol === 'responses') dropped.input.pop(); else dropped.messages.pop();
    assert.throws(() => assertHistory(protocol, dropped)); assertions++;
    const droppedDeltas = events.filter((e) => typeof e === 'string' || (protocol === 'chat' ? !e.choices?.[0]?.delta?.tool_calls : protocol === 'messages' ? e.type !== 'content_block_delta' : e.type !== 'response.function_call_arguments.delta'));
    assert.throws(() => assertTools(toolsFromStream(protocol, droppedDeltas))); assertions++;
  }
  assert.throws(() => parseSse('data: {broken}\n\n')); assertions++;
  assert.deepEqual(parseSse(':keepalive\n\ndata: [DONE]\r\n\r\n'), ['[DONE]']); assertions++;
  console.log(JSON.stringify({ selfTest: true, assertions }));
}

if (process.argv[2] === '--relay-child') await relayChild();
else if (process.argv[2] === '--self-test') selfTest();
else await probe(process.argv[2]);
