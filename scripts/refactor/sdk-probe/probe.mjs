import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import Ajv from 'ajv';
import * as z from 'zod';

// A contract specimen, not the new dispatch API. One definition feeds both consumers.
const Input = z.strictObject({
  task: z.string().min(1).describe('Task text.'),
  execution: z.discriminatedUnion('mode', [
    z.strictObject({ mode: z.literal('answer'), maxTokens: z.number().int().min(1).max(4096) }),
    z.strictObject({ mode: z.literal('code'), cwd: z.string().min(1) }),
  ]),
});
const answer = { task: 'synthetic task', execution: { mode: 'answer', maxTokens: 32 } };
const code = { task: 'synthetic task', execution: { mode: 'code', cwd: '/fixture' } };

if (process.argv[2] === 'server') {
  const server = new McpServer({ name: 'refactor-probe', version: '1.0.0' });
  server.registerTool('echo', { inputSchema: Input }, async (args) => ({ content: [{ type: 'text', text: JSON.stringify(args) }] }));
  server.registerTool('wait', { inputSchema: z.strictObject({}) }, async (_args, ctx) => {
    const signal = ctx.mcpReq.signal;
    const token = ctx.mcpReq._meta?.progressToken;
    if (token !== undefined) await ctx.mcpReq.notify({ method: 'notifications/progress', params: { progressToken: token, progress: 1, total: 2 } });
    const cancelled = new Promise((resolve) => {
      if (signal.aborted) resolve();
      else signal.addEventListener('abort', resolve, { once: true });
    });
    process.send({ event: 'waiting' });
    await cancelled;
    process.send({ event: 'cancelled' });
    return { content: [{ type: 'text', text: 'wait ended' }] };
  });
  await server.connect(new StdioServerTransport());
} else {
  const schema = z.toJSONSchema(Input, { io: 'input', target: 'draft-07' });
  const ajv = new Ajv({ strict: true, allErrors: true, coerceTypes: false, useDefaults: false, removeAdditional: false });
  const validate = ajv.compile(schema);
  const fixtures = [
    [answer, true], [code, true], [{ ...answer, extra: true }, false],
    [{ ...answer, execution: { mode: 'answer', maxTokens: '32' } }, false],
    [{ ...answer, execution: { mode: 'answer', maxTokens: 0 } }, false],
    [{ ...answer, execution: { mode: 'code', cwd: '/fixture', maxTokens: 32 } }, false],
    [{ ...answer, execution: { mode: 'other' } }, false], [{ task: '' }, false], [null, false],
  ];
  for (const [fixture, expected] of fixtures) {
    const original = structuredClone(fixture);
    assert.equal(Input.safeParse(fixture).success, expected);
    assert.equal(validate(fixture), expected, JSON.stringify(validate.errors));
    assert.deepEqual(fixture, original, 'Validation cannot mutate input');
  }
  const Vendor = z.looseObject({ type: z.string() });
  const vendor = { type: 'opaque', unknown: { nested: ['preserve', 42] } };
  assert.deepEqual(Vendor.parse(vendor), vendor);
  assert.throws(() => z.toJSONSchema(z.string().transform((s) => s.length)), /represent|transform/i);

  const revisions = ['2025-03-26', '2025-06-18', '2025-11-25'];
  const results = [];
  for (const revision of revisions) {
    const child = fork(fileURLToPath(import.meta.url), ['server'], { execArgv: [], stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
    const closed = once(child, 'close');
    const output = [];
    const ipc = [];
    let stderr = '';
    let parseError;
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-8192); });
    const lines = createInterface({ input: child.stdout });
    lines.on('line', (line) => { try { output.push(JSON.parse(line)); } catch (error) { parseError = error; } });
    child.on('message', (message) => ipc.push(message));
    const wait = async (predicate) => {
      const deadline = Date.now() + 10000;
      while (!predicate()) {
        if (parseError) throw new Error(`Non-protocol stdout: ${parseError}`);
        if (child.exitCode !== null || child.signalCode !== null) throw new Error(`SDK exited: ${stderr}`);
        if (Date.now() > deadline) throw new Error(`SDK timeout (${revision}): ${stderr}`);
        await delay(5);
      }
    };
    let seq = 0;
    const send = (message) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\r\n');
    const request = async (method, params) => {
      const id = ++seq; send({ id, method, params });
      await wait(() => output.some((m) => m.id === id));
      return output.find((m) => m.id === id);
    };
    try {
      // Split one JSON-RPC line across writes, as real stdio pipes may do.
      const initialize = JSON.stringify({ jsonrpc: '2.0', id: ++seq, method: 'initialize', params: { protocolVersion: revision, capabilities: {}, clientInfo: { name: 'fixture', version: '1' } } }) + '\r\n';
      child.stdin.write(initialize.slice(0, 25));
      await delay(1); child.stdin.write(initialize.slice(25));
      await wait(() => output.some((m) => m.id === seq));
      assert.equal(output.find((m) => m.id === seq).result.protocolVersion, revision);
      send({ method: 'notifications/initialized' });
      const tools = await request('tools/list', {});
      assert.equal(tools.result.tools.find((t) => t.name === 'echo').inputSchema.properties.task.description, 'Task text.');
      const ok = await request('tools/call', { name: 'echo', arguments: answer });
      assert.deepEqual(JSON.parse(ok.result.content[0].text), answer);
      const invalid = await request('tools/call', { name: 'echo', arguments: { ...answer, unexpected: true } });
      assert(invalid.error || invalid.result?.isError, 'Unknown fields must not be silently stripped');
      const unknown = await request('not/a/method', {});
      assert.equal(unknown.error.code, -32601);
      const waitId = ++seq;
      send({ id: waitId, method: 'tools/call', params: { name: 'wait', arguments: {}, _meta: { progressToken: 'fixture-progress' } } });
      await wait(() => ipc.some((m) => m.event === 'waiting'));
      await wait(() => output.some((m) => m.method === 'notifications/progress'));
      assert.equal(output.find((m) => m.method === 'notifications/progress').params.progressToken, 'fixture-progress');
      send({ method: 'notifications/cancelled', params: { requestId: waitId, reason: 'fixture cancellation' } });
      await wait(() => ipc.some((m) => m.event === 'cancelled'));
      assert.deepEqual((await request('ping', {})).result, {});
      assert.equal(parseError, undefined);
      assert(output.every((m) => m.jsonrpc === '2.0'));
      results.push({ revision, initialization: true, schemas: true, progress: true, requestCancellation: true, stdoutPurity: true });
    } finally { child.kill(); await closed; lines.close(); }
  }
  const lock = JSON.parse(readFileSync(new URL('package-lock.json', import.meta.url), 'utf8'));
  const installed = Object.fromEntries(Object.entries(lock.packages).filter(([key]) => key).map(([key, value]) => [key, { version: value.version, integrity: value.integrity }]));
  console.log(JSON.stringify({ node: process.version, platform: process.platform, fixtures: fixtures.length, revisions: results, installed }));
}
