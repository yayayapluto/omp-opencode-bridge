/**
 * omp/pi extension — registers the local opencode-free-bridge as an
 * OpenAI-completions provider, so an OMP session can use the free model list
 * with no account and no API key.
 *
 * The bridge itself ships inside this package (`server.ts` at the package
 * root). The extension reuses a bridge that is already listening on the port,
 * otherwise starts one under Bun, and keeps it for the session.
 *
 * Usage inside OMP:
 *   /opencode-free                → bridge + provider status
 *   /opencode-free models         → list the registered model ids
 *   /opencode-free refresh-models → re-fetch /v1/models and re-register
 *   /opencode-free start|stop|restart
 *   /opencode-free logs           → tail the bridge log
 *   /opencode-free health         → raw /health JSON
 *   /opencode-free help
 *
 * No runtime dependencies: node builtins only. The `pi` API surface used here
 * is three calls (registerProvider, registerCommand, ui.notify), declared
 * locally as structural types so this file never imports a package that is not
 * installed.
 */

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLogger } from "./log";


const EXTENSION_NAME = "opencode-free";
const HOST = "127.0.0.1";
const DEFAULT_PORT = Number(process.env.OPENCODE_BRIDGE_PORT) || 20129;
const START_TIMEOUT_MS = 20_000;

// Where the installed package keeps the bridge. `src/index.ts` → package root.
const PACKAGE_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const VERSION = (() => {
	try {
		return JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8")).version;
	} catch {
		return "unknown";
	}
})();
const log = createLogger({ plugin: "omp-opencode-bridge", version: VERSION });


const STATE_DIR = process.env.OPENCODE_BRIDGE_STATE_DIR || path.join(os.homedir(), ".opencode-free-bridge");
const STATE_FILE = path.join(STATE_DIR, "omp-plugin.json");
const LOG_FILE = path.join(STATE_DIR, "omp-plugin.log");
const MODELS_CACHE_FILE = path.join(STATE_DIR, "omp-models.json");

/** The slice of `@earendil-works/pi-coding-agent` this extension calls. */
interface ProviderModelConfig {
	id: string;
	name: string;
	api: string;
	reasoning: boolean;
	input: Array<"text" | "image">;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow: number;
	maxTokens: number;
}

interface ExtensionAPI {
	registerProvider(
		name: string,
		config: {
			baseUrl: string;
			apiKey: string;
			api: string;
			models: ProviderModelConfig[];
			refreshModels?: () => Promise<ProviderModelConfig[]>;
		}
	): void;
	registerCommand(
		name: string,
		command: {
			description: string;
			getArgumentCompletions?: (prefix: string) => Array<{ value: string; label: string }>;
			handler: (args: string, ctx: { ui: { notify: (message: string, level?: string) => void } }) => Promise<void>;
		}
	): void;
	setStatus?: (name: string, status: string) => void;
	ui: { notify: (message: string, level?: string) => void };
}

interface BridgeState {
	port: number;
	pid?: number;
	startedAt?: number;
}

const MODEL_BASE: Omit<ProviderModelConfig, "id" | "name"> = {
	api: "openai-completions",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 16_384,
};

function readState(): BridgeState | null {
	try {
		const data = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
		if (typeof data?.port === "number") return data as BridgeState;
	} catch {
		// no state yet
	}
	return null;
}

function writeState(state: BridgeState): void {
	try {
		fs.mkdirSync(STATE_DIR, { recursive: true });
		fs.writeFileSync(STATE_FILE, JSON.stringify(state));
	} catch {
		// a read-only home must not break the session
	}
}

function pidAlive(pid: number): boolean {
	if (!pid || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function healthz(port: number): Promise<Record<string, unknown> | null> {
	try {
		const res = await fetch(`http://${HOST}:${port}/health`, { signal: AbortSignal.timeout(1500) });
		if (!res.ok) return null;
		return (await res.json()) as Record<string, unknown>;
	} catch {
		return null;
	}
}

async function fetchModels(port: number): Promise<ProviderModelConfig[]> {
	try {
		const res = await fetch(`http://${HOST}:${port}/v1/models`, {
			headers: { Accept: "application/json" },
			signal: AbortSignal.timeout(5000),
		});
		if (!res.ok) return [];
		const payload = (await res.json()) as { data?: Array<{ id?: string }> };
		const entries = Array.isArray(payload?.data) ? payload.data : [];
		return entries
			.map((m) => String(m?.id || ""))
			.filter(Boolean)
			.map((id) => ({ ...MODEL_BASE, id, name: id }));
	} catch {
		return [];
	}
}

function saveModelsCache(models: ProviderModelConfig[]): void {
	try {
		fs.mkdirSync(STATE_DIR, { recursive: true });
		fs.writeFileSync(MODELS_CACHE_FILE, JSON.stringify({ savedAt: Date.now(), models }));
	} catch {
		// ignore
	}
}

function loadModelsCache(): ProviderModelConfig[] {
	try {
		const data = JSON.parse(fs.readFileSync(MODELS_CACHE_FILE, "utf8"));
		if (Array.isArray(data?.models)) {
			return data.models.filter((m: ProviderModelConfig) => typeof m?.id === "string");
		}
	} catch {
		// no cache
	}
	return [];
}

/** Start the bridge from this package, detached, and wait for `/health`. */
async function startBridge(port: number): Promise<BridgeState> {
	fs.mkdirSync(STATE_DIR, { recursive: true });
	const out = fs.openSync(LOG_FILE, "a");
	const child: ChildProcess = spawn(process.env.OPENCODE_BRIDGE_BUN || "bun", ["server.ts"], {
		cwd: PACKAGE_ROOT,
		env: {
			...process.env,
			PORT: String(port),
			HOST,
			OPENCODE_BRIDGE_STATE_DIR: STATE_DIR,
		},
		detached: true,
		stdio: ["ignore", out, out],
	});
	child.unref();
	fs.closeSync(out);

	const deadline = Date.now() + START_TIMEOUT_MS;
	while (Date.now() < deadline) {
		const health = await healthz(port);
		if (health) {
			const state: BridgeState = { port, pid: child.pid, startedAt: Date.now() };
			writeState(state);
			log.info("bridge_started", { port, pid: child.pid });
			return state;
		}
		if (child.pid && !pidAlive(child.pid)) break;
		await new Promise((r) => setTimeout(r, 250));
	}
	const message = `opencode-free-bridge did not answer /health on ${HOST}:${port} within ${START_TIMEOUT_MS}ms`;
	log.error("bridge_start_failed", { port, timeoutMs: START_TIMEOUT_MS, error: message });
	throw new Error(`${message} — inspect ${LOG_FILE}`);
}

/** Reuse a healthy bridge, else start one. */
async function ensureBridge(port: number): Promise<BridgeState> {
	const state = readState();
	if (state && (await healthz(state.port))) {
		log.info("bridge_reused", { port: state.port });
		return { ...state, port: state.port };
	}
	if (await healthz(port)) return { port };
	return startBridge(port);
}

function stopBridge(): boolean {
	const state = readState();
	if (!state?.pid || !pidAlive(state.pid)) {
		log.info("bridge_stop_skipped", { port: state?.port || port });
		return false;
	}
	try {
		process.kill(state.pid);
		log.info("bridge_stopped", { port: state.port, pid: state.pid });
		return true;
	} catch (err) {
		log.warn("bridge_stop_failed", { port: state.port, error: (err as Error).message });
		return false;
	}
}

function tailLog(lines: number): string {
	try {
		const text = fs.readFileSync(LOG_FILE, "utf8").trimEnd().split(/\r?\n/);
		return text.slice(-lines).join("\n");
	} catch {
		return "(no log yet — the bridge logs to " + LOG_FILE + ")";
	}
}

export default async function (pi: ExtensionAPI): Promise<void> {
	let port = DEFAULT_PORT;
	let models: ProviderModelConfig[] = loadModelsCache();

	const register = (list: ProviderModelConfig[], activePort: number): void => {
		pi.registerProvider(EXTENSION_NAME, {
			baseUrl: `http://${HOST}:${activePort}/v1`,
			apiKey: "public",
			api: "openai-completions",
			models: list,
			refreshModels: async () => {
				const fresh = await fetchModels(activePort);
				if (fresh.length > 0) {
					models = fresh;
					saveModelsCache(fresh);
				}
				log.info("models_refreshed", { count: fresh.length, port: activePort });
				return fresh;
			},
		});
		pi.setStatus?.(EXTENSION_NAME, `${list.length} free models via ${HOST}:${activePort}`);
		log.info("provider_registered", { models: list.length, port: activePort });
	};

	// Register with the cached list first so the provider exists even when the
	// bridge refuses to start, then discover for real: OMP resolves `--model`
	// before the first turn, so a background refresh would lose that race.
	register(models, port);

	const refresh = async (): Promise<void> => {
		const state = await ensureBridge(port);
		port = state.port;
		const fresh = await fetchModels(port);
		if (fresh.length > 0) {
			models = fresh;
			saveModelsCache(fresh);
		}
		log.info("models_refreshed", { count: fresh.length, port });
		register(models, port);
	};

	try {
		await refresh();
	} catch (err) {
		log.error("extension_init_failed", { error: (err as Error).message });
		pi.ui.notify(`${EXTENSION_NAME}: ${(err as Error).message}`, "warning");
	}

	pi.registerCommand(EXTENSION_NAME, {
		description:
			"opencode-free-bridge provider: status | models | refresh-models | start | stop | restart | health | logs | help",
		getArgumentCompletions: (prefix: string) =>
			["status", "models", "refresh-models", "start", "stop", "restart", "health", "logs", "help"]
				.filter((s) => s.startsWith(prefix))
				.map((s) => ({ value: s, label: s })),
		handler: async (args, ctx) => {
			const sub = String(args || "").trim().split(/\s+/)[0] || "status";
			const notify = (message: string, level = "info") =>
				(ctx?.ui?.notify ? ctx.ui.notify(message, level) : pi.ui.notify(message, level));
			log.info("command_invoked", { action: sub });
			switch (sub) {
				case "status": {
					const health = await healthz(port);
					log.info("bridge_health_checked", { action: "status", online: Boolean(health), runtime: health ? String(health.runtime || "unknown") : undefined, version: health ? String(health.version || "?") : undefined });
					notify(
						`${EXTENSION_NAME}: bridge ${health ? `online ${HOST}:${port}` : "offline"} · models=${models.length} · ` +
							`runtime=${String(health?.runtime || "unknown")} · version=${String(health?.version || "?")}`
					);
					break;
				}
				case "models": {
					notify(
						models.length > 0
							? models.map((m) => `${EXTENSION_NAME}/${m.id}`).join("\n")
							: "no models yet — /opencode-free refresh-models"
					);
					break;
				}
				case "refresh-models": {
					await refresh();
					notify(`re-registered ${models.length} model(s) from ${HOST}:${port}`);
					break;
				}
				case "start": {
					const state = await ensureBridge(port);
					port = state.port;
					notify(`bridge ${HOST}:${port} is ${state.pid ? "started by the plugin" : "already running"}`);
					break;
				}
				case "stop": {
					const stopped = stopBridge();
					notify(stopped ? "bridge stopped" : "no bridge started by the plugin (it may be running elsewhere)", "warning");
					break;
				}
				case "restart": {
					stopBridge();
					await new Promise((r) => setTimeout(r, 500));
					const state = await ensureBridge(port);
					port = state.port;
					await refresh();
					log.info("bridge_restarted", { port });
					break;
				}
				case "health": {
					const health = await healthz(port);
					log.info("bridge_health_checked", { action: "health", online: Boolean(health), runtime: health ? String(health.runtime || "unknown") : undefined, version: health ? String(health.version || "?") : undefined });
					notify(health ? JSON.stringify(health, null, 2).slice(0, 4000) : `no /health answer on ${HOST}:${port}`, health ? "info" : "warning");
					break;
				}
				case "logs": {
					notify(tailLog(40));
					break;
				}
				case "help":
				default: {
					notify(
						[
							`${EXTENSION_NAME} — OpenCode free-tier models for OMP`,
							"  /opencode-free status          bridge + provider state",
							"  /opencode-free models          registered model ids",
							"  /opencode-free refresh-models  re-read /v1/models",
							"  /opencode-free start|stop|restart",
							"  /opencode-free health          raw /health JSON",
							"  /opencode-free logs            tail " + LOG_FILE,
							`Use: omp --model ${EXTENSION_NAME}/<model-id> -p "hello"`,
						].join("\n")
					);
					break;
				}
			}
		},
	});
}

// Exported for tests: the plugin's own promise surface, no OMP needed.
export { ensureBridge, fetchModels, healthz, startBridge, stopBridge, DEFAULT_PORT };
