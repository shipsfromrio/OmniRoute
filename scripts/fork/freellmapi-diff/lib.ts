/**
 * Pure logic for the FreeLLMAPI vs OmniRoute catalog diff.
 *
 * No network and no disk access here: it takes text (the page, the data.js)
 * and an already-normalized OmniRoute catalog, and returns the diff. This is
 * what the offline test bench in `tests/` exercises.
 *
 * Honesty rules of the diff:
 * - a number is compared only when BOTH sides declare it; a side that does
 *   not declare it is `null`, never zero;
 * - "trains on your data?" is `yes`, `no` or `unknown`, always with its
 *   source, and `unknown` is the default: nothing is inferred from a
 *   provider's name;
 * - the FreeLLMAPI monthly budget is a free-form label ("~10-20M",
 *   "free · 40 RPM", "$0.10/mo credit"); only the "~N[-M]{K,M,B}" shape
 *   becomes a number, everything else stays text and is not compared.
 */

// ---------------------------------------------------------------------------
// JavaScript literal parser. FreeLLMAPI's data.js is not JSON (unquoted keys,
// single quotes, 25e4). Evaluating it with `eval`/`vm` would run third-party
// code; this parser only accepts data.
// ---------------------------------------------------------------------------

export class LiteralError extends Error {}

export function parseJsLiteral(src: string, start = 0): { value: unknown; end: number } {
  let i = start;
  const n = src.length;

  function skipSpace(): void {
    while (i < n) {
      const c = src[i];
      if (c === " " || c === "\n" || c === "\r" || c === "\t") i++;
      else if (c === "/" && src[i + 1] === "/") {
        while (i < n && src[i] !== "\n") i++;
      } else if (c === "/" && src[i + 1] === "*") {
        const f = src.indexOf("*/", i + 2);
        if (f < 0) throw new LiteralError(`unterminated comment at ${i}`);
        i = f + 2;
      } else break;
    }
  }

  function str(): string {
    const quote = src[i++];
    let out = "";
    while (i < n) {
      const c = src[i++];
      if (c === quote) return out;
      if (c !== "\\") {
        out += c;
        continue;
      }
      const e = src[i++];
      if (e === "n") out += "\n";
      else if (e === "t") out += "\t";
      else if (e === "r") out += "\r";
      else if (e === "b") out += "\b";
      else if (e === "f") out += "\f";
      else if (e === "v") out += "\v";
      else if (e === "0") out += "\0";
      else if (e === "u") {
        if (src[i] === "{") {
          const f = src.indexOf("}", i);
          out += String.fromCodePoint(parseInt(src.slice(i + 1, f), 16));
          i = f + 1;
        } else {
          out += String.fromCharCode(parseInt(src.slice(i, i + 4), 16));
          i += 4;
        }
      } else if (e === "x") {
        out += String.fromCharCode(parseInt(src.slice(i, i + 2), 16));
        i += 2;
      } else if (e === "\n") {
        // line continuation
      } else out += e;
    }
    throw new LiteralError("unterminated string");
  }

  function ident(): string {
    const m = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(src.slice(i, i + 256));
    if (!m) throw new LiteralError(`identifier expected at ${i}`);
    i += m[0].length;
    return m[0];
  }

  function num(): number {
    const m = /^[+-]?(?:0[xX][0-9a-fA-F]+|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/.exec(
      src.slice(i, i + 64)
    );
    if (!m) throw new LiteralError(`number expected at ${i}`);
    i += m[0].length;
    return Number(m[0]);
  }

  function value(): unknown {
    skipSpace();
    const c = src[i];
    if (c === "{") {
      i++;
      const obj: Record<string, unknown> = {};
      skipSpace();
      if (src[i] === "}") {
        i++;
        return obj;
      }
      for (;;) {
        skipSpace();
        let key: string;
        if (src[i] === '"' || src[i] === "'") key = str();
        else if (/[0-9]/.test(src[i])) key = String(num());
        else key = ident();
        skipSpace();
        if (src[i++] !== ":") throw new LiteralError(`':' expected after ${key}`);
        obj[key] = value();
        skipSpace();
        if (src[i] === ",") {
          i++;
          skipSpace();
          if (src[i] === "}") {
            i++;
            return obj;
          }
          continue;
        }
        if (src[i] === "}") {
          i++;
          return obj;
        }
        throw new LiteralError(`',' or '}' expected at ${i}`);
      }
    }
    if (c === "[") {
      i++;
      const arr: unknown[] = [];
      skipSpace();
      if (src[i] === "]") {
        i++;
        return arr;
      }
      for (;;) {
        arr.push(value());
        skipSpace();
        if (src[i] === ",") {
          i++;
          skipSpace();
          if (src[i] === "]") {
            i++;
            return arr;
          }
          continue;
        }
        if (src[i] === "]") {
          i++;
          return arr;
        }
        throw new LiteralError(`',' or ']' expected at ${i}`);
      }
    }
    if (c === '"' || c === "'") return str();
    if (c === "-" || c === "+" || c === "." || /[0-9]/.test(c ?? "")) return num();
    if (c === "!" && (src[i + 1] === "0" || src[i + 1] === "1")) {
      i += 2;
      return src[i - 1] === "0";
    }
    const id = ident();
    if (id === "true") return true;
    if (id === "false") return false;
    if (id === "null" || id === "undefined") return null;
    throw new LiteralError(`identifier '${id}' is not data (at ${i})`);
  }

  const v = value();
  return { value: v, end: i };
}

// ---------------------------------------------------------------------------
// FreeLLMAPI side
// ---------------------------------------------------------------------------

/** Finds, in the /models page, the script that loads the catalog (`/assets/data.js?v=...`). */
export function extractDataUrl(html: string, base: string): string | null {
  const m = /<script[^>]*\bsrc="([^"]*\/assets\/data\.js[^"]*)"/i.exec(html);
  if (!m) return null;
  return new URL(m[1], base).href;
}

export interface FreeSnapshotMeta {
  version: string | null;
  generatedAt: string | null;
  tier: string | null;
  counts: Record<string, unknown>;
}

export interface FreeModel {
  platform: string;
  platformName: string | null;
  modelId: string;
  name: string | null;
  context: number | null;
  rpm: number | null;
  rpd: number | null;
  tpm: number | null;
  tpd: number | null;
  budgetLabel: string | null;
  monthlyBudget: { min: number; max: number } | null;
  intelligenceRank: number | null;
  /** Slugs of quirks whose text mentions training (a hint to read, never a verdict). */
  quirksMentioningTraining: string[];
}

export interface FreeCatalog {
  meta: FreeSnapshotMeta;
  platforms: Array<{ id: string; name: string | null }>;
  models: FreeModel[];
}

const SNAPSHOT_MARK = "CATALOG_SNAPSHOT";

/** Extracts the `window.CATALOG_SNAPSHOT = {...}` object from data.js. */
export function extractSnapshot(js: string): Record<string, unknown> {
  const pos = js.indexOf(SNAPSHOT_MARK);
  if (pos < 0) throw new LiteralError("data.js has no CATALOG_SNAPSHOT: the format changed");
  const eq = js.indexOf("=", pos);
  const { value } = parseJsLiteral(js, eq + 1);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new LiteralError("CATALOG_SNAPSHOT is not an object");
  }
  return value as Record<string, unknown>;
}

function asNum(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function asStr(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

const MULT: Record<string, number> = { K: 1e3, M: 1e6, B: 1e9 };

/** "~10-20M" -> {min:1e7,max:2e7}; "~3M" -> {3e6,3e6}; any other label -> null. */
export function parseMonthlyBudget(label: string | null): { min: number; max: number } | null {
  if (!label) return null;
  const m = /^~\s*([\d.,]+)\s*(?:-\s*([\d.,]+))?\s*([KMB])\b/i.exec(label.trim());
  if (!m) return null;
  const k = MULT[m[3].toUpperCase()];
  const a = Number(m[1].replace(/,/g, "")) * k;
  const b = m[2] ? Number(m[2].replace(/,/g, "")) * k : a;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return { min: Math.min(a, b), max: Math.max(a, b) };
}

const TRAINING_RE = /\b(train|trains|training|trained)\b/i;

export function normalizeFree(snap: Record<string, unknown>): FreeCatalog {
  const platforms = (Array.isArray(snap.platforms) ? snap.platforms : []).map((p) => {
    const o = (p ?? {}) as Record<string, unknown>;
    return { id: String(o.id), name: asStr(o.name) };
  });
  const names = new Map(platforms.map((p) => [p.id, p.name]));
  const models: FreeModel[] = [];
  for (const raw of Array.isArray(snap.models) ? snap.models : []) {
    const o = (raw ?? {}) as Record<string, unknown>;
    if (o.enabled === false) continue;
    const lim = (o.limits ?? {}) as Record<string, unknown>;
    const quirks = Array.isArray(o.quirks) ? (o.quirks as Array<Record<string, unknown>>) : [];
    const label = asStr(o.monthlyTokenBudget);
    models.push({
      platform: String(o.platform),
      platformName: names.get(String(o.platform)) ?? null,
      modelId: String(o.modelId),
      name: asStr(o.displayName),
      context: asNum(o.contextWindow),
      rpm: asNum(lim.rpm),
      rpd: asNum(lim.rpd),
      tpm: asNum(lim.tpm),
      tpd: asNum(lim.tpd),
      budgetLabel: label,
      monthlyBudget: parseMonthlyBudget(label),
      intelligenceRank: asNum(o.intelligenceRank),
      quirksMentioningTraining: quirks
        .filter((q) => TRAINING_RE.test(`${q.title ?? ""} ${q.body ?? ""}`))
        .map((q) => String(q.slug)),
    });
  }
  return {
    meta: {
      version: asStr(snap.version),
      generatedAt: asStr(snap.generatedAt),
      tier: asStr(snap.tier),
      counts: (snap.counts ?? {}) as Record<string, unknown>,
    },
    platforms,
    models,
  };
}

// ---------------------------------------------------------------------------
// OmniRoute side, already normalized (`omniroute.ts` reads the code)
// ---------------------------------------------------------------------------

export interface OmniModel {
  id: string;
  /** id, aliases and liveCatalogIds, to match the FreeLLMAPI id. */
  ids: string[];
  context: number | null;
}

export interface OmniProvider {
  id: string;
  models: OmniModel[];
  defaultContext: number | null;
  /** Model list is fetched live (passthrough or modelsUrl): the static list is not complete. */
  liveCatalog: boolean;
  defaultRpm: number | null;
}

export interface OmniBudget {
  provider: string;
  modelId: string;
  monthlyTokens: number;
  freeType: string;
  trainsOnPrompts: boolean | null;
}

export interface OmniCatalog {
  curatedAt: string | null;
  providers: Record<string, OmniProvider>;
  budgets: OmniBudget[];
  geminiLimits: Record<string, { rpm?: number; rpd?: number; tpm?: number }>;
  sources: {
    registry: string;
    budgets: string;
    geminiLimits: string;
    defaultRpm: string;
    media: string[];
  };
}

// ---------------------------------------------------------------------------
// Provider map FreeLLMAPI -> OmniRoute
// ---------------------------------------------------------------------------

/**
 * FreeLLMAPI platform ids that have another name in OmniRoute. Anything not
 * listed matches by the same id. Checked on 2026-10-11 against each entry's
 * baseUrl (`open-sse/config/providers/registry/<id>/index.ts`). With more than
 * one target, a model counts as present if any of them has it.
 */
export const DEFAULT_MAP: Record<string, string[]> = {
  google: ["gemini"],
  cloudflare: ["cloudflare-ai"],
  kilo: ["kilo-gateway", "kilocode"],
  ovh: ["ovhcloud"],
  ollama: ["ollama-cloud"],
  zhipu: ["glm", "glm-cn", "zai"],
};

// ---------------------------------------------------------------------------
// The diff
// ---------------------------------------------------------------------------

export type Trains = "yes" | "no" | "unknown";

export interface Sourced<T> {
  value: T;
  source: string;
}

export interface Quota {
  field: "context" | "rpm" | "rpd" | "tpm" | "tokens_month";
  freellmapi: number | { min: number; max: number } | null;
  omniroute: number | null;
  omnirouteSource: string | null;
  diverges: boolean;
}

export type ModelStatus = "present" | "missing" | "missing_from_static" | "provider_missing";

export interface ModelRow {
  platform: string;
  modelId: string;
  name: string | null;
  omnirouteProvider: string | null;
  omnirouteId: string | null;
  status: ModelStatus;
  intelligenceRank: number | null;
  budgetLabel: string | null;
  quotas: Quota[];
  trains: { freellmapi: Sourced<Trains>; omniroute: Sourced<Trains> };
}

export interface ProviderRow {
  freellmapi: string;
  name: string | null;
  omniroute: string[];
  status: "present" | "missing";
  freellmapiModels: number;
}

export interface Scoreboard {
  freellmapiProviders: number;
  missingProviders: number;
  freellmapiModels: number;
  presentModels: number;
  missingModels: number;
  missingFromStaticModels: number;
  providerMissingModels: number;
  divergentQuotas: number;
  modelsWithDivergentQuota: number;
  missingAndNoTraining: number;
  missingAndTraining: number;
  missingTrainingUnknown: number;
}

export interface DiffResult {
  sources: {
    freellmapi: FreeSnapshotMeta & { url: string | null };
    omniroute: { curatedAt: string | null; files: OmniCatalog["sources"] };
  };
  map: Record<string, string[]>;
  tokensMonthTolerance: number;
  providers: ProviderRow[];
  models: ModelRow[];
  scoreboard: Scoreboard;
}

export interface DiffOptions {
  map?: Record<string, string[]>;
  /** Factor accepted between FreeLLMAPI's "~N" label and OmniRoute's monthlyTokens. */
  tokensMonthTolerance?: number;
  freellmapiUrl?: string | null;
}

function key(s: string): string {
  return s.trim().toLowerCase();
}

function findModel(prov: OmniProvider, modelId: string): OmniModel | null {
  const k = key(modelId);
  for (const m of prov.models) if (m.ids.some((x) => key(x) === k)) return m;
  return null;
}

function omniTraining(b: OmniBudget | undefined, file: string): Sourced<Trains> {
  if (!b || b.trainsOnPrompts === null) {
    return { value: "unknown", source: `${file}: no trainsOnPrompts for this model` };
  }
  return {
    value: b.trainsOnPrompts ? "yes" : "no",
    source: `${file}: trainsOnPrompts=${b.trainsOnPrompts}`,
  };
}

function freeTraining(m: FreeModel): Sourced<Trains> {
  if (m.quirksMentioningTraining.length) {
    return {
      value: "unknown",
      source: `freellmapi.co/models: no training field; quirk(s) ${m.quirksMentioningTraining.join(", ")} mention training (read them)`,
    };
  }
  return { value: "unknown", source: "freellmapi.co/models: the public catalog has no training field" };
}

function compareNumber(
  field: Quota["field"],
  free: number | null,
  omni: number | null,
  source: string | null
): Quota {
  return {
    field,
    freellmapi: free,
    omniroute: omni,
    omnirouteSource: omni === null ? null : source,
    diverges: free !== null && omni !== null && free !== omni,
  };
}

function geminiLimit(cat: OmniCatalog, modelId: string, field: "rpm" | "rpd" | "tpm"): number | null {
  const e = cat.geminiLimits[modelId.replace(/^models\//, "")];
  const v = e?.[field];
  // geminiRateLimits.json uses 0 for "not published": 0 is not a declared limit.
  return typeof v === "number" && v > 0 ? v : null;
}

export function computeDiff(free: FreeCatalog, omni: OmniCatalog, options: DiffOptions = {}): DiffResult {
  const map = { ...DEFAULT_MAP, ...(options.map ?? {}) };
  const tol = options.tokensMonthTolerance ?? 1.5;
  if (!(tol >= 1)) throw new Error("tokensMonthTolerance must be >= 1");

  const targets = (platform: string): string[] =>
    (map[platform] ?? [platform]).filter((id) => omni.providers[id]);

  const budgetByKey = new Map<string, OmniBudget>();
  for (const b of omni.budgets) budgetByKey.set(`${b.provider}\u0000${key(b.modelId)}`, b);

  const platformIds = new Set<string>([
    ...free.platforms.map((p) => p.id),
    ...free.models.map((m) => m.platform),
  ]);
  const providers: ProviderRow[] = [...platformIds].sort().map((id) => {
    const t = targets(id);
    return {
      freellmapi: id,
      name: free.platforms.find((p) => p.id === id)?.name ?? null,
      omniroute: t,
      status: t.length ? "present" : "missing",
      freellmapiModels: free.models.filter((m) => m.platform === id).length,
    };
  });

  const models: ModelRow[] = free.models.map((m) => {
    const t = targets(m.platform);
    let provId: string | null = null;
    let found: OmniModel | null = null;
    for (const id of t) {
      const r = findModel(omni.providers[id], m.modelId);
      if (r) {
        provId = id;
        found = r;
        break;
      }
    }
    // The free-tier budget may sit under OmniRoute's canonical id, not under the alias that matched.
    let budget: OmniBudget | undefined;
    const lookupIds = [m.modelId, ...(found ? found.ids : [])];
    lookup: for (const id of provId ? [provId] : t) {
      for (const mid of lookupIds) {
        budget = budgetByKey.get(`${id}\u0000${key(mid)}`);
        if (budget) {
          provId = provId ?? id;
          break lookup;
        }
      }
    }

    let status: ModelStatus;
    if (!t.length) status = "provider_missing";
    else if (found || budget) status = "present";
    else if (t.some((id) => omni.providers[id].liveCatalog)) status = "missing_from_static";
    else status = "missing";

    const quotas: Quota[] = [];
    if (status === "present" && provId) {
      const prov = omni.providers[provId];
      const modelCtx = found?.context ?? null;
      const ctx = modelCtx ?? prov.defaultContext;
      const ctxSource =
        modelCtx !== null
          ? `${omni.sources.registry} (${provId}: contextLength)`
          : `${omni.sources.registry} (${provId}: defaultContextLength)`;
      quotas.push(compareNumber("context", m.context, ctx, ctxSource));

      const isGemini = provId === "gemini";
      const gemSource = `${omni.sources.geminiLimits} (${m.modelId})`;
      quotas.push(
        compareNumber(
          "rpm",
          m.rpm,
          isGemini ? geminiLimit(omni, m.modelId, "rpm") : prov.defaultRpm,
          isGemini ? gemSource : `${omni.sources.defaultRpm} (${provId})`
        )
      );
      quotas.push(compareNumber("rpd", m.rpd, isGemini ? geminiLimit(omni, m.modelId, "rpd") : null, gemSource));
      quotas.push(compareNumber("tpm", m.tpm, isGemini ? geminiLimit(omni, m.modelId, "tpm") : null, gemSource));

      const omniTokens = budget && budget.monthlyTokens > 0 ? budget.monthlyTokens : null;
      const range = m.monthlyBudget;
      quotas.push({
        field: "tokens_month",
        freellmapi: range,
        omniroute: omniTokens,
        omnirouteSource:
          omniTokens === null ? null : `${omni.sources.budgets} (${budget!.provider}/${budget!.modelId})`,
        diverges:
          range !== null && omniTokens !== null && (omniTokens < range.min / tol || omniTokens > range.max * tol),
      });
    }

    return {
      platform: m.platform,
      modelId: m.modelId,
      name: m.name,
      omnirouteProvider: provId,
      omnirouteId: found?.id ?? budget?.modelId ?? null,
      status,
      intelligenceRank: m.intelligenceRank,
      budgetLabel: m.budgetLabel,
      quotas,
      trains: {
        freellmapi: freeTraining(m),
        omniroute: omniTraining(budget, omni.sources.budgets),
      },
    };
  });

  const missing = models.filter((r) => r.status !== "present");
  const anySays = (r: ModelRow, v: Trains) => r.trains.freellmapi.value === v || r.trains.omniroute.value === v;
  const scoreboard: Scoreboard = {
    freellmapiProviders: providers.length,
    missingProviders: providers.filter((p) => p.status === "missing").length,
    freellmapiModels: models.length,
    presentModels: models.filter((r) => r.status === "present").length,
    missingModels: models.filter((r) => r.status === "missing").length,
    missingFromStaticModels: models.filter((r) => r.status === "missing_from_static").length,
    providerMissingModels: models.filter((r) => r.status === "provider_missing").length,
    divergentQuotas: models.reduce((s, r) => s + r.quotas.filter((q) => q.diverges).length, 0),
    modelsWithDivergentQuota: models.filter((r) => r.quotas.some((q) => q.diverges)).length,
    missingAndNoTraining: missing.filter((r) => anySays(r, "no") && !anySays(r, "yes")).length,
    missingAndTraining: missing.filter((r) => anySays(r, "yes")).length,
    missingTrainingUnknown: missing.filter((r) => !anySays(r, "yes") && !anySays(r, "no")).length,
  };

  return {
    sources: {
      freellmapi: { ...free.meta, url: options.freellmapiUrl ?? null },
      omniroute: { curatedAt: omni.curatedAt, files: omni.sources },
    },
    map,
    tokensMonthTolerance: tol,
    providers,
    models,
    scoreboard,
  };
}

// ---------------------------------------------------------------------------
// Markdown output
// ---------------------------------------------------------------------------

function fmt(v: number | { min: number; max: number } | null): string {
  if (v === null) return "-";
  const one = (x: number) =>
    x >= 1e9
      ? `${+(x / 1e9).toFixed(2)}B`
      : x >= 1e6
        ? `${+(x / 1e6).toFixed(2)}M`
        : x >= 1e3
          ? `${+(x / 1e3).toFixed(1)}K`
          : String(x);
  if (typeof v === "number") return one(v);
  return v.min === v.max ? `~${one(v.min)}` : `~${one(v.min)}-${one(v.max)}`;
}

function cell(s: string | null | undefined): string {
  return (s ?? "-").replace(/\|/g, "\\|").replace(/\n/g, " ");
}

/** Missing models, ranked for porting: largest monthly budget first, then best rank. Excludes known trainers. */
export function portingCandidates(res: DiffResult, free: FreeCatalog): ModelRow[] {
  const budget = new Map(free.models.map((m) => [`${m.platform}\u0000${m.modelId}`, m.monthlyBudget]));
  return res.models
    .filter((r) => r.status !== "present" && r.trains.omniroute.value !== "yes" && r.trains.freellmapi.value !== "yes")
    .sort((a, b) => {
      const ba = budget.get(`${a.platform}\u0000${a.modelId}`)?.max ?? 0;
      const bb = budget.get(`${b.platform}\u0000${b.modelId}`)?.max ?? 0;
      if (bb !== ba) return bb - ba;
      return (a.intelligenceRank ?? 1e9) - (b.intelligenceRank ?? 1e9);
    });
}

export function renderMarkdown(res: DiffResult, free: FreeCatalog): string {
  const s = res.scoreboard;
  const L: string[] = [];
  L.push("# FreeLLMAPI vs OmniRoute catalog diff", "");
  L.push(
    `- FreeLLMAPI: version ${res.sources.freellmapi.version ?? "-"}, generated ${res.sources.freellmapi.generatedAt ?? "-"}, tier ${res.sources.freellmapi.tier ?? "-"} (${res.sources.freellmapi.url ?? "local file"})`,
    `- OmniRoute: free catalog curated ${res.sources.omniroute.curatedAt ?? "-"}`,
    `- Tokens/month tolerance: factor ${res.tokensMonthTolerance}`,
    ""
  );
  L.push("## Scoreboard", "", "| Measure | Value |", "|---|---|");
  const rows: Array<[string, number]> = [
    ["FreeLLMAPI providers", s.freellmapiProviders],
    ["Providers missing in OmniRoute", s.missingProviders],
    ["FreeLLMAPI models (enabled)", s.freellmapiModels],
    ["Models present in OmniRoute", s.presentModels],
    ["Models missing (provider with a static list)", s.missingModels],
    ["Models not in the static list of a live-catalog provider (unknown)", s.missingFromStaticModels],
    ["Models of a missing provider", s.providerMissingModels],
    ["Divergent quotas (fields)", s.divergentQuotas],
    ["Models with a divergent quota", s.modelsWithDivergentQuota],
    ["Missing and a source says it does NOT train", s.missingAndNoTraining],
    ["Missing and a source says it trains", s.missingAndTraining],
    ["Missing with training unknown", s.missingTrainingUnknown],
  ];
  for (const [k, v] of rows) L.push(`| ${k} | ${v} |`);
  L.push("");

  L.push("## Providers", "", "| FreeLLMAPI | Name | OmniRoute | Status | Models there |", "|---|---|---|---|---|");
  for (const p of res.providers) {
    L.push(`| ${p.freellmapi} | ${cell(p.name)} | ${p.omniroute.join(", ") || "-"} | ${p.status} | ${p.freellmapiModels} |`);
  }
  L.push("");

  L.push(
    "## Divergent quotas",
    "",
    "| Platform | Model | Field | FreeLLMAPI | OmniRoute | OmniRoute source |",
    "|---|---|---|---|---|---|"
  );
  for (const r of res.models) {
    for (const q of r.quotas.filter((x) => x.diverges)) {
      L.push(`| ${r.platform} | ${cell(r.modelId)} | ${q.field} | ${fmt(q.freellmapi)} | ${fmt(q.omniroute)} | ${cell(q.omnirouteSource)} |`);
    }
  }
  L.push("");

  L.push(
    "## Missing models, by monthly budget",
    "",
    "Excludes models any source says train on prompts.",
    "",
    "| Platform | Model | Status | Budget (label) | Rank | Trains (FreeLLMAPI) | Trains (OmniRoute) |",
    "|---|---|---|---|---|---|---|"
  );
  for (const r of portingCandidates(res, free)) {
    L.push(
      `| ${r.platform} | ${cell(r.modelId)} | ${r.status} | ${cell(r.budgetLabel)} | ${r.intelligenceRank ?? "-"} | ${r.trains.freellmapi.value} | ${r.trains.omniroute.value} |`
    );
  }
  L.push("");

  L.push(
    "## All models",
    "",
    "| Platform | Model | Status | OmniRoute | Trains (FreeLLMAPI) | Trains (OmniRoute) | Training source (OmniRoute) |",
    "|---|---|---|---|---|---|---|"
  );
  for (const r of res.models) {
    L.push(
      `| ${r.platform} | ${cell(r.modelId)} | ${r.status} | ${r.omnirouteProvider ? `${r.omnirouteProvider}/${r.omnirouteId}` : "-"} | ${r.trains.freellmapi.value} | ${r.trains.omniroute.value} | ${cell(r.trains.omniroute.source)} |`
    );
  }
  L.push("");
  return L.join("\n");
}
