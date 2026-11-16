"use strict";
// Contract test for the compact catalog cache: the distillation the bridge
// writes to disk must yield the exact same `parseCatalogData` projection as
// the full upstream document, so a warm boot is byte-for-byte equivalent to
// the old 6.5 MB parse.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const identity = require("../identity");

test("compactCatalog preserves every field parseCatalogData reads", () => {
  const raw = {
    opencode: {
      api: "https://opencode.ai/zen/v1/",
      npm: "@ai-sdk/openai-compatible",
      models: {
        "Mimo-Test-Free": {
          cost: { input: 0, output: 0 },
          status: "active",
          tool_call: true,
          reasoning: true,
          limit: { output: 131072, context: 262144 },
          family: "mimo",
          provider: { api: "https://gateway.opencode.ai/anthropic/v1", npm: "@ai-sdk/openai" },
          // Fields the bridge never reads must not break the projection.
          modality: "text->text",
          release_date: "2026-01-01",
        },
        "paid-model": { cost: { input: 1, output: 2 }, status: "active" },
        "old-model": { cost: { input: 0, output: 0 }, status: "deprecated" },
        "image-only": { status: "active" },
      },
    },
  };
  const fromRaw = identity.parseCatalogData(raw);
  const fromCompact = identity.parseCatalogData(identity.compactCatalog(raw));
  assert.deepEqual(fromCompact, fromRaw);
  assert.equal(fromRaw.catalogVerdicts["mimo-test-free"], "free");
  assert.equal(fromRaw.catalogVerdicts["paid-model"], "paid");
  assert.equal(fromRaw.catalogVerdicts["old-model"], "deprecated");
  assert.equal(fromRaw.modelFacts["mimo-test-free"].reasoning, true);
  assert.equal(fromRaw.modelFamilies.mimo, "Mimo-Test-Free");
  assert.equal(fromRaw.modelEndpoints["mimo-test-free"], "https://gateway.opencode.ai/anthropic/v1");
});

test("a non-catalog document passes through unchanged", () => {
  assert.deepEqual(identity.compactCatalog(null), null);
  assert.deepEqual(identity.compactCatalog({}), {});
  assert.deepEqual(identity.compactCatalog({ other: 1 }), { other: 1 });
});

test("writeCachedCatalog stores the compact projection on disk", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ofb-compact-cache-"));
  const prev = process.env.OPENCODE_CACHE_DIR;
  process.env.OPENCODE_CACHE_DIR = dir;
  try {
    const raw = {
      opencode: {
        api: "https://opencode.ai/zen/v1/",
        models: { a: { cost: { input: 0, output: 0 }, status: "active" } },
      },
    };
    identity.writeCachedCatalog(raw);
    const file = path.join(dir, "catalog.json");
    const stored = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.ok(stored.opencode && stored.opencode.models, "cache must stay shaped like a catalog");
    assert.equal(stored.opencode.models.a.cost.input, 0);
    // And a warm boot reads it back into the same projection.
    const proj = identity.parseCatalogData(stored);
    assert.equal(proj.catalogVerdicts.a, "free");
  } finally {
    if (prev === undefined) delete process.env.OPENCODE_CACHE_DIR;
    else process.env.OPENCODE_CACHE_DIR = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
