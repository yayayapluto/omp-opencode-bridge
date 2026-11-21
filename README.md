# omp-opencode-bridge

Keyless [OpenCode](https://opencode.ai) free-tier models for an OMP (`omp`) session. The package is two
things in one: an OMP/pi plugin that registers an `opencode-free` provider, and a local Bun bridge on
`http://127.0.0.1:20129/v1` that any OpenAI- or Anthropic-compatible client can call.

No account, no API key (the key is literally `public`), no runtime dependencies — Node builtins only.

## Table of Contents

- [Features](#features)
- [Requirements](#requirements)
- [Install](#install)
  - [Step 1 — Install Bun (prerequisite)](#step-1--install-bun-prerequisite)
  - [Step 2 — Install the plugin into OMP](#step-2--install-the-plugin-into-omp)
  - [Step 3 — Verify it loaded](#step-3--verify-it-loaded)
  - [Standalone bridge (no OMP)](#standalone-bridge-no-omp)
  - [Service installer (Linux/macOS)](#service-installer-linuxmacos)
  - [Docker](#docker)
- [Usage](#usage)
  - [Daily flow](#daily-flow)
  - [Asking the model](#asking-the-model)
  - [`/opencode-free`](#opencode-free)
  - [Reading the health fields](#reading-the-health-fields)
  - [Common prompts](#common-prompts)
- [What it reads](#what-it-reads)
- [Architecture](#architecture)
- [Development](#development)
- [Troubleshooting](#troubleshooting)
- [Security notes](#security-notes)
- [License](#license)

## Features

- **`opencode-free` provider** — `omp plugin install` registers every active free model, so a session
  uses them with no key and no separate server setup. Models are re-read from the bridge's `/v1/models`.
- **OpenAI-compatible bridge** — `POST /v1/chat/completions`, `GET /v1/models`, plus `/chat/completions`
  and `/models` aliases, on `127.0.0.1:20129` by default.
- **Anthropic Messages API** — `POST /v1/messages` (and `/messages`) with real SSE streaming, so Claude
  Code and the Anthropic SDK can point at the same port. `POST /v1/messages/count_tokens` answers from a
  4-chars-per-token estimate.
- **Self-healing identity** — the CLI version, commit SHA, gate headers, session-ID recipe, tool profile
  and inference endpoints are derived from OpenCode's update API, GitHub source tree and model catalog,
  not hardcoded. A `403`/`426`/`404` triggers one refresh-and-retry.
- **Live catalog with an on-disk cache** — free models (`cost.input === 0`, not deprecated) and their
  reasoning/output limits come from `models.opencode.ai/api.json`, cached at
  `~/.opencode-free-bridge/cache/catalog.json` for cold starts and offline use.
- **Reasoning-aware token budget** — a reasoning model's `max_completion_tokens` gets an additive floor so
  small probes do not return empty content with `finish_reason: "length"`; thinking tokens are emitted as
  `reasoning_content` in both streaming and non-streaming responses.
- **Tool-name compatibility** — a client tool whose name matches OpenCode's blocked pattern is sent as
  `run_program` and restored to the client's name on the way back; colliding `read` tools are de-collided.
- **Egress control** — a browser panel on `/` sets an HTTP proxy, an ordered pool of egress entries, or
  routes through a relay, without restarting the bridge.
- **Verification tooling** — `verify.ts` probes models with real prompts, `gate-drill.ts` corrupts the
  identity on purpose and checks self-healing, `transport-fingerprint.ts` compares the runtime's TLS
  ClientHello with the recorded OpenCode CLI baseline.

## Requirements

- **Bun 1.0 or newer** to serve live traffic (`package.json` → `"engines": { "bun": ">=1.0.0" }`). The
  free-tier gate inspects the TLS `ClientHello`, and only Bun reproduces the OpenCode CLI's transport.
  Starting `server.ts` under Node exits with an explanation; `ALLOW_NODE=1` bypasses that guard for
  offline tests only.
- **Node 24.x** is supported only for the test suite (`npm run test:node`, type stripping).
- **Linux (systemd) or macOS (launchd)** for the service installer. Windows is not supported by the
  installer; the bridge itself runs under Bun anywhere.
- **OMP (`omp` CLI) with extension support** for the plugin route. `@earendil-works/pi-coding-agent` is
  an optional peer dependency, declared as a structural type in the extension, so it need not be installed.
- **Docker + Compose** optionally, for the container route.

## Install

### Step 1 — Install Bun (prerequisite)

```bash
curl -fsSL https://bun.sh/install | bash
bun --version
```

### Step 2 — Install the plugin into OMP

From npm (published, current `2.6.0`):

```bash
omp plugin install omp-opencode-bridge
```

Or link a working tree — including uncommitted files:

```bash
git clone https://github.com/yayayapluto/omp-opencode-bridge.git
cd omp-opencode-bridge
omp plugin install .
```

Either way the extension is `src/index.ts` (declared under `"pi": { "extensions": ["./src/index.ts"] }`).
On session start it reuses a bridge already listening on the port, otherwise spawns
`bun server.ts` from the package root, detached, logging to `~/.opencode-free-bridge/omp-plugin.log`.

Plugin settings:

| Variable | Default | Meaning |
|---|---|---|
| `OPENCODE_BRIDGE_PORT` | `20129` | Port the plugin probes and starts the bridge on |
| `OPENCODE_BRIDGE_BUN` | `bun` | Bun binary used to spawn `server.ts` |
| `OPENCODE_BRIDGE_STATE_DIR` | `~/.opencode-free-bridge` | State, log and model-cache directory |

### Step 3 — Verify it loaded

```bash
omp plugin list | grep opencode-free
curl -s http://127.0.0.1:20129/health
```

`/health` must answer `"status":"ok"` with a `"runtime":"bun/..."`. Then run the self-check from the
installed package (or the clone):

```bash
bun verify.ts --quick
```

```text
opencode-free-bridge — self check
http://127.0.0.1:20129

  OK  bridge v2.6.0, 11 free models discovered

  egress: direct (this machine's IP)

  Probing 3 of 11 models (quick — stops at the first success)...

  OK   big-pickle                             2.1s  2 chars, 54 tokens

Summary
  1 usable, 0 blocked by upstream (0 gate-closed, 0 rate-limited), 0 broken

  Bridge is working. Point any OpenAI-compatible client at http://127.0.0.1:20129/v1
```

Exit code `0` = a model answered, `2` = bridge healthy but the IP is refused upstream (cooldown or abuse
block — the official CLI gets the same answer), `1` = real failure.

### Standalone bridge (no OMP)

```bash
npm install -g omp-opencode-bridge
opencode-free-bridge
```

The `opencode-free-bridge` bin is `server.ts` with a Bun shebang. From a clone, equivalently:

```bash
bun server.ts
```

Options: `PORT` (default `20129`), `HOST` (default `127.0.0.1`).

### Service installer (Linux/macOS)

```bash
bash install.sh
```

Finds or installs Bun (and `unzip` on minimal Linux), stages and validates every file before touching a
running bridge, backs up the previous install under `~/.opencode-free-bridge/.backup-*`, registers a
systemd unit (Linux) or launchd agent (macOS), waits up to 20 s for `/health`, then runs the quick
self-check and the TLS fingerprint check. It prints `Done.` only when the bridge answered.

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `20129` | Listen port; an occupied port aborts before anything changes |
| `HOST` | `127.0.0.1` | Bind address |
| `BINDIR` | `~/.opencode-free-bridge` | Install directory |
| `NO_SERVICE` | `0` | `1` installs files only, no systemd/launchd unit |
| `SOURCE` | `auto` | `auto` installs the local tree when run from a clone, else downloads |
| `REPO` | `azrinaldi/opencode-free-bridge` | Source repository for the remote path |

Running instances outside a git checkout check this repository for updates every 6 hours
(`AUTO_UPDATE=0` disables that).

### Docker

```bash
docker compose up -d
```

The image pins `oven/bun:1.4.3-slim` (the TLS baseline is tied to that Bun build), runs as the non-root
`bun` user, publishes `127.0.0.1:20129` on loopback only, and keeps the catalog cache and egress state in
the `bridge-cache` / `bridge-state` volumes. Upgrade with `docker compose build --pull && docker compose up -d`.

## Usage

### Daily flow

```bash
# 1. bridge up (the OMP plugin does this on session start)
bun server.ts

# 2. see what the catalog currently offers
curl -s http://127.0.0.1:20129/v1/models

# 3. one request, OpenAI shape
curl -s http://127.0.0.1:20129/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"big-pickle","messages":[{"role":"user","content":"Reply with the single word OK"}],"max_tokens":64}'
```

```json
{"id":"chatcmpl-…","object":"chat.completion","created":1795238343,"model":"big-pickle","choices":[{"index":0,"message":{"role":"assistant","content":"OK","reasoning_content":"…"},"finish_reason":"stop"}],"usage":{"prompt_tokens":797,"completion_tokens":31,"total_tokens":828}}
```

The Anthropic shape works on the same port:

```bash
curl -s http://127.0.0.1:20129/v1/messages \
  -H 'Content-Type: application/json' -H 'x-api-key: public' \
  -d '{"model":"big-pickle","max_tokens":64,"messages":[{"role":"user","content":"Reply with OK"}]}'
```

```json
{"id":"msg_…","type":"message","role":"assistant","model":"big-pickle","content":[{"type":"text","text":"OK"}],"stop_reason":"end_turn","stop_sequence":null,"usage":{"input_tokens":794,"output_tokens":12}}
```

Any OpenAI-compatible client uses the same three settings:

| Setting | Value |
|---|---|
| Base URL | `http://127.0.0.1:20129/v1` |
| API key | `public` (any non-empty string) |
| Model | any id from `GET /v1/models` |

Model IDs and family shorthands are derived from the upstream catalog, so they change with it — query
`/v1/models` instead of hardcoding. Requests for retired or paid models are rejected locally with `404`:

```json
{"error":{"message":"Model 'claude-sonnet-4-5' is not on the free tier, and this bridge has no account to run it with. Free models are listed at /v1/models.","type":"invalid_request_error","param":"model","code":"model_not_free"}}
```

### Asking the model

```bash
omp --model opencode-free/big-pickle -p "hello"
omp --model opencode-free/mimo-v2.6-flash-free -p "summarize this diff"
```

Inside an interactive session, `/opencode-free models` lists what is registered.

### `/opencode-free`

| Subcommand | Effect |
|---|---|
| `status` | bridge online/offline, model count, runtime and version |
| `models` | the registered `opencode-free/<id>` ids |
| `refresh-models` | re-read `GET /v1/models` and re-register the provider |
| `start` | reuse a healthy bridge or spawn one (20 s `/health` deadline) |
| `stop` | stop only a bridge this plugin spawned |
| `restart` | stop, respawn, re-register |
| `health` | raw `/health` JSON |
| `logs` | last 40 lines of `~/.opencode-free-bridge/omp-plugin.log` |
| `help` | the list above |

### Reading the health fields

```bash
curl -s http://127.0.0.1:20129/health
```

| Field | Meaning |
|---|---|
| `status` | `ok` when the server is answering |
| `version` / `runtime` | bridge version and `bun/<version>` or `node/<version>` |
| `discoveredModels` | free models the current catalog produced |
| `egress.mode` | what carries requests: `pool`, `proxy`, `relay`, or `direct` |
| `egress.proxy` | credential-free description: `mode`, `proxy` (`host:port`), `source`, `locked`, `configPath` |
| `egress.proxy.pool` | pool `size`/`enabled`/`ready`/`cooling`, `strategy`, cooldown bounds, per-entry state |
| `egress.usage` | per-egress request counts and token totals for the current day |
| `identity.userAgent` | the derived `opencode/<channel>/<version>/<cli>` |
| `identity.sourceTag` | the GitHub commit SHA the recipe came from |
| `identity.headers` / `unsentHeaders` | gate headers sent, and any expected but unsent |
| `identity.endpoints` | resolved `chatUrl`, `responsesUrl`, `modelsUrl`, `catalogBase` |
| `identity.toolNames` | tools the derived profile allows on the wire |

### Common prompts

| You want | Prompt |
|---|---|
| Confirm the bridge end to end | `bun verify.ts --quick` (or `npm run verify:quick`) |
| Confirm TLS parity | `bun transport-fingerprint.ts --check` |
| Prove self-healing works | `bun gate-drill.ts` (offline drills at minimum) |
| Check which IP upstream sees | open `http://127.0.0.1:20129/`, **Uji koneksi** |
| Diagnose a `403` | `/opencode-free health`, then read `identity.gate` |
| List models a client can use | `curl -s http://127.0.0.1:20129/v1/models` |

## What it reads

Environment (read in `server.ts`, `identity.ts`, `proxy.ts`, `token-budget.ts`, `src/index.ts`):

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `20129` | HTTP listen port |
| `HOST` | `127.0.0.1` | Bind address |
| `CORS_ORIGIN` | `""` (loopback only) | Allowed origins, comma-separated or `*` |
| `UPSTREAM_TIMEOUT_MS` | `120000` | Upstream fetch timeout |
| `MAX_BODY_BYTES` | `10485760` | Request body cap (10 MiB) |
| `IDENTITY_TTL_MS` | `900000` | Identity freshness TTL |
| `UPDATE_MODE` | `reactive` | `reactive` adopts releases on `403`/`426` or `minimum: true`; `always` on TTL |
| `GATE_RETRY_COOLDOWN_MS` | `30000` | Suppress duplicate `403` retries for this window |
| `GATE_REFRESH_COOLDOWN_MS` | `30000` | Minimum gap between forced refreshes during a `403` burst |
| `DNS_RESULT_ORDER` | `ipv4first` | `dns.setDefaultResultOrder` value; the gateway refuses IPv6 egress |
| `TOOL_PROFILE_SCOPE` | `core` | `core` sends the minimal gate anchors first, `full` sends the whole profile |
| `OPENCODE_CHANNEL` | `latest` | Release channel: `latest`, `beta`, `dev` |
| `OPENCODE_MAJOR` | unset | Pin a major version line |
| `OPENCODE_USER_AGENT` | derived | Override the UA and disable derivation |
| `OPENCODE_CATALOG_URL` | `https://models.opencode.ai/api.json` | Catalog source |
| `OPENCODE_CACHE_DIR` | `~/.opencode-free-bridge/cache` | On-disk catalog cache (`off` disables) |
| `OPENCODE_CHAT_URL` / `OPENCODE_RESPONSES_URL` | derived | Override inference endpoints |
| `UPSTREAM_RELAY_URL` | unset | Send inference through a relay (`x-relay-target` / `x-relay-path`) |
| `UPSTREAM_PROXY_URL` | unset | Operator-level egress proxy; locks panel edits |
| `UPSTREAM_PROXY_POOL` | unset | Pool entries, comma/newline separated, `label=url` optional |
| `UPSTREAM_PROXY_STRATEGY` | `round-robin` | `round-robin`, `failover`, `random` |
| `PANEL_ALLOWED_HOSTS` | unset | Extra `Host` names accepted by the panel and `/api/proxy` |
| `AUTO_UPDATE` | `1` | Check for bridge updates every 6 h (skipped in a `.git` checkout) |
| `ALLOW_NODE` | unset | `1` bypasses the Bun runtime guard (offline tests only) |

State and caches under `~/.opencode-free-bridge` (or `OPENCODE_BRIDGE_STATE_DIR`):

| Path | Written by | Contents |
|---|---|---|
| `cache/catalog.json` | `identity.ts` | Upstream model catalog for cold starts |
| `proxy.json` | `proxy.ts` / panel | Egress proxy, pool and strategy (mode `0600`) |
| `pool-health.json` | `proxy.ts` | Per-egress cooldowns, keyed by hashed egress identity |
| `omp-plugin.json` | `src/index.ts` | Port and pid of the bridge the plugin spawned |
| `omp-models.json` | `src/index.ts` | Last discovered model list, used before the bridge starts |
| `omp-plugin.log` | spawned bridge | Bridge stdout/stderr when started by the plugin |

Ports: `20129` (bridge + panel). `egress-proxy.ts` listens on `PORT` (default `8888`) when run as a pool
member. `/healthz` on that proxy is unauthenticated and reports only connection count and uptime.

Side effects: writes only the files above; outbound HTTPS to the OpenCode update API, GitHub raw/tree
endpoints, `models.opencode.ai` and the inference endpoints; with `AUTO_UPDATE=1`, downloads and
hot-swaps updated bridge files (syntax-checked first) inside the install directory.

## Architecture

```text
omp-opencode-bridge/
├── server.ts                  # HTTP server: routing, panel, gate retries, protocol lanes
├── identity.ts                # derives CLI identity, headers, session IDs, tool profile, catalog
├── token-budget.ts            # reasoning-aware max_completion_tokens floor
├── anthropic.ts               # Anthropic Messages API <-> OpenAI translation
├── proxy.ts                   # egress proxy, pool, health persistence, usage counters
├── egress-proxy.ts            # dependency-free CONNECT/absolute-URI proxy for pool members
├── panel.ts                   # HTML/JSON for the browser panel
├── transport-fingerprint.ts   # TLS ClientHello dump/compare against transport-baseline.json
├── verify.ts                  # real-prompt self check, exit 0/1/2
├── gate-drill.ts              # live + offline self-healing drills
├── tunnel-doctor.sh           # diagnose/reap stale ssh -R forwarders
├── install.sh                 # Bun discovery, staged install, systemd/launchd unit
├── src/index.ts               # OMP/pi extension: provider registration + /opencode-free
├── test/                      # bun test suites (server, identity, proxy, retry, drills, …)
├── Dockerfile, docker-compose.yaml
└── package.json
```

```text
OMP session ──▶ src/index.ts ──spawns──▶ server.ts (:20129)
                                            │
client ──POST /v1/chat/completions──▶ bridge ──▶ opencode.ai/inference/openai/v1/…
   or  ──POST /v1/messages──────▶ anthropic.ts ──┘        ▲
                                                          │
identity.ts: update API → GitHub source (recipe, tools) ──┤
               models.opencode.ai/api.json (catalog) ──────┤
on 403/426/404: refresh → evict stale session ▸ mint new ▸ escalate tools ▸ retry once
```

The bridge holds no model code: every model id, limit and endpoint is resolved per request from the
catalog/recipe, which is why a retired upstream model turns into a local `404` and an endpoint move
heals on the first retry.

## Development

```bash
bun test                          # unit, contract and regression suites
npm run drill                     # live + offline self-healing gate drills
npm run verify                    # probe every discovered free model
npm run verify:quick              # stop at the first model that answers
npm run fingerprint:check         # TLS ClientHello vs transport-baseline.json
npm run test:node                 # Node 24 compatibility pass (type stripping)
```

`gate-drill.ts` accepts drill names as arguments; the offline drills (`routing`, `allowlist`,
`retry-endpoint`, `endpoint-move`, `gate-heal`, `full-corrupt`) never touch the network, which is why CI
runs `bun gate-drill.ts`. The four live drills are skipped (not failed) when a CLI-shaped control probe is
refused, so a throttled IP does not turn CI red.

CI (`.github/workflows/ci.yml`) runs `bun test test/*.test.js`, `bun gate-drill.ts` and
`bun transport-fingerprint.ts --check` on Bun, plus a Node 24 compatibility job.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `server.ts` exits printing "requires Bun" | Started with Node; the gate refuses Node's TLS `ClientHello` | Run `bun server.ts`; install Bun from `bun.sh` |
| `403 FreeTierError` right after a retry | IP-level free-tier cooldown, not a shape bug | Wait out the window (`GATE_RETRY_COOLDOWN_MS`), or change egress (tunnel, proxy, another host) |
| `403` mentioning "abusive traffic" / `Detect Abuse Traffic` | Gateway flagged the egress IP; reported as `identity.gate.status: "ip-blocked"` | Not fixable locally — change egress or contact upstream with `x-opencode-log-id` |
| `426 UpgradeRequired` | Derived version below the floor | Self-heals on retry; if it persists check `identity.available` |
| `429 FreeUsageLimitError` | Allowance spent, `tools: []`, or a system prompt without the `<env>` block | Use `TOOL_PROFILE_SCOPE=full`; the bridge appends the `<env>` anchor itself in 2.6.0 |
| `429 RateLimitError` / `BUSY` | Per-model or per-IP throttling upstream | Try another id from `/v1/models` |
| `404` "is not on the free tier" / "has been retired upstream" | Model is paid or deprecated in the catalog | Pick a current id from `/v1/models` |
| `verify.ts` exits `2` | Bridge healthy, TLS fine, upstream refuses this IP | Same answer as the official CLI from this IP; change egress or wait |
| `verify.ts` exits `1` | Bridge unreachable, running on Node, or TLS drift | `curl /health`, check `bun transport-fingerprint.ts --check` |
| `omp` starts but `opencode-free` has no models | Bridge never came up; only the cached list was registered | `/opencode-free start`, then `/opencode-free logs` |
| `opencode-free-bridge did not answer /health … within 20000ms` | Spawned Bun failed (missing binary, port busy, bad cwd) | Set `OPENCODE_BRIDGE_BUN` to an absolute bun path; read `~/.opencode-free-bridge/omp-plugin.log` |
| Panel refuses a proxy URL with `UnsupportedProxyProtocol` | SOCKS5 is not accepted by Bun's fetch | Use `http://` or `https://` (`http://user:pass@host:port`) |
| Panel answers `403`, `Host` rejected | Request came from a non-loopback name or a rebinding attempt | Add the proxy's name to `PANEL_ALLOWED_HOSTS` |
| `remote port forwarding failed for listen port 20136` | Stale `ssh -R` listener on the receiving host | `./tunnel-doctor.sh --reap`, and shorten `ClientAliveInterval` on the receiver |
| `bun: command not found` in a fresh SSH session | `~/.bun/bin` is only on an interactive shell's PATH | `export PATH="$HOME/.bun/bin:$PATH"` or use the absolute path |

## Security notes

- **No authentication.** The API key is the literal string `public`; anyone who can reach the port can
  spend the free-tier allowance. Keep `HOST=127.0.0.1` (the default) or put a real gateway in front.
- **Loopback-only panel.** `/`, `/api/proxy` and `/api/proxy/test` accept loopback names (or the bind
  address) plus `PANEL_ALLOWED_HOSTS`; writes require `Content-Type: application/json` and cross-site
  requests are refused, so a random page cannot re-point your egress.
- **Credentials stay local.** Proxy credentials are stored in `proxy.json` with mode `0600` and never
  appear in `/health`, the panel, or API responses — only `host:port` is reported. `pool-health.json` keys
  records by a truncated hash, not by URL.
- **The relay sees plaintext.** `UPSTREAM_RELAY_URL` is trusted with request headers (including the
  authorization value) and the full prompt. Prefer a relay you operate.
- **The self-updater writes code.** With `AUTO_UPDATE=1` it downloads from this repository and swaps files
  in the install directory after syntax-checking them; set `AUTO_UPDATE=0` in containers or where the
  install directory must stay immutable.
- **Third-party prompts.** `identity.ts` reproduces OpenCode's tool descriptions and schema fields; see
  [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md).

## License

[MIT](./LICENSE). `identity.ts` derives request identity and tool metadata from the
[OpenCode source repository](https://github.com/anomalyco/opencode); the OpenCode MIT notice and
contributor credit are in [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md).
