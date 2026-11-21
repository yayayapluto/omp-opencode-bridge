const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createLogger, redact } = require("../src/log");

test("plugin events are JSONL, redacted, and silenced by the kill switch", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-plugin-log-"));
  const priorDir = process.env.OPENCODE_BRIDGE_STATE_DIR;
  const priorKill = process.env.OMP_PLUGIN_LOG;
  const secret = "sk-DISTINCTIVE-TEST-TOKEN-9f4a2b";
  const prompt = "DISTINCTIVE_PROMPT_TEXT_7c1d8e";
  const logFile = path.join(dir, "plugin-events.jsonl");

  process.env.OPENCODE_BRIDGE_STATE_DIR = dir;
  delete process.env.OMP_PLUGIN_LOG;
  try {
    const log = createLogger({ plugin: "omp-opencode-bridge", version: "2.7.0" });
    log.info("models_refreshed", {
      count: 3,
      apiKey: secret,
      nested: { Authorization: `Bearer ${secret}`, model: "mimo-free" },
      prompt,
      url: `https://example.com/v1/chat?token=${secret}#fragment`,
      stack: "Error: stack must never be logged",
      long: "x".repeat(250),
    });

    const raw = fs.readFileSync(logFile, "utf8");
    assert.ok(!raw.includes(secret), "secret value leaked");
    assert.ok(!raw.includes(prompt), "prompt leaked");
    assert.ok(!raw.includes("stack must never be logged"), "stack leaked");
    assert.ok(!raw.includes("?token="), "query string leaked");

    const lines = raw.trimEnd().split(/\r?\n/);
    assert.equal(lines.length, 1);
    const entry = JSON.parse(lines[0]);
    assert.match(entry.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.equal(entry.level, "info");
    assert.equal(entry.event, "models_refreshed");
    assert.equal(entry.plugin, "omp-opencode-bridge");
    assert.equal(entry.version, "2.7.0");
    assert.equal(entry.count, 3);
    assert.equal(entry.nested.model, "mimo-free");
    assert.equal(entry.apiKey, undefined);
    assert.equal(entry.nested.Authorization, undefined);
    assert.equal(entry.long.length, 200);

    process.env.OMP_PLUGIN_LOG = "0";
    log.error("should_not_appear", {});
    assert.equal(fs.readFileSync(logFile, "utf8"), raw);

    assert.deepEqual(redact({ Password: "p", keep: 1 }), { keep: 1 });
  } finally {
    if (priorDir === undefined) delete process.env.OPENCODE_BRIDGE_STATE_DIR;
    else process.env.OPENCODE_BRIDGE_STATE_DIR = priorDir;
    if (priorKill === undefined) delete process.env.OMP_PLUGIN_LOG;
    else process.env.OMP_PLUGIN_LOG = priorKill;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
