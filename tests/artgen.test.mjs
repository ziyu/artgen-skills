import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, stat, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { run, ArtgenError } from '../skills/artgen/scripts/artgen.mjs';

const API = 'https://api.example.test';
const KEY = 'test-api-key-must-not-leak';
const PROMPT = 'A small green house';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6L8sAAAAASUVORK5CYII=', 'base64');
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 2, 0xff, 0xd9]);
const WEBP = Buffer.from('524946460400000057454250', 'hex');
const MODEL = {
  id: 'test-model',
  name: 'Test Model',
  description: 'An isolated test model',
  creditCost: 5,
  supportsText: true,
  supportsTransfer: true,
  sizes: [{ value: '1024x1024', label: '1:1' }],
  maxPromptLength: 200,
};
const ENV = { ARTGEN_BASE_URL: API, ARTGEN_API_KEY: KEY };

function json(value, options) {
  return Response.json(value, options);
}

function generated(imageUrl = `data:image/png;base64,${PNG.toString('base64')}`, extra = {}) {
  return {
    success: true,
    requestId: 'request-test-123',
    data: { imageUrl, model: MODEL.name, modelId: MODEL.id },
    credits: { consumed: 5, remaining: 95 },
    ...extra,
  };
}

function network({ model = MODEL, catalog, post, download } = {}) {
  const calls = [];
  const fetchImpl = async (input, init = {}) => {
    const call = {
      url: String(input),
      method: init.method ?? 'GET',
      headers: new Headers(init.headers),
      redirect: init.redirect,
      body: init.body === undefined ? undefined : JSON.parse(init.body),
    };
    calls.push(call);
    if (new URL(call.url).pathname === '/api/models') {
      return catalog ? catalog(call) : json({ models: [model] });
    }
    if (new URL(call.url).pathname === '/api/create' || new URL(call.url).pathname === '/api/convert') {
      return post ? post(call) : json(generated());
    }
    if (download) return download(call);
    assert.fail(`Unexpected network request: ${call.method} ${call.url}`);
  };
  return { calls, fetchImpl };
}

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'artgen-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, output: join(dir, 'result.png'), source: join(dir, 'source.bin') };
}

function createArgs(output, more = []) {
  return ['create', '--model', MODEL.id, '--prompt', PROMPT, '--output', output, '--yes', ...more];
}

function convertArgs(output, source, more = []) {
  return ['convert', '--model', MODEL.id, '--prompt', PROMPT, '--input', source, '--output', output, '--yes', ...more];
}

async function rejected(action, { code, requestId, uncertain, secrets = [] } = {}) {
  let caught;
  await assert.rejects(action, error => {
    assert.ok(error instanceof ArtgenError, 'failures use the exported structured error class');
    assert.equal(typeof error.code, 'string');
    assert.ok(error.code.length > 0);
    if (code !== undefined) assert.equal(error.code, code);
    if (requestId !== undefined) assert.equal(error.details?.requestId, requestId);
    if (uncertain !== undefined) assert.equal(error.details?.generationMayHaveCompleted, uncertain);
    const visible = `${error.message}\n${JSON.stringify(error)}`;
    for (const secret of [KEY, ...secrets]) assert.ok(!visible.includes(secret), 'errors must redact private input and upstream details');
    caught = error;
    return true;
  });
  return caught;
}

async function absent(path) {
  await assert.rejects(stat(path), { code: 'ENOENT' });
}

function posts(calls) {
  return calls.filter(call => call.method === 'POST');
}

test('create saves the exact image bytes and reports public metadata and credits', async t => {
  const { output } = await fixture(t);
  const net = network();
  const result = await run(createArgs(output, ['--size', '1024x1024', '--style', 'watercolor']), { env: ENV, fetchImpl: net.fetchImpl });
  assert.deepEqual(await readFile(output), PNG);
  assert.deepEqual(result, {
    success: true,
    requestId: 'request-test-123',
    data: { path: output, model: MODEL.name, modelId: MODEL.id, mimeType: 'image/png', bytes: PNG.length },
    credits: { consumed: 5, remaining: 95 },
  });
  assert.equal(posts(net.calls).length, 1);
  const post = posts(net.calls)[0];
  assert.equal(post.url, `${API}/api/create`);
  assert.equal(post.headers.get('authorization'), `Bearer ${KEY}`);
  assert.equal(post.headers.get('content-type'), 'application/json');
  assert.equal(post.body.modelId, MODEL.id);
  assert.equal(post.body.prompt, PROMPT);
  assert.equal(post.body.size, '1024x1024');
  assert.equal(post.body.styleId, 'watercolor');
  assert.equal(net.calls[0].headers.get('authorization'), null);
  assert.ok(net.calls.every(call => call.redirect === 'manual'));
});

test('help is available without credentials or a network request', async () => {
  const net = network();
  const result = await run(['--help'], { env: {}, fetchImpl: net.fetchImpl });
  assert.equal(typeof result.usage, 'string');
  assert.ok(result.usage.includes('create'));
  assert.ok(result.usage.includes('convert'));
  assert.equal(net.calls.length, 0);
});

test('unknown, missing, duplicate and command-incompatible flags fail before network', async t => {
  const { output } = await fixture(t);
  const cases = [
    [],
    ['unknown-command'],
    ['models', '--unknown'],
    ['models', '--timeout'],
    ['models', '--timeout', '10', '--timeout', '20'],
    ['models', '--timeout', '0'],
    ['models', '--timeout', '601'],
    ['models', '--timeout', 'not-a-number'],
    ['models', '--model', MODEL.id],
    ['models', '--yes'],
    ['create', '--prompt', PROMPT, '--output', output, '--yes'],
    ['create', '--model', MODEL.id, '--output', output, '--yes'],
    ['create', '--model', MODEL.id, '--prompt', PROMPT, '--yes'],
    [...createArgs(output), '--prompt', 'duplicate'],
    [...createArgs(output), '--prompt-file', join(output, 'prompt.txt')],
    [...createArgs(output), '--input', join(output, 'image.png')],
    [...createArgs(output), '--provider', 'private-provider'],
    [...createArgs(output), '--yes'],
    ['convert', '--model', MODEL.id, '--prompt', PROMPT, '--output', output, '--yes'],
  ];
  for (const args of cases) {
    const net = network();
    await rejected(() => run(args, { env: ENV, fetchImpl: net.fetchImpl }), { code: 'invalid_arguments' });
    assert.equal(net.calls.length, 0, `invalid arguments must not make requests: ${JSON.stringify(args)}`);
  }
  await absent(output);
});

test('missing explicit billing consent does not fetch the catalog or reserve output', async t => {
  const { output } = await fixture(t);
  const net = network();
  await rejected(() => run(createArgs(output).filter(arg => arg !== '--yes'), { env: ENV, fetchImpl: net.fetchImpl }), { code: 'confirmation_required' });
  assert.equal(net.calls.length, 0);
  await absent(output);
});

test('models requires an explicit base URL but no key and strips non-public fields', async () => {
  const providerSecret = 'provider-credential-must-not-leak';
  const model = { ...MODEL, provider: 'private-provider', providerModel: 'internal-routing', apiKey: providerSecret, enabled: true };
  const net = network({ model });
  assert.deepEqual(await run(['models'], { env: { ARTGEN_BASE_URL: API }, fetchImpl: net.fetchImpl }), { models: [MODEL] });
  assert.equal(net.calls.length, 1);
  assert.equal(net.calls[0].url, `${API}/api/models`);
  assert.equal(net.calls[0].headers.get('authorization'), null);
  const missing = network();
  await rejected(() => run(['models'], { env: {}, fetchImpl: missing.fetchImpl }));
  assert.equal(missing.calls.length, 0);
});

test('catalog requests never disclose an available API key', async () => {
  const net = network();
  await run(['models'], { env: ENV, fetchImpl: net.fetchImpl });
  assert.equal(net.calls[0].headers.get('authorization'), null);
  assert.ok(!JSON.stringify(net.calls).includes(KEY));
});

test('generation requires a key without prompting or making requests', async t => {
  const { output } = await fixture(t);
  const net = network();
  await rejected(() => run(createArgs(output), { env: { ARTGEN_BASE_URL: API }, fetchImpl: net.fetchImpl }));
  assert.equal(net.calls.length, 0);
  await absent(output);
});

test('base URLs reject credentials, paths, queries, fragments and non-local HTTP', async () => {
  const invalid = [
    'https://user:password@api.example.test',
    `${API}/nested`,
    `${API}?token=base-url-secret`,
    `${API}#fragment`,
    'ftp://api.example.test',
    'http://api.example.test',
    'http://127.0.0.2:8080',
    'http://localhost.example.test:8080',
  ];
  for (const base of invalid) {
    const net = network();
    await rejected(() => run(['models', '--allow-local-http'], { env: { ARTGEN_BASE_URL: base }, fetchImpl: net.fetchImpl }), { secrets: ['base-url-secret', 'password'] });
    assert.equal(net.calls.length, 0);
  }
});

test('local HTTP is allowed only with the explicit opt-in on exact loopback hosts', async () => {
  for (const host of ['localhost', '127.0.0.1', '[::1]']) {
    const base = `http://${host}:49152`;
    const denied = network();
    await rejected(() => run(['models'], { env: { ARTGEN_BASE_URL: base }, fetchImpl: denied.fetchImpl }));
    assert.equal(denied.calls.length, 0);
    const allowed = network();
    assert.deepEqual(await run(['models', '--allow-local-http'], { env: { ARTGEN_BASE_URL: base }, fetchImpl: allowed.fetchImpl }), { models: [MODEL] });
    assert.equal(allowed.calls[0].url, `${base}/api/models`);
  }
});

test('live catalog capabilities, identity and sizes govern generation without fallback', async t => {
  const { output, source } = await fixture(t);
  await writeFile(source, PNG);
  const cases = [
    { model: { ...MODEL, supportsText: false }, args: createArgs(output) },
    { model: { ...MODEL, supportsTransfer: false }, args: convertArgs(output, source) },
    { model: { ...MODEL, id: 'different-model' }, args: createArgs(output) },
    { model: MODEL, args: createArgs(output, ['--size', '999x999']) },
  ];
  for (const { model, args } of cases) {
    const net = network({ model });
    await rejected(() => run(args, { env: ENV, fetchImpl: net.fetchImpl }));
    assert.equal(net.calls.length, 1);
    assert.equal(posts(net.calls).length, 0);
    await absent(output);
  }
});

test('prompt limit counts UTF-16 units and accepts the exact catalog boundary', async t => {
  const { output } = await fixture(t);
  const prompt = '\u{1F333}\u{1F333}';
  const args = ['create', '--model', MODEL.id, '--prompt', prompt, '--output', output, '--yes'];
  const short = network({ model: { ...MODEL, maxPromptLength: 3 } });
  await rejected(() => run(args, { env: ENV, fetchImpl: short.fetchImpl }));
  assert.equal(posts(short.calls).length, 0);
  await absent(output);
  const exact = network({ model: { ...MODEL, maxPromptLength: 4 } });
  await run(args, { env: ENV, fetchImpl: exact.fetchImpl });
  assert.equal(posts(exact.calls)[0].body.prompt, prompt);
  assert.deepEqual(await readFile(output), PNG);
});

test('prompt files provide their content and unreadable or blank prompts fail before network', async t => {
  const { dir, output } = await fixture(t);
  const promptFile = join(dir, 'prompt.txt');
  await writeFile(promptFile, PROMPT);
  const args = ['create', '--model', MODEL.id, '--prompt-file', promptFile, '--output', output, '--yes'];
  const net = network();
  await run(args, { env: ENV, fetchImpl: net.fetchImpl });
  assert.equal(posts(net.calls)[0].body.prompt, PROMPT);
  const missing = network();
  await rejected(() => run(['create', '--model', MODEL.id, '--prompt-file', join(dir, 'missing.txt'), '--output', join(dir, 'missing.png'), '--yes'], { env: ENV, fetchImpl: missing.fetchImpl }));
  assert.equal(missing.calls.length, 0);
  const blank = network();
  await rejected(() => run(['create', '--model', MODEL.id, '--prompt', '  \n\t', '--output', join(dir, 'blank.png'), '--yes'], { env: ENV, fetchImpl: blank.fetchImpl }));
  assert.equal(blank.calls.length, 0);
});

test('conversion detects PNG, JPEG and WebP by bytes, not the filename, and sends inline data', async t => {
  const { dir } = await fixture(t);
  for (const [mime, bytes] of [['image/png', PNG], ['image/jpeg', JPEG], ['image/webp', WEBP]]) {
    const suffix = mime.split('/')[1];
    const source = join(dir, `${suffix}.untrusted-extension`);
    const output = join(dir, `${suffix}-output.png`);
    await writeFile(source, bytes);
    const net = network();
    await run(convertArgs(output, source), { env: ENV, fetchImpl: net.fetchImpl });
    assert.equal(posts(net.calls).length, 1);
    assert.equal(posts(net.calls)[0].url, `${API}/api/convert`);
    assert.equal(posts(net.calls)[0].body.sourceImage, `data:${mime};base64,${bytes.toString('base64')}`);
    assert.deepEqual(await readFile(output), PNG);
  }
});

test('invalid, oversized, missing, directory and remote sources fail before any request', async t => {
  const { dir, output } = await fixture(t);
  const bad = join(dir, 'not-an-image.png');
  const oversized = join(dir, 'oversized.png');
  await writeFile(bad, '<svg>not a supported raster</svg>');
  const largeBytes = Buffer.alloc(5 * 1024 * 1024 + 1);
  PNG.copy(largeBytes);
  await writeFile(oversized, largeBytes);
  for (const source of [bad, oversized, dir, join(dir, 'missing.png'), 'https://images.example.test/source.png', `data:image/png;base64,${PNG.toString('base64')}`]) {
    const net = network();
    await rejected(() => run(convertArgs(output, source), { env: ENV, fetchImpl: net.fetchImpl }));
    assert.equal(net.calls.length, 0);
    await absent(output);
  }
});

test('a source at the five MiB limit is accepted without truncation', async t => {
  const { output, source } = await fixture(t);
  const bytes = Buffer.alloc(5 * 1024 * 1024);
  PNG.copy(bytes);
  await writeFile(source, bytes);
  const net = network();
  await run(convertArgs(output, source), { env: ENV, fetchImpl: net.fetchImpl });
  assert.equal(posts(net.calls)[0].body.sourceImage, `data:image/png;base64,${bytes.toString('base64')}`);
});

test('provider routing, secrets and extra catalog fields are never forwarded in generation JSON', async t => {
  const { output } = await fixture(t);
  const net = network({ model: { ...MODEL, provider: 'private-provider', providerModel: 'secret-route', apiKey: 'secret-provider-key', unexpected: { nested: true } } });
  await run(createArgs(output), { env: ENV, fetchImpl: net.fetchImpl });
  const body = posts(net.calls)[0].body;
  const allowed = new Set(['modelId', 'prompt', 'styleId', 'size', 'mode', 'sourceImage']);
  assert.ok(Object.keys(body).every(key => allowed.has(key)));
  assert.equal(body.modelId, MODEL.id);
  assert.equal(body.prompt, PROMPT);
  assert.ok(!JSON.stringify(body).includes('secret'));
  assert.ok(!Object.hasOwn(body, 'sourceImage'));
});

test('an existing output is never overwritten and prevents a billable POST', async t => {
  const { output } = await fixture(t);
  const original = Buffer.from('existing user artwork');
  await writeFile(output, original);
  const net = network();
  await rejected(() => run(createArgs(output), { env: ENV, fetchImpl: net.fetchImpl }));
  assert.equal(posts(net.calls).length, 0);
  assert.deepEqual(await readFile(output), original);
});

test('catalog redirects are not followed and never disclose credentials', async () => {
  const net = network({ catalog: () => new Response(null, { status: 302, headers: { location: 'https://other.example.test/catalog' } }) });
  await rejected(() => run(['models'], { env: ENV, fetchImpl: net.fetchImpl }));
  assert.equal(net.calls.length, 1);
  assert.equal(net.calls[0].redirect, 'manual');
  assert.equal(net.calls[0].headers.get('authorization'), null);
});

test('generation redirects are not followed or retried and release reserved output', async t => {
  const { output } = await fixture(t);
  const net = network({ post: () => new Response(null, { status: 307, headers: { location: 'https://other.example.test/create' } }) });
  await rejected(() => run(createArgs(output), { env: ENV, fetchImpl: net.fetchImpl }));
  assert.equal(posts(net.calls).length, 1);
  assert.equal(net.calls.length, 2);
  assert.equal(posts(net.calls)[0].redirect, 'manual');
  await absent(output);
});

test('HTTPS image downloads save exact bytes without authorization or cookies', async t => {
  const { output } = await fixture(t);
  const imageUrl = 'https://images.example.test/result.png?signature=download-secret';
  const net = network({ post: () => json(generated(imageUrl)), download: () => new Response(PNG, { headers: { 'content-type': 'image/png' } }) });
  const result = await run(createArgs(output), { env: ENV, fetchImpl: net.fetchImpl });
  assert.deepEqual(await readFile(output), PNG);
  assert.equal(result.data.bytes, PNG.length);
  const download = net.calls.at(-1);
  assert.equal(download.url, imageUrl);
  assert.equal(download.headers.get('authorization'), null);
  assert.equal(download.headers.get('cookie'), null);
  assert.equal(download.redirect, 'manual');
  assert.equal(posts(net.calls).length, 1);
  assert.ok(!JSON.stringify(result).includes('download-secret'));
});

test('image download redirects are not followed and cannot trigger regeneration', async t => {
  const { output } = await fixture(t);
  const net = network({
    post: () => json(generated('https://images.example.test/result.png')),
    download: () => new Response(null, { status: 302, headers: { location: 'https://other.example.test/result.png' } }),
  });
  await rejected(() => run(createArgs(output), { env: ENV, fetchImpl: net.fetchImpl }), { requestId: 'request-test-123', uncertain: true });
  assert.equal(net.calls.length, 3);
  assert.equal(posts(net.calls).length, 1);
  assert.equal(net.calls.at(-1).redirect, 'manual');
  await absent(output);
});

test('unsafe image URLs are rejected before download, even after a successful generation', async t => {
  const { dir } = await fixture(t);
  const urls = [
    'http://images.example.test/result.png',
    'https://user:password@images.example.test/result.png',
    'https://localhost/result.png',
    'https://127.0.0.1/result.png',
    'https://10.0.0.1/result.png',
    'https://172.16.1.1/result.png',
    'https://192.168.1.1/result.png',
    'https://169.254.169.254/result.png',
    'https://[::1]/result.png',
    'https://[fc00::1]/result.png',
  ];
  for (const [index, url] of urls.entries()) {
    const output = join(dir, `unsafe-${index}.png`);
    const net = network({ post: () => json(generated(url)) });
    await rejected(() => run(createArgs(output), { env: ENV, fetchImpl: net.fetchImpl }), { requestId: 'request-test-123', uncertain: true, secrets: ['password'] });
    assert.equal(net.calls.length, 2);
    assert.equal(posts(net.calls).length, 1);
    await absent(output);
  }
});

test('malformed, unsupported and MIME-mismatched image data cannot be saved as success', async t => {
  const { dir } = await fixture(t);
  const invalid = [
    `data:image/jpeg;base64,${PNG.toString('base64')}`,
    `data:image/svg+xml;base64,${Buffer.from('<svg/>').toString('base64')}`,
    'data:image/png;base64,%%%%',
    'data:image/png;base64,',
    'data:image/png,not-base64',
  ];
  for (const [index, imageUrl] of invalid.entries()) {
    const output = join(dir, `bad-data-${index}.png`);
    const net = network({ post: () => json(generated(imageUrl)) });
    await rejected(() => run(createArgs(output), { env: ENV, fetchImpl: net.fetchImpl }), { requestId: 'request-test-123', uncertain: true });
    assert.equal(posts(net.calls).length, 1);
    await absent(output);
  }
});

test('upstream known errors retain a request ID but redact text and never retry', async t => {
  const { output } = await fixture(t);
  const secret = 'upstream-private-details';
  const net = network({ post: () => json({ error: 'insufficient_credits', requestId: 'request-error-123', message: `${KEY} ${PROMPT} ${secret}`, required: 5, balance: 0 }, { status: 402 }) });
  const error = await rejected(() => run(createArgs(output), { env: ENV, fetchImpl: net.fetchImpl }), {
    code: 'insufficient_credits', requestId: 'request-error-123', secrets: [secret, PROMPT],
  });
  assert.equal(error.details.status, 402);
  assert.equal(posts(net.calls).length, 1);
  assert.equal(net.calls.length, 2);
  await absent(output);
});

test('unknown upstream errors and non-JSON error bodies cannot leak provider diagnostics', async t => {
  const { dir } = await fixture(t);
  const secret = 'provider-secret-diagnostic';
  const responses = [
    () => json({ error: `${secret} ${KEY}`, message: `${PROMPT} ${secret}` }, { status: 502, headers: { 'x-request-id': 'request-header-123' } }),
    () => new Response(`<html>${secret} ${KEY} ${PROMPT}</html>`, { status: 502, headers: { 'x-request-id': 'request-header-123', 'content-type': 'text/html' } }),
  ];
  for (const [index, response] of responses.entries()) {
    const output = join(dir, `upstream-${index}.png`);
    const net = network({ post: response });
    await rejected(() => run(createArgs(output), { env: ENV, fetchImpl: net.fetchImpl }), { requestId: 'request-header-123', secrets: [secret, PROMPT] });
    assert.equal(posts(net.calls).length, 1);
    await absent(output);
  }
});

test('a POST transport failure reports billing uncertainty without retries and cleans output', async t => {
  const { output } = await fixture(t);
  const secret = 'transport-secret-diagnostic';
  const net = network({ post: () => { throw new TypeError(`${secret} ${KEY} ${PROMPT}`); } });
  await rejected(() => run(createArgs(output), { env: ENV, fetchImpl: net.fetchImpl }), { uncertain: true, secrets: [secret, PROMPT] });
  assert.equal(posts(net.calls).length, 1);
  assert.equal(net.calls.length, 2);
  await absent(output);
});

test('malformed successful POST payloads retain request IDs and billing uncertainty', async t => {
  const { dir } = await fixture(t);
  const responses = [
    () => new Response('{not JSON', { status: 200, headers: { 'content-type': 'application/json', 'x-request-id': 'request-header-123' } }),
    () => json({ success: true, requestId: 'request-header-123', data: {}, credits: { consumed: 5, remaining: 95 } }),
  ];
  for (const [index, response] of responses.entries()) {
    const output = join(dir, `malformed-${index}.png`);
    const net = network({ post: response });
    await rejected(() => run(createArgs(output), { env: ENV, fetchImpl: net.fetchImpl }), { requestId: 'request-header-123', uncertain: true });
    assert.equal(posts(net.calls).length, 1);
    await absent(output);
  }
});

test('failed image retrieval retains the paid request ID, redacts signed URLs and cleans output', async t => {
  const { output } = await fixture(t);
  const secret = 'signed-download-query-secret';
  const net = network({
    post: () => json(generated(`https://images.example.test/result.png?token=${secret}`)),
    download: () => { throw new Error(`fetch failed https://images.example.test/result.png?token=${secret} ${KEY}`); },
  });
  await rejected(() => run(createArgs(output), { env: ENV, fetchImpl: net.fetchImpl }), { requestId: 'request-test-123', uncertain: true, secrets: [secret] });
  assert.equal(posts(net.calls).length, 1);
  assert.equal(net.calls.length, 3);
  await absent(output);
});

test('HTTPS origins preserve a non-default port and normalize only the root slash', async () => {
  const net = network();
  await run(['models'], { env: { ARTGEN_BASE_URL: 'https://api.example.test:8443/' }, fetchImpl: net.fetchImpl });
  assert.equal(net.calls[0].url, 'https://api.example.test:8443/api/models');
});

test('oversized declared catalog responses fail before body parsing or generation', async t => {
  const { output } = await fixture(t);
  const net = network({ catalog: () => new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': String(40 * 1024 * 1024) } }) });
  await rejected(() => run(createArgs(output), { env: ENV, fetchImpl: net.fetchImpl }));
  assert.equal(net.calls.length, 1);
  assert.equal(posts(net.calls).length, 0);
  await absent(output);
});

test('oversized streamed downloads stop reading, preserve billing uncertainty and clean output', async t => {
  const { output } = await fixture(t);
  let pulls = 0;
  let cancelled = false;
  const chunk = Buffer.alloc(1024 * 1024);
  PNG.copy(chunk);
  const net = network({
    post: () => json(generated('https://images.example.test/oversized.png')),
    download: () => new Response(new ReadableStream({
      pull(controller) {
        pulls += 1;
        controller.enqueue(chunk);
        if (pulls === 40) controller.close();
      },
      cancel() { cancelled = true; },
    }), { headers: { 'content-type': 'image/png' } }),
  });
  await rejected(() => run(createArgs(output), { env: ENV, fetchImpl: net.fetchImpl }), { requestId: 'request-test-123', uncertain: true });
  assert.ok(pulls < 40, 'the complete oversized response must not be buffered');
  assert.equal(cancelled, true);
  assert.equal(posts(net.calls).length, 1);
  await absent(output);
});

test('the installed CLI prints JSON when invoked through a linked directory', async t => {
  const { dir } = await fixture(t);
  const linked = join(dir, 'installed');
  const source = fileURLToPath(new URL('../skills/artgen/scripts', import.meta.url));
  await symlink(source, linked, process.platform === 'win32' ? 'junction' : 'dir');
  const result = spawnSync(process.execPath, [join(linked, 'artgen.mjs'), '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(JSON.parse(result.stdout).usage, /ARTGEN_BASE_URL/);
});
