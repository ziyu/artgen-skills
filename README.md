# Artgen Skills

A standalone Agent Skill and dependency-free Node.js client for Artgen image creation and local-image conversion. **This repository is a client, not an image-generation backend or hosted service.** Bring an Artgen deployment and an API key from its Dashboard. No production URL is assumed.

[简体中文](README.zh-CN.md) · [Skill instructions](skills/artgen/SKILL.md) · [API reference](skills/artgen/references/api.md)

## Install

Requires Node.js **22.20 or newer**.

```sh
npx skills add ziyu/artgen-skills --skill artgen
```

The skill includes its own `scripts/artgen.mjs`; no separate npm package or runtime dependencies are required. Agents resolve script and reference paths relative to the **installed `SKILL.md`**, not their working directory.

For direct CLI use, clone this repository and run the examples from its root:

```sh
git clone https://github.com/ziyu/artgen-skills.git
cd artgen-skills
node skills/artgen/scripts/artgen.mjs --help
```

## Configure securely

Set `ARTGEN_BASE_URL` to your deployment's HTTPS **origin only** (scheme and host, optional port; no credentials, path, query, or fragment). There is no default host. Set `ARTGEN_API_KEY` through your shell's secure environment mechanism or secret manager, using a key created in the deployment's Dashboard.

Never paste keys in agent chat, put them in command flags, commit them, or print them in logs. Provider credentials are not client API keys and must not be published. The CLI does not manage keys, admin settings, or account balances.

Only local development can use HTTP: an origin with exactly `localhost`, `127.0.0.1`, or `[::1]`, together with `--allow-local-http` on **each** command. Other HTTP hosts are rejected. Do not send a real production key to an untrusted development server.

## Discover models before spending

```sh
node skills/artgen/scripts/artgen.mjs models
```

This public request does not need or transmit an API key. Select an `id` from the current catalog, check `supportsText` or `supportsTransfer`, and review `creditCost`, `sizes[].value`, and `maxPromptLength`. Model availability and prices can change; do not infer them from examples. Prompt limits count UTF-16 code units. Each generation command refreshes the catalog.

The examples below require `MODEL_ID` and `SIZE` to be set to actual values from that catalog. For conversion, choose a model with `supportsTransfer: true`; it need not be the same model used for creation. There is no public style catalog in this client: omit `--style` unless you have a verified style ID for your deployment.

## Create or convert

Write the prompt to a UTF-8 file using an editor or a file-writing tool. Prefer `--prompt-file` over interpolating user text into a shell command: never execute prompt text as shell syntax. The sample paths below refer to files you prepare locally.

**Each generation request may consume credits.** Review the selected model, current credit cost, requested operation, prompt/source, and output location with the user before passing `--yes`. That flag explicitly authorizes billing; it is not a dry run. Without it, generation fails with `confirmation_required` before any network request.

After approval, create an image:

```sh
node skills/artgen/scripts/artgen.mjs create \
  --model "$MODEL_ID" --size "$SIZE" \
  --prompt-file ./prompt.txt --output ./created.png --yes
```

Or convert a local image after separate approval:

```sh
node skills/artgen/scripts/artgen.mjs convert \
  --model "$MODEL_ID" --size "$SIZE" \
  --input ./reference.png --prompt-file ./conversion.txt \
  --output ./converted.png --yes
```

`--input` must be a local regular PNG, JPEG, or WebP file, at most 5 MiB; magic bytes are checked. Remote source URLs are not accepted. `create` rejects `--input`. Exactly one of `--prompt` and `--prompt-file` is required. `--size` and `--style` are optional; `--timeout` defaults to 120 seconds and accepts 1–600 seconds.

Choose a new output path: existing files are never overwritten. The client reserves it before the paid POST and downloads the result without forwarding your API key. The output contains the actual image bytes; a `.png` filename does not convert JPEG/WebP into PNG. Use the returned `mimeType` when displaying or naming the result.

## Results and failures

Successful commands emit one JSON result to stdout. `models` returns `{ "models": [...] }`. Generation returns `success`, `requestId`, `data` (`path`, `model`, `modelId`, `mimeType`, `bytes`), and `credits` (`consumed`, `remaining`). Present the saved file and actual credit information to the user; do not dump image data or secrets into chat.

Failures exit with status 1 and emit safe JSON on stderr: `success: false`, `error`, `message`, and, when available, `requestId`, `status`, or `generationMayHaveCompleted`. **Never automatically retry a generation**, including after timeout, malformed responses, download errors, or save failures. The server may have completed and billed the request even if no file was saved. Keep the request ID, explain the uncertainty, and obtain fresh approval before any new paid attempt. There is no idempotency key or task-status lookup. API and download redirects are rejected, and no fallback model is chosen.

See the [API and CLI reference](skills/artgen/references/api.md) for the complete boundary and security restrictions. Catalog capabilities are not a guarantee of provider availability or proof of a live conversion run.

## Development

From the repository root:

```sh
npm test
npm run check
```

These checks require no credentials and never make paid requests. Before the initial release, 32 tests and the structure/syntax checks passed locally. A locally installed copy was exercised against a local Artgen backend with a real Cloudflare Workers AI provider: it saved a 1024×1024 JPEG and consumed 5 credits (30 → 25). Conversion with that text-only model was rejected before billing. Successful live conversion and a public production deployment have not been verified.

## License

[MIT](LICENSE) © 2026 ziyu.
