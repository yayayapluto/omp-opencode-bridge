const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const SENSITIVE_KEY = /token|secret|password|authorization|cookie|api[-_]?key|credential/i;
const NEVER_LOG_KEY = /prompt|messages|output|response|body|headers|stack|profile/i;
const RESERVED_KEY = /^(ts|level|event|plugin|version)$/;
const URL_WITH_QUERY = /https?:\/\/\S+/gi;
const BEARER_VALUE = /\b(bearer\s+)\S+/gi;
const INLINE_SECRET = /\b(token|secret|password|authorization|cookie|api[-_]?key|credential)\s*[:=]\s*[^\s,;]+/gi;
const MAX_STRING = 200;

function safeString(value: unknown): string {
  let text = String(value);
  text = text.replace(URL_WITH_QUERY, (url) => url.split(/[?#]/)[0]);
  text = text.replace(BEARER_VALUE, "$1[redacted]");
  text = text.replace(INLINE_SECRET, "$1=[redacted]");
  return text.length > MAX_STRING ? text.slice(0, MAX_STRING) : text;
}

function redact(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return undefined;
  if (value instanceof Error) return safeString(value.message);
  if (typeof value === "string") return safeString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (depth >= 4) return undefined;
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1)).filter((item) => item !== undefined);
  if (typeof value !== "object") return undefined;

  const clean: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(key) || NEVER_LOG_KEY.test(key) || RESERVED_KEY.test(key)) continue;
    const redacted = redact(item, depth + 1);
    if (redacted !== undefined) clean[key] = redacted;
  }
  return clean;
}

function stateDir(): string {
  return process.env.OPENCODE_BRIDGE_STATE_DIR || path.join(os.homedir(), ".opencode-free-bridge");
}

function createLogger(config: { plugin: string; version: string }) {
  const plugin = String(config.plugin || "unknown");
  const version = String(config.version || "unknown");

  function write(level: string, event: string, metadata?: unknown): void {
    if (process.env.OMP_PLUGIN_LOG === "0") return;
    try {
      const entry: Record<string, unknown> = {
        ts: new Date().toISOString(),
        level: level === "warn" || level === "error" ? level : "info",
        event: String(event),
        plugin,
        version,
      };
      const safe = redact(metadata);
      if (safe && typeof safe === "object") Object.assign(entry, safe);
      fs.mkdirSync(stateDir(), { recursive: true });
      fs.appendFileSync(path.join(stateDir(), "plugin-events.jsonl"), JSON.stringify(entry) + "\n");
    } catch {
      // A read-only home must never break the plugin.
    }
  }

  return {
    write,
    info: (event: string, metadata?: unknown) => write("info", event, metadata),
    warn: (event: string, metadata?: unknown) => write("warn", event, metadata),
    error: (event: string, metadata?: unknown) => write("error", event, metadata),
  };
}

module.exports = { createLogger, redact, safeString };
