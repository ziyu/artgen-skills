#!/usr/bin/env node
import { open, stat, unlink, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isIP } from 'node:net';

const MAX_SOURCE = 5 * 1024 * 1024;
const MAX_IMAGE = 24 * 1024 * 1024;
const MAX_JSON = 34 * 1024 * 1024;
const USAGE = `Artgen (Node.js >=22.20)
  node artgen.mjs models [--timeout 120] [--allow-local-http]
  node artgen.mjs create --model ID (--prompt TEXT | --prompt-file FILE) --output FILE --yes
  node artgen.mjs convert --model ID (--prompt TEXT | --prompt-file FILE) --input FILE --output FILE --yes
Optional generation flags: --size VALUE --style ID --timeout SECONDS --allow-local-http
Environment: ARTGEN_BASE_URL (HTTPS origin), ARTGEN_API_KEY (generation only).
--yes confirms permission to spend account credits. No automatic retries. Output files are never overwritten.
HTTP requires --allow-local-http and a literal loopback host. Timeouts: 1–600 seconds.`;

export class ArtgenError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ArtgenError';
    this.code = code;
    this.details = details;
  }
}

function parseArgs(argv) {
  if (argv.length === 1 && argv[0] === '--help') return { command: 'help' };
  const [command, ...rest] = argv;
  if (!['models', 'create', 'convert'].includes(command)) throw new ArtgenError('invalid_arguments', USAGE);
  const options = {};
  const flags = new Set(command === 'models' ? ['timeout', 'allow-local-http'] : ['model', 'prompt', 'prompt-file', 'size', 'style', 'input', 'output', 'timeout', 'allow-local-http', 'yes']);
  for (let i = 0; i < rest.length; i++) {
    const name = rest[i].startsWith('--') ? rest[i].slice(2) : '';
    if (!flags.has(name) || Object.hasOwn(options, name)) throw new ArtgenError('invalid_arguments', 'Unknown, repeated, or positional argument. Run --help.');
    if (name === 'yes' || name === 'allow-local-http') options[name] = true;
    else {
      const value = rest[++i];
      if (!value || value.startsWith('--')) throw new ArtgenError('invalid_arguments', 'A flag value is missing. Use --prompt-file for prompts starting with --.');
      options[name] = value;
    }
  }
  if (options.timeout !== undefined && (!/^\d+$/.test(options.timeout) || Number(options.timeout) < 1 || Number(options.timeout) > 600)) throw new ArtgenError('invalid_arguments', 'Timeout must be an integer from 1 to 600 seconds.');
  if (command !== 'models') {
    if (!options.model || !options.output || (Object.hasOwn(options, 'prompt') === Object.hasOwn(options, 'prompt-file'))) throw new ArtgenError('invalid_arguments', 'Generation requires --model, --output and exactly one of --prompt or --prompt-file.');
    if ((command === 'convert' && !options.input) || (command === 'create' && options.input)) throw new ArtgenError('invalid_arguments', 'Only convert requires and accepts --input.');
    if (!options.yes) throw new ArtgenError('confirmation_required', 'Confirm the model and credit cost with the user, then pass --yes. No request was sent.');
  }
  return { command, options };
}

function baseOrigin(value, allowLocal) {
  let url;
  try { url = new URL(value); } catch { throw new ArtgenError('invalid_configuration', 'Set ARTGEN_BASE_URL to the trusted Artgen HTTPS origin.'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash || !(url.protocol === 'https:' || (allowLocal && loopback && url.protocol === 'http:'))) {
    throw new ArtgenError('invalid_configuration', 'ARTGEN_BASE_URL must be an HTTPS origin without credentials, path, query or fragment. Local HTTP needs --allow-local-http.');
  }
  return url.origin;
}

function imageMime(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  throw new ArtgenError('invalid_image', 'Expected PNG, JPEG or WebP image bytes.');
}

async function localFile(file, maxBytes) {
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(file)) throw new ArtgenError('invalid_arguments', 'Input must be a local file, not a URL.');
  let handle;
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size > maxBytes) throw new ArtgenError('invalid_input', 'Input must be a regular file within the documented size limit.');
    handle = await open(file, 'r');
    const bytes = Buffer.alloc(info.size + 1);
    let total = 0;
    while (total < bytes.length) {
      const result = await handle.read(bytes, total, bytes.length - total, null);
      if (result.bytesRead === 0) break;
      total += result.bytesRead;
    }
    if (total > info.size) throw new ArtgenError('invalid_input', 'Input changed while being read; try again after saving the file.');
    return bytes.subarray(0, total);
  } catch (error) {
    if (error instanceof ArtgenError) throw error;
    throw new ArtgenError('invalid_input', 'Cannot read the specified local file.');
  } finally { await handle?.close(); }
}

async function boundedBody(response, maxBytes) {
  if (Number(response.headers.get('content-length')) > maxBytes) throw new ArtgenError('invalid_response', 'Response exceeds the supported size limit.');
  if (!response.body) throw new ArtgenError('invalid_response', 'Empty server response.');
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) throw new ArtgenError('invalid_response', 'Response exceeds the supported size limit.');
      chunks.push(value);
    }
    return Buffer.concat(chunks, total);
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

const ERROR_MESSAGES = {
  invalid_request: 'The server rejected the generation parameters. Refresh the model catalog and check input.',
  unauthorized: 'The API key is missing, invalid, disabled, expired or revoked. Check Dashboard → API Keys.',
  forbidden: 'The key owner is not allowed to generate. Check account status and email verification.',
  insufficient_credits: 'The account has insufficient credits. Add credits in the Dashboard.',
  provider_unavailable: 'The selected provider is unavailable. Ask the site administrator to check configuration.',
  generation_failed: 'Generation failed. Check credit history and the request ID before any new submission.',
  rate_limited: 'The key or account is rate limited. No automatic retry was attempted.',
};

function requestId(value, secret) {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value) && (!secret || !value.includes(secret)) ? value : undefined;
}

async function apiJSON(fetchImpl, url, init, timeout, secret) {
  let response;
  try { response = await fetchImpl(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(timeout) }); }
  catch { throw new ArtgenError('request_failed', 'Connection failed or timed out. No automatic retry was attempted.'); }
  const id = requestId(response.headers.get('x-request-id'), secret);
  if (response.status >= 300 && response.status < 400) throw new ArtgenError('redirect_rejected', 'API redirects are not followed. Verify the configured origin.', { status: response.status, ...(id ? { requestId: id } : {}) });
  let body;
  try { body = JSON.parse((await boundedBody(response, MAX_JSON)).toString('utf8')); }
  catch {
    throw new ArtgenError('invalid_response', 'Expected a bounded JSON response from Artgen.', { status: response.status, ...(id ? { requestId: id } : {}) });
  }
  const safeId = requestId(body?.requestId, secret) ?? id;
  if (!response.ok) {
    const code = Object.hasOwn(ERROR_MESSAGES, body?.error ?? '') ? body.error : 'api_error';
    throw new ArtgenError(code, ERROR_MESSAGES[code] ?? 'Artgen returned an error. No automatic retry was attempted.', { status: response.status, ...(safeId ? { requestId: safeId } : {}), ...(code === 'insufficient_credits' && Number.isFinite(body.required) && Number.isFinite(body.balance) ? { required: body.required, balance: body.balance } : {}) });
  }
  return { body, requestId: safeId };
}

function catalogModels(body) {
  if (!Array.isArray(body?.models)) throw new ArtgenError('invalid_response', 'The model catalog is not valid.');
  return body.models.map(model => {
    if (!model || typeof model.id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(model.id) || typeof model.name !== 'string' || typeof model.description !== 'string' || !Number.isSafeInteger(model.creditCost) || model.creditCost <= 0 || typeof model.supportsText !== 'boolean' || typeof model.supportsTransfer !== 'boolean' || !Number.isSafeInteger(model.maxPromptLength) || model.maxPromptLength <= 0 || !Array.isArray(model.sizes) || !model.sizes.every(size => typeof size?.value === 'string' && typeof size?.label === 'string')) throw new ArtgenError('invalid_response', 'The model catalog is not valid.');
    const { id, name, description, creditCost, supportsText, supportsTransfer, maxPromptLength, sizes } = model;
    return { id, name, description, creditCost, supportsText, supportsTransfer, maxPromptLength, sizes: sizes.map(({ value, label }) => ({ value, label })) };
  });
}

function publicImageURL(value) {
  let url;
  try { url = new URL(value); } catch { throw new ArtgenError('invalid_image', 'The generated image URL is invalid.'); }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  const ipVersion = isIP(host);
  const parts = host.split('.').map(Number);
  const privateV4 = ipVersion === 4 && (parts[0] === 0 || parts[0] === 10 || parts[0] === 127 || parts[0] >= 224 || (parts[0] === 169 && parts[1] === 254) || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) || (parts[0] === 192 && parts[1] === 168) || (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127));
  // IPv6 literals are not needed for provider image URLs; rejecting them also excludes mapped loopback forms.
  if (url.protocol !== 'https:' || url.username || url.password || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || !host.includes('.') || privateV4 || ipVersion === 6) throw new ArtgenError('invalid_image', 'The generated image must use a public HTTPS URL without credentials.');
  return url;
}

async function generatedImage(value, fetchImpl, timeout) {
  if (typeof value !== 'string') throw new ArtgenError('invalid_response', 'Generation did not return an image.');
  if (value.startsWith('data:')) {
    const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
    if (!match || match[2].length % 4 || match[2].length > 4 * Math.ceil(MAX_IMAGE / 3)) throw new ArtgenError('invalid_image', 'Invalid or oversized image data URL.');
    const bytes = Buffer.from(match[2], 'base64');
    if (bytes.length > MAX_IMAGE || bytes.toString('base64') !== match[2] || imageMime(bytes) !== match[1]) throw new ArtgenError('invalid_image', 'Image encoding or MIME type does not match its bytes.');
    return { bytes, mimeType: match[1] };
  }
  const url = publicImageURL(value);
  // Never forward the API key, cookies, or API request headers to an image host.
  const response = await fetchImpl(url.href, { redirect: 'manual', signal: AbortSignal.timeout(timeout) });
  if (!response.ok || (response.status >= 300 && response.status < 400)) throw new ArtgenError('image_download_failed', 'Generated image download failed. Do not submit another generation automatically.');
  const bytes = await boundedBody(response, MAX_IMAGE);
  return { bytes, mimeType: imageMime(bytes) };
}

/** Run a command without printing; CLI entry below owns JSON serialization. */
export async function run(argv, { env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const { command, options } = parseArgs(argv);
  if (command === 'help') return { usage: USAGE };
  const origin = baseOrigin(env.ARTGEN_BASE_URL, options['allow-local-http']);
  const timeout = Number(options.timeout ?? 120) * 1000;
  const secret = env.ARTGEN_API_KEY?.trim();
  if (command !== 'models' && (!secret || !/^[^\s,]+$/.test(secret))) throw new ArtgenError('invalid_configuration', 'Set ARTGEN_API_KEY in your environment; do not pass it as an argument or paste it into chat.');
  let prompt;
  let sourceImage;
  let output;
  let outputPath;
  let posted = false;
  let successful = false;
  let generationId;
  try {
    if (command !== 'models') {
      prompt = options.prompt ?? (await localFile(options['prompt-file'], 1024 * 1024)).toString('utf8');
      if (!prompt.trim()) throw new ArtgenError('invalid_arguments', 'The prompt must not be blank.');
      if (command === 'convert') {
        const source = await localFile(options.input, MAX_SOURCE);
        sourceImage = `data:${imageMime(source)};base64,${source.toString('base64')}`;
      }
      outputPath = resolve(options.output);
      try { output = await open(outputPath, 'wx', 0o600); }
      catch (error) { throw new ArtgenError(error.code === 'EEXIST' ? 'output_exists' : 'output_unavailable', 'Cannot reserve output file. Choose a new filename in an existing writable directory. No generation was sent.'); }
    }
    const catalog = await apiJSON(fetchImpl, `${origin}/api/models`, {}, timeout);
    const models = catalogModels(catalog.body);
    if (command === 'models') return { models };
    const model = models.find(candidate => candidate.id === options.model);
    if (!model || !(command === 'create' ? model.supportsText : model.supportsTransfer)) throw new ArtgenError('invalid_model', 'Choose a published model that supports this operation using the models command.');
    if (prompt.length > model.maxPromptLength) throw new ArtgenError('invalid_arguments', 'Prompt exceeds the selected model limit.');
    if (options.size && !model.sizes.some(size => size.value === options.size)) throw new ArtgenError('invalid_arguments', 'Size is not supported by the selected model.');
    const body = { modelId: model.id, prompt, ...(options.size ? { size: options.size } : {}), ...(options.style ? { styleId: options.style } : {}), ...(sourceImage ? { sourceImage } : {}) };
    posted = true;
    const generated = await apiJSON(fetchImpl, `${origin}/api/${command}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` }, body: JSON.stringify(body) }, timeout, secret);
    generationId = generated.requestId;
    const result = generated.body;
    if (result?.success !== true || !generationId || result.data?.modelId !== model.id || !Number.isSafeInteger(result.credits?.consumed) || result.credits.consumed < 0 || !Number.isFinite(result.credits?.remaining)) throw new ArtgenError('invalid_response', 'The generation response is incomplete. Check account history before submitting again.');
    const { bytes, mimeType } = await generatedImage(result.data.imageUrl, fetchImpl, timeout);
    try { await output.writeFile(bytes); }
    catch { throw new ArtgenError('output_write_failed', 'Generation completed but the image could not be saved. Do not regenerate automatically.'); }
    successful = true;
    return { success: true, requestId: generationId, data: { path: outputPath, model: model.name, modelId: model.id, mimeType, bytes: bytes.length }, credits: { consumed: result.credits.consumed, remaining: result.credits.remaining } };
  } catch (error) {
    const safe = error instanceof ArtgenError ? error : new ArtgenError(posted ? 'generation_outcome_unknown' : 'request_failed', posted ? 'The request was interrupted. Generation may have completed; check account history before any new submission.' : 'Could not contact Artgen. Check the configured origin and connection.');
    if (posted && (!safe.details.status || safe.details.status >= 500 || safe.code === 'invalid_response')) safe.details = { ...safe.details, generationMayHaveCompleted: true };
    if (generationId) safe.details = { ...safe.details, requestId: generationId };
    throw safe;
  } finally {
    if (output) {
      await output.close().catch(() => {});
      if (!successful) await unlink(outputPath).catch(() => {});
    }
  }
}

const entryPath = process.argv[1] ? await realpath(process.argv[1]).catch(() => '') : '';
if (entryPath && import.meta.url === pathToFileURL(entryPath).href) {
  try { console.log(JSON.stringify(await run(process.argv.slice(2)), null, 2)); }
  catch (error) {
    const safe = error instanceof ArtgenError ? error : new ArtgenError('client_error', 'The client could not complete the operation.');
    const encoded = JSON.stringify({ success: false, error: safe.code, message: safe.message, ...safe.details });
    const secret = process.env.ARTGEN_API_KEY?.trim();
    console.error(secret ? encoded.replaceAll(secret, '[REDACTED]') : encoded);
    process.exitCode = 1;
  }
}
