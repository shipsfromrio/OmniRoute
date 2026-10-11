/**
 * Reads the OmniRoute catalog from its OWN code (imports the modules, no
 * regex over the source), under a root passed as an argument.
 *
 * Where each field comes from (paths relative to the root):
 * - providers, models, context and whether the list is live:
 *   open-sse/config/providers/index.ts (REGISTRY);
 * - free tokens/month and trainsOnPrompts: open-sse/config/freeModelCatalog.data.ts;
 * - Gemini rpm/rpd/tpm: open-sse/config/geminiRateLimits.json;
 * - default rpm per provider: open-sse/services/providerDefaultRateLimit.ts;
 * - media models (image, audio, video, embedding, moderation...): the
 *   `open-sse/config/<kind>Registry.ts` files in MEDIA_REGISTRIES, because
 *   FreeLLMAPI lists flux, whisper and TTS in the same table as chat models.
 *
 * OmniRoute declares no per-model rpm/rpd beyond that, so the diff leaves its
 * side `null` (unknown), never zero.
 */
import fs from "node:fs";
import path from "node:path";
import { register } from "node:module";
import { pathToFileURL } from "node:url";

import type { OmniBudget, OmniCatalog, OmniProvider } from "./lib.ts";

export const FILES = {
  registry: "open-sse/config/providers/index.ts",
  budgets: "open-sse/config/freeModelCatalog.data.ts",
  geminiLimits: "open-sse/config/geminiRateLimits.json",
  defaultRpm: "open-sse/services/providerDefaultRateLimit.ts",
} as const;

/** Media registries: every `Record<provider, { models: [...] }>` export of these files is read. */
export const MEDIA_REGISTRIES = [
  "open-sse/config/audioRegistry.ts",
  "open-sse/config/imageRegistry.ts",
  "open-sse/config/videoRegistry.ts",
  "open-sse/config/embeddingRegistry.ts",
  "open-sse/config/moderationRegistry.ts",
  "open-sse/config/rerankRegistry.ts",
  "open-sse/config/musicRegistry.ts",
  "open-sse/config/ocrRegistry.ts",
  "open-sse/config/upscaleRegistry.ts",
] as const;

const registered = new Set<string>();

function registerResolver(root: string): void {
  if (registered.has(root)) return;
  if (registered.size) {
    // The hook keeps one root per process; mixing roots would cross-import.
    throw new Error(`resolver already registered for another root: ${[...registered][0]}`);
  }
  register("./alias-resolver.mjs", { parentURL: import.meta.url, data: { root } });
  registered.add(root);
}

async function load(root: string, rel: string): Promise<Record<string, unknown>> {
  const target = path.join(root, rel);
  if (!fs.existsSync(target)) throw new Error(`OmniRoute catalog has no ${rel} under ${root}`);
  try {
    return (await import(pathToFileURL(target).href)) as Record<string, unknown>;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/Cannot find package/.test(msg)) {
      throw new Error(
        `${rel} needs an npm dependency that ${root} does not have (${msg}). ` +
          "Point --omniroute at a checkout with node_modules installed."
      );
    }
    throw err;
  }
}

function positiveOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
}

export async function readOmniRouteCatalog(rootArg: string): Promise<OmniCatalog> {
  const root = path.resolve(rootArg);
  registerResolver(root);

  const reg = (await load(root, FILES.registry)).REGISTRY as Record<string, Record<string, unknown>>;
  if (!reg || typeof reg !== "object") throw new Error(`${FILES.registry} does not export REGISTRY`);

  const budgetsMod = await load(root, FILES.budgets);
  const rawBudgets = budgetsMod.FREE_MODEL_BUDGETS as Array<Record<string, unknown>>;
  if (!Array.isArray(rawBudgets)) throw new Error(`${FILES.budgets} does not export FREE_MODEL_BUDGETS`);

  const geminiLimits = JSON.parse(fs.readFileSync(path.join(root, FILES.geminiLimits), "utf8"));

  const rl = await load(root, FILES.defaultRpm);
  const rpmOf = rl.getProviderDefaultRateLimit as
    | ((id: string) => { requests: number; windowMs: number } | undefined)
    | undefined;
  if (typeof rpmOf !== "function") throw new Error(`${FILES.defaultRpm} does not export getProviderDefaultRateLimit`);

  const providers: Record<string, OmniProvider> = {};
  for (const [id, e] of Object.entries(reg)) {
    const models = (Array.isArray(e.models) ? e.models : []) as Array<Record<string, unknown>>;
    const win = rpmOf(id);
    providers[id] = {
      id,
      models: models.map((m) => ({
        id: String(m.id),
        ids: [
          String(m.id),
          ...((Array.isArray(m.aliases) ? m.aliases : []) as string[]),
          ...((Array.isArray(m.liveCatalogIds) ? m.liveCatalogIds : []) as string[]),
        ],
        context: positiveOrNull(m.contextLength),
      })),
      defaultContext: positiveOrNull(e.defaultContextLength),
      liveCatalog: Boolean(e.passthroughModels || e.modelsUrl || e.liveCatalogAuthoritative),
      // Only a 1-minute window becomes rpm; any other window is not comparable to FreeLLMAPI's rpm.
      defaultRpm: win && win.windowMs === 60_000 ? win.requests : null,
    };
  }

  // A media registry absent from the root (the bench's minimal catalog) is skipped;
  // present but broken fails the read, so the diff never silently runs without it.
  const mediaRead: string[] = [];
  for (const rel of MEDIA_REGISTRIES) {
    if (!fs.existsSync(path.join(root, rel))) continue;
    const mod = await load(root, rel);
    mediaRead.push(rel);
    for (const exp of Object.values(mod)) {
      if (!exp || typeof exp !== "object" || Array.isArray(exp)) continue;
      for (const [id, e] of Object.entries(exp as Record<string, unknown>)) {
        const list = (e as { models?: unknown })?.models;
        if (!Array.isArray(list)) continue;
        const prov = (providers[id] ??= {
          id,
          models: [],
          defaultContext: null,
          liveCatalog: false,
          defaultRpm: null,
        });
        for (const md of list as Array<Record<string, unknown>>) {
          if (typeof md?.id !== "string") continue;
          if (prov.models.some((x) => x.ids.includes(md.id as string))) continue;
          prov.models.push({ id: md.id, ids: [md.id], context: null });
        }
      }
    }
  }

  const budgets: OmniBudget[] = rawBudgets.map((b) => ({
    provider: String(b.provider),
    modelId: String(b.modelId),
    monthlyTokens: typeof b.monthlyTokens === "number" ? b.monthlyTokens : 0,
    freeType: String(b.freeType),
    trainsOnPrompts: typeof b.trainsOnPrompts === "boolean" ? b.trainsOnPrompts : null,
  }));

  return {
    curatedAt: typeof budgetsMod.FREE_CATALOG_CURATED_AT === "string" ? budgetsMod.FREE_CATALOG_CURATED_AT : null,
    providers,
    budgets,
    geminiLimits,
    sources: { ...FILES, media: mediaRead },
  };
}
