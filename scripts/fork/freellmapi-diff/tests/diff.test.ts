// Offline test bench for the FreeLLMAPI vs OmniRoute diff.
// Run: node --test scripts/fork/freellmapi-diff/tests/diff.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  LiteralError,
  computeDiff,
  extractDataUrl,
  extractSnapshot,
  normalizeFree,
  parseJsLiteral,
  parseMonthlyBudget,
  renderMarkdown,
  type DiffResult,
} from "../lib.ts";
import { readOmniRouteCatalog } from "../omniroute.ts";
import { PoliteStop, fetchText } from "../diff-freellmapi.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(HERE, "fixtures");

async function runFixture(tolerance?: number): Promise<{ res: DiffResult; md: string }> {
  const html = fs.readFileSync(path.join(FIX, "models.html"), "utf8");
  assert.equal(extractDataUrl(html, "https://freellmapi.co/models"), "https://freellmapi.co/assets/data.js?v=abc123");
  const free = normalizeFree(extractSnapshot(fs.readFileSync(path.join(FIX, "data.js"), "utf8")));
  const omni = await readOmniRouteCatalog(path.join(FIX, "min-catalog"));
  const res = computeDiff(free, omni, { tokensMonthTolerance: tolerance });
  return { res, md: renderMarkdown(res, free) };
}

function row(res: DiffResult, modelId: string) {
  const r = res.models.find((x) => x.modelId === modelId);
  assert.ok(r, `model ${modelId} missing from the diff`);
  return r;
}

function divergent(res: DiffResult): string[] {
  return res.models
    .flatMap((r) => r.quotas.filter((q) => q.diverges).map((q) => `${r.modelId}:${q.field}`))
    .sort();
}

test("JS literal parser accepts what data.js uses and nothing but data", () => {
  const { value } = parseJsLiteral(`{a:1,'b':"x\\u0041\\x42",c:[25e4,-1.5,.5,],d:!0,e:!1,f:null,g:undefined,"h":{},}`);
  assert.deepEqual(value, { a: 1, b: "xAB", c: [250000, -1.5, 0.5], d: true, e: false, f: null, g: null, h: {} });
  assert.throws(() => parseJsLiteral("{a:alert(1)}"), LiteralError);
  assert.throws(() => parseJsLiteral("{a:'unterminated}"), LiteralError);
  assert.throws(() => extractSnapshot("window.OTHER={}"), LiteralError);
});

test("monthly budget: only the ~N[-M]{K,M,B} label becomes a number", () => {
  assert.deepEqual(parseMonthlyBudget("~3M"), { min: 3e6, max: 3e6 });
  assert.deepEqual(parseMonthlyBudget("~10-20M"), { min: 1e7, max: 2e7 });
  assert.deepEqual(parseMonthlyBudget("~1,000K"), { min: 1e6, max: 1e6 });
  assert.deepEqual(parseMonthlyBudget("~2M (60-100/hr)"), { min: 2e6, max: 2e6 });
  assert.equal(parseMonthlyBudget("free · 40 RPM"), null);
  assert.equal(parseMonthlyBudget("$0.10/mo credit"), null);
  assert.equal(parseMonthlyBudget(""), null);
  assert.equal(parseMonthlyBudget(null), null);
});

test("model status: present, missing, not in a live static list, missing provider", async () => {
  const { res } = await runFixture();
  const status = Object.fromEntries(res.models.map((r) => [r.modelId, r.status]));
  assert.deepEqual(status, {
    "gemini-x-flash": "present", // google -> gemini through the map
    "gemini-y-pro": "present",
    "Alfa/Modelo-Um": "present", // different case
    "alfa-dois": "present", // matched through an alias
    "alfa-tres": "present",
    "alfa-novo": "missing",
    "alfa-imagem": "present", // only in a media registry
    "beta-qualquer": "missing_from_static", // provider with passthroughModels
    "sumido-1": "provider_missing",
  });
  assert.equal(row(res, "alfa-dois").omnirouteId, "alfa-2");
  assert.equal(row(res, "gemini-x-flash").omnirouteProvider, "gemini");
  assert.ok(!res.models.some((r) => r.modelId === "alfa-desligado"), "enabled:false is skipped");
  const prov = Object.fromEntries(res.providers.map((p) => [p.freellmapi, p.status]));
  assert.deepEqual(prov, { alfa: "present", beta: "present", google: "present", sumido: "missing" });
});

test("quotas diverge only when both sides declare and differ", async () => {
  const { res } = await runFixture();
  assert.deepEqual(divergent(res), [
    "Alfa/Modelo-Um:rpm", // 30 vs provider default 40
    "alfa-dois:context", // 32768 vs 16384
    "alfa-dois:tokens_month", // ~5M vs 9M (above 5M x 1.5)
    "alfa-imagem:rpm", // 2 vs 40
    "alfa-tres:tokens_month", // ~1M vs 1.6M (above 1M x 1.5)
    "gemini-x-flash:rpm", // 10 vs 5 in geminiRateLimits.json
    "gemini-y-pro:context", // 1048576 vs 2097152
  ]);
  const tok = row(res, "gemini-x-flash").quotas.find((q) => q.field === "tokens_month")!;
  assert.equal(tok.omniroute, null, "monthlyTokens 0 means 'not declared', not zero");
  const rpmY = row(res, "gemini-y-pro").quotas.find((q) => q.field === "rpm")!;
  assert.equal(rpmY.omniroute, null, "0 in geminiRateLimits.json means 'not published'");
  const ctxTres = row(res, "alfa-tres").quotas.find((q) => q.field === "context")!;
  assert.equal(ctxTres.omniroute, 65536);
  assert.match(ctxTres.omnirouteSource!, /defaultContextLength/);
  assert.deepEqual(row(res, "alfa-novo").quotas, [], "a missing model has no compared quota");
});

test("tokens/month tolerance flips the verdict at the edge", async () => {
  const { res } = await runFixture(2);
  const d = divergent(res);
  assert.ok(!d.includes("alfa-tres:tokens_month"), "1.6M fits within 1M x 2");
  assert.ok(!d.includes("alfa-dois:tokens_month"), "9M fits within 5M x 2");
  assert.throws(() =>
    computeDiff(
      normalizeFree({ models: [] }),
      { providers: {}, budgets: [], geminiLimits: {}, curatedAt: null, sources: {} as never },
      { tokensMonthTolerance: 0.5 }
    )
  );
});

test("trains on data: a value only with a source, 'unknown' by default", async () => {
  const { res } = await runFixture();
  const one = row(res, "Alfa/Modelo-Um");
  assert.equal(one.trains.omniroute.value, "yes");
  assert.match(one.trains.omniroute.source, /freeModelCatalog\.data\.ts: trainsOnPrompts=true/);
  assert.equal(one.trains.freellmapi.value, "unknown");
  assert.match(one.trains.freellmapi.source, /alfa-treino/);
  assert.equal(row(res, "alfa-dois").trains.omniroute.value, "no");
  assert.equal(row(res, "alfa-tres").trains.omniroute.value, "unknown");
  assert.equal(row(res, "alfa-novo").trains.omniroute.value, "unknown");
  assert.match(row(res, "alfa-novo").trains.freellmapi.source, /no training field/);
});

test("scoreboard adds up with the rows", async () => {
  const { res, md } = await runFixture();
  assert.deepEqual(res.scoreboard, {
    freellmapiProviders: 4,
    missingProviders: 1,
    freellmapiModels: 9,
    presentModels: 6,
    missingModels: 1,
    missingFromStaticModels: 1,
    providerMissingModels: 1,
    divergentQuotas: 7,
    modelsWithDivergentQuota: 6,
    missingAndNoTraining: 0,
    missingAndTraining: 0,
    missingTrainingUnknown: 3,
  });
  assert.equal(res.sources.freellmapi.version, "2099.01.01");
  assert.equal(res.sources.omniroute.curatedAt, "2099-01-02");
  assert.match(md, /\| Providers missing in OmniRoute \| 1 \|/);
  assert.match(md, /\| alfa \| alfa-novo \| missing \| ~50-100M \|/);
});

test("403 and 429 stop the read, with no retry", async () => {
  const original = globalThis.fetch;
  for (const status of [403, 429]) {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response("", { status });
    }) as typeof fetch;
    try {
      await assert.rejects(fetchText("https://freellmapi.co/models"), PoliteStop);
      assert.equal(calls, 1);
    } finally {
      globalThis.fetch = original;
    }
  }
  await assert.rejects(fetchText("https://other.example/models"), /origin outside/);
});
