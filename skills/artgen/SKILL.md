---
name: artgen
description: Create images and convert local reference images with an Artgen deployment. Use for Artgen, image generation, text-to-image, image-to-image, style transfer, 文生图, 图片生成, 图生图, 图片转换, or 风格转换 requests. Requires an explicitly configured deployment and user approval for credit spending.
license: MIT
compatibility: Requires Node.js 22.20 or newer and network access to a user-configured Artgen deployment.
metadata:
  author: ziyu
  version: "1.0.0"
---

# Artgen

Use the bundled Node.js client to query models, create an image, or convert a local reference image. This skill is a client, not a hosted service. Requires Node.js 22.20+ and a reachable Artgen deployment.

## Locate and configure

Resolve `scripts/artgen.mjs` relative to **this installed `SKILL.md`**. Use its absolute path for commands, regardless of the current working directory. References are also relative to this file: read [API reference](references/api.md) for flags, wire format, and failure semantics. Do not require the repository checkout or a separately published npm CLI.

For the examples, set `ARTGEN_SCRIPT` to the resolved absolute script path. `MODEL_ID` and `SIZE` must come from the live catalog, not from remembered model/provider names.

- `ARTGEN_BASE_URL` must be the user's explicitly configured HTTPS origin, with no credentials, path, query, or fragment. Do not guess a production host.
- Have the user create an Artgen API key in their deployment's Dashboard and configure `ARTGEN_API_KEY` outside the conversation using a secure environment mechanism. Never ask them to paste a key in chat. Do not put secrets in flags, files committed to Git, logs, or examples. Never request provider credentials.
- HTTP is allowed only for exact `localhost`, `127.0.0.1`, or `[::1]` hosts with explicit `--allow-local-http` on each invocation. Use this only for trusted local development; never downgrade a remote deployment to HTTP.
- The model catalog is public. Do not ask for a key merely to list models.

## Workflow

1. **Discover capabilities and cost.** Run:

   ```sh
   node "$ARTGEN_SCRIPT" models
   ```

   Select an actual catalog `id`. Require `supportsText` for `create` or `supportsTransfer` for `convert`. Review `creditCost`, `sizes[].value`, and `maxPromptLength`. Do not hardcode availability, dimensions, model names, prices, or capabilities. There is no style-discovery endpoint here: omit `--style` unless a valid deployment-specific ID is independently known. Descriptive style requests can remain in the prompt.

2. **Prepare input without executing user text.** Write the requested prompt to a UTF-8 file using a file-writing tool. Prefer `--prompt-file`; do not interpolate arbitrary user text into shell source. Respect the catalog's UTF-16 prompt-length limit. For conversion, use a user-provided local regular PNG/JPEG/WebP file of at most 5 MiB. Remote source URLs are not accepted; ask for a local file rather than passing a URL as `--input`. Select a new output path in an existing appropriate directory; never overwrite an existing file. Filename extensions do not control the returned image format.

3. **Obtain explicit spending approval.** Explain the operation, selected model, current catalog credit cost, source/prompt, and output location. Obtain the user's clear approval for this paid request before passing `--yes`. A general request to explore available models is not approval to generate. If the catalog or selection changes materially, reconfirm. The service's returned credits are authoritative; a catalog fetch does not lock a price. Do not invent spending limits, dry-run flags, or guaranteed refunds.

4. **Submit exactly once after approval.** Creation:

   ```sh
   node "$ARTGEN_SCRIPT" create \
     --model "$MODEL_ID" --size "$SIZE" \
     --prompt-file ./prompt.txt --output ./created.png --yes
   ```

   Conversion, using a transfer-capable catalog ID and its supported size:

   ```sh
   node "$ARTGEN_SCRIPT" convert \
     --model "$MODEL_ID" --size "$SIZE" \
     --input ./reference.png --prompt-file ./conversion.txt \
     --output ./converted.png --yes
   ```

   These are separate paid operations, not a sequence to run automatically. Optional `--timeout` accepts 1–600 seconds, default 120. Missing `--yes` fails before network activity. Do not bypass the bundled client's safety checks with an ad hoc HTTP request.

5. **Return the file and actual result.** Parse JSON stdout. On success, present `data.path` as the saved image and report `credits.consumed` and `credits.remaining` when relevant. Preserve `requestId` for troubleshooting; use `data.mimeType` rather than assuming PNG. Do not expose the raw download URL, image base64, prompt content, or secrets in diagnostic logs. Do not claim success without a successful client result and saved output.

## Fail safely

Errors are JSON on stderr with exit code 1. Report the safe `message` and available `requestId`. Do not expose raw server responses or credentials.

**Never automatically retry or switch models.** A timeout, malformed generation response, download failure, or save failure can occur after the server generated the image and charged credits. If `generationMayHaveCompleted` is true, explicitly explain that possibility and stop. Absence of a request ID is not proof that generation did not happen. Keep any available request ID and obtain fresh user approval before a new paid attempt. There is no idempotency or task-status lookup; do not claim that repeating a request will recover the original result.

API redirects and image-download redirects are rejected. The client does not send the API key to the catalog or image-download host. Do not weaken these protections, accept remote source URLs, overwrite outputs, or install provider credentials to work around a failure. Model capability metadata is not a promise that a provider is operational, and conversion support is not evidence of a successful live conversion.
