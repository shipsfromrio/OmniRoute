# FreeLLMAPI vs OmniRoute catalog diff

Fork-only tooling (`scripts/fork/`), not part of what upstream maintains.

## When to use

- Before touching the free combos or `freeModelCatalog.data.ts`: to see which
  free models FreeLLMAPI lists that OmniRoute does not have, and which quotas
  (context, rpm, rpd, tpm, tokens/month) the two declare differently.
- Before picking models for a privacy-restricted route that may only use
  models that do not train on prompts: the training column says who claims
  what, and from which source.
- Once a month is enough. FreeLLMAPI's public catalog is the monthly
  snapshot (tier `monthly`, up to 30 days behind); the same-day feed is paid
  and this script does not use it.

## How to run

```
node scripts/fork/freellmapi-diff/diff-freellmapi.ts --out <dir> --omniroute <root of an OmniRoute checkout with node_modules>
```

Node 24 or newer (runs the `.ts` directly, no tsx). Output under `--out`:
`diff.md` (tables), `diff.json` (raw) and `raw/` (the page and `data.js`
that were read, to reprocess without network).

| Argument | Purpose |
|---|---|
| `--out <dir>` | required; the only place the script writes |
| `--omniroute <root>` | OmniRoute checkout to compare; defaults to the repo the script lives in. Needs `node_modules` (`audioRegistry.ts` imports `zod`); without it the script stops and says so |
| `--page <file>`, `--data <file>` | read a saved page and `data.js`, no network (for example the `raw/` of a previous run) |
| `--map <json>` | adds to or overrides the provider map, `{"freellmapi-id": ["omniroute-id", ...]}` |
| `--tolerance <factor>` | factor accepted between the `~N` tokens/month label and OmniRoute's `monthlyTokens`; default 1.5 |
| `--pause-ms <ms>` | pause between the two requests; default 1500 |

Test bench, offline:

```
node --test scripts/fork/freellmapi-diff/tests/diff.test.ts
```

## What it reads

**FreeLLMAPI.** The `https://freellmapi.co/models` page does not carry the
table in its HTML: it loads `/assets/data.js?v=<hash>`, which defines
`window.CATALOG_SNAPSHOT` as a JavaScript literal (unquoted keys, `25e4`).
The script makes two GET requests (the page and that file) with a pause, and
reads the literal with its own parser that only accepts data, no `eval`.
403 or 429 stops the read with exit code 3, no retry. No token, no login, no
paid feed.

**OmniRoute.** It imports the code itself instead of regex over the source:

| Data | File |
|---|---|
| providers, models, context, live list | `open-sse/config/providers/index.ts` (`REGISTRY`) |
| media models | `open-sse/config/{audio,image,video,embedding,moderation,rerank,music,ocr,upscale}Registry.ts` |
| free tokens/month, `trainsOnPrompts` | `open-sse/config/freeModelCatalog.data.ts` |
| Gemini rpm, rpd, tpm | `open-sse/config/geminiRateLimits.json` |
| default rpm per provider | `open-sse/services/providerDefaultRateLimit.ts` |

`alias-resolver.mjs` resolves the `@/` alias and extensionless imports so
Node can import the TypeScript without a bundler.

## Reading the result

- **Model status.** `present`; `missing` (the provider has a static list and
  the id is not in it); `missing_from_static` (the provider fetches its list
  live through `passthroughModels` or `modelsUrl`, so absence from the static
  list proves nothing: unknown); `provider_missing`.
- **Id matching.** Exact, case-insensitive, against `id`, `aliases` and
  `liveCatalogIds`. No fuzzy matching: a similar id shows up as `missing`.
- **Provider map.** `DEFAULT_MAP` in `lib.ts` (google to gemini, cloudflare to
  cloudflare-ai, kilo, ovh, ollama, zhipu); everything else matches by id.
- **Quotas.** A field diverges only when both sides declare a number.
  OmniRoute declares rpm/rpd/tpm only for Gemini, and a default rpm for a few
  providers (NVIDIA today); `monthlyTokens: 0` and the `0` in
  `geminiRateLimits.json` mean "not declared", never zero. Context comes from
  the model's `contextLength` or, failing that, the provider's
  `defaultContextLength` (the source column says which).
- **FreeLLMAPI tokens/month.** A free-form label. Only `~N` or `~N-M` with K,
  M or B becomes a number; `free · 40 RPM`, `$0.10/mo credit` and the like
  stay as text and are not compared.
- **Trains on data?** FreeLLMAPI's public catalog has no such field, so its
  side is always `unknown`, naming the quirk when one mentions training.
  OmniRoute's side is `yes` or `no` only when `freeModelCatalog.data.ts`
  carries `trainsOnPrompts`; otherwise `unknown`. Nothing is inferred from a
  provider's name.

## First run and pitfalls

Run of 2026-10-11 (FreeLLMAPI catalog 2026.10.02, OmniRoute
`release/v3.8.51`): 25 providers, 2 missing (Sail Research, which requires a
payment method, and Pinecone, embeddings only); 343 models, 89 present, 51
missing from a static list, 198 outside the static list of a live-catalog
provider, 5 of a missing provider; 18 divergent quotas in 18 models.

- No missing model has a source saying it does NOT train: OmniRoute's
  `trainsOnPrompts` only exists for models it already has (13 rows, all
  `true`). "What is missing and does not train" needs each provider's terms
  curated before porting.
- `geminiRateLimits.json` uses `0` for "not published". Reading `0` as a
  limit would make everything diverge.
- Running from a worktree without `node_modules` fails at
  `audioRegistry.ts` (`zod`); point `--omniroute` at the main checkout.
