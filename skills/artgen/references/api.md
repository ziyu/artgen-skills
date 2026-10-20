# Artgen client and public API

The bundled client is [`../scripts/artgen.mjs`](../scripts/artgen.mjs), resolved relative to this reference or the installed [Skill](../SKILL.md), not the working directory. Requires Node.js 22.20+. This repository does not host the backend.

## Configuration and command contract

`ARTGEN_BASE_URL` is required for network commands. It must be an explicit HTTPS origin, without credentials, path, query, or fragment. There is no default deployment. HTTP is accepted only for exact `localhost`, `127.0.0.1`, or `[::1]` hosts and only with `--allow-local-http`. The exception does not permit arbitrary private-network HTTP endpoints.

`ARTGEN_API_KEY` is required for `create` and `convert`, not `models`. Create the key in the deployment's Dashboard and inject it through the environment outside agent chat. No key flag exists. Never expose keys, provider credentials, prompts, or base64 in diagnostic logs.

| Command | Required arguments | Optional arguments |
| --- | --- | --- |
| `--help` alone | None | None |
| `models` | None | `--timeout`, `--allow-local-http` |
| `create` | `--model`, exactly one of `--prompt` / `--prompt-file`, `--output`, `--yes` | `--size`, `--style`, `--timeout`, `--allow-local-http` |
| `convert` | Same as `create`, plus `--input` | Same as `create` |

All flags except `--yes` and `--allow-local-http` take one value. Unknown, repeated, or missing-value flags are rejected with `invalid_arguments`. `create` rejects `--input`. `--timeout` is seconds, default 120, allowed range 1–600. `--help` returns `{ "usage": "..." }` without needing deployment configuration.

Use a UTF-8 prompt file written by a file-writing tool. Never interpolate user prompt text into shell source. A prompt must be nonblank and within the selected model's `maxPromptLength`, counted in UTF-16 code units. Select `--model` and any `--size` from the live catalog; do not guess. Optional `--style` maps to a deployment-supported style ID. This API exposes no style catalog: omit it unless verified independently.

`--input` is a local regular file, not a remote URL. Only PNG, JPEG, and WebP are accepted, validated by magic bytes, with a 5 MiB maximum. The client encodes it as a data URL; callers do not supply remote source image URLs. `--output` must not already exist. The client reserves it exclusively before sending the paid request and removes the empty reservation on failure. It does not overwrite existing files or provide a force flag. The suffix does not change image encoding.

`--yes` is explicit billing authorization, not a dry run. Obtain informed user approval before supplying it. Missing approval produces `confirmation_required` before any network request. Every generation command fetches the model catalog and checks the ID, capability, size when provided, and prompt limit before its single POST. There are no automatic retries or fallback models.

## Public endpoints

Paths below are relative to the configured origin. API redirects are rejected.

### `GET /api/models`

Public catalog: no `Authorization` header is sent, even if the environment contains a key. The CLI returns:

```json
{ "models": [] }
```

The empty list illustrates the envelope only. Each actual entry has these public fields:

| Field | Meaning |
| --- | --- |
| `id` | Opaque model ID used as `modelId` in generation requests |
| `name`, `description` | Public display metadata |
| `creditCost` | Current credit cost; catalog lookup does not reserve or lock pricing |
| `supportsText` | Whether text-to-image is supported |
| `supportsTransfer` | Whether local-image conversion is supported |
| `sizes` | Array of `{ "value": string, "label": string }`; pass `value`, not `label` |
| `maxPromptLength` | Maximum prompt length in UTF-16 code units |

Only public fields are returned by the CLI. Do not infer provider routing, secrets, or capabilities from a model name. Capabilities do not guarantee provider availability; do not treat a listed conversion capability as proof of live conversion verification.

### `POST /api/create`

Requires `Authorization: Bearer <ARTGEN_API_KEY>` and `Content-Type: application/json`. The client sends a whitelisted JSON object:

- `modelId`: selected catalog ID (`--model`).
- `prompt`: text from `--prompt-file` or `--prompt`.
- `size`: optional catalog size value (`--size`).
- `styleId`: optional verified style ID (`--style`).

The endpoint enforces text generation. The client does not send provider names, provider credentials, arbitrary options, or a source image.

### `POST /api/convert`

Same authentication and fields as creation, plus `sourceImage`: a validated PNG/JPEG/WebP base64 data URL derived from `--input`. The endpoint enforces transfer mode. Require `supportsTransfer` from the current catalog rather than maintaining a hardcoded provider/model list.

Each POST may bill credits. There is no idempotency key, task-status endpoint, or automatic recovery of an earlier generation in this client. Key management, admin routes, and a standalone credit-balance endpoint are out of scope.

## Generation response and image download

Successful API responses contain:

- `success: true` and `requestId`.
- `data.imageUrl`, `data.model`, `data.modelId`; optional dimensions may also be present.
- `credits.consumed` and `credits.remaining`.

`data.imageUrl` can be a supported raster base64 data URL or an HTTPS download URL. The client validates PNG/JPEG/WebP signatures and requires data-URL MIME types to match the bytes. Download requests never carry the API key, and redirects are rejected. URLs with credentials or obvious localhost/private IP hosts are forbidden. This URL screening is not a substitute for network-level egress controls in a hostile environment. Response reading is bounded: approximately 32 MiB for JSON and 24 MiB for image content.

The CLI saves bytes and replaces the remote image representation with local-file metadata. Successful generation stdout has this shape (types, not a copy-paste response):

```text
{
  success: true,
  requestId: string,
  data: {
    path: string,
    model: string,
    modelId: string,
    mimeType: string,
    bytes: number
  },
  credits: { consumed: number, remaining: number }
}
```

Present the saved file using `data.path` and the actual MIME type. Do not print base64 or signed download URLs. The filename extension is not a format-conversion option.

## Errors and uncertain completion

Failure exits with status 1 and writes a single safe JSON error to stderr:

```text
{
  success: false,
  error: string,
  message: string,
  requestId?: string,
  status?: number,
  generationMayHaveCompleted?: boolean
}
```

Known server errors use static safe messages instead of raw response text. Server errors include `invalid_request` (400), authentication errors (401/403 as returned), `insufficient_credits` (402), `provider_unavailable` (503), and `generation_failed` (502 or 500). Do not depend on raw server message bodies or leak tokens, URL query strings, prompts, or image data when troubleshooting.

After a POST has been attempted, a timeout, invalid response, download error, or save failure can leave completion and billing uncertain. The CLI preserves any available request ID and reports `generationMayHaveCompleted: true` for uncertain post-submission failures. A missing request ID or missing saved file does not prove that nothing was billed. **Do not automatically retry, change models, or promise refunds.** Explain the uncertainty, retain the request ID for support, and obtain new approval before a new paid request.

## Programmatic interface

The ESM module has no import-time execution. It exports `run(argv, { env = process.env, fetchImpl = fetch } = {})`, an async function returning the command result, and `ArtgenError` with `code`, `message`, and `details`. CLI output formatting and exit handling occur only when invoked as the executable. Injection is intended for isolated testing; it does not change production authorization or billing semantics.
