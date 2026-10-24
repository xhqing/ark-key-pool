<div align="center">
  <img src="assets/logo.svg" alt="ark-key-pool" width="640">

  [![License: MIT](https://img.shields.io/badge/License-MIT-yellow)](LICENSE.md)
  [![Version](https://img.shields.io/badge/Version-0.1.0-blue)](CHANGELOG.md)
  [![Type](https://img.shields.io/badge/Type-pi%20extension-6E56CF)](#)

  [简体中文](README_cn.md)
</div>

# ark-key-pool

> Multi-key failover for Volcengine Ark Agent Plan in [pi](https://pi.dev) — when one account's key runs out or gets rejected, requests continue on the next one, automatically.

A pi extension that turns a single-credential provider into a key pool: every request uses the first healthy key, failures cool that key down (shared across processes), and pi's own retry loop carries the request onto the next account.

## Why

pi stores **one credential per provider** (`auth.json` holds a single key), and nothing in the core rotates or fails over between keys. Volcengine Ark Agent Plan returns:

- `429 AccountQuotaExceeded` when the 5-hour / weekly quota is used up;
- `401` when a key is invalid or revoked.

pi retries the same key three times and then gives up. With two accounts, that means a dead key keeps failing while the other account sits idle.

## Install

```bash
./install.sh
```

The script deploys `ark-key-pool.ts` to `~/.pi/agent/extensions/` and, if no config exists yet, copies the template to `~/.pi/agent/ark-agent-plan-keys.json` with `0600` permissions. Run `/reload` in pi (or start a new session) to load it.

## Configure

```json
{
  "provider": "volcengine-agent-plan",
  "keys": [
    { "name": "main-account", "key": "sk-..." },
    { "name": "backup-account", "key": "sk-..." }
  ],
  "cooldown": {
    "authSeconds": 600,
    "rateLimitSeconds": 60,
    "quotaSeconds": 1800,
    "maxSeconds": 86400
  },
  "retryAuthErrors": true
}
```

- **At least two keys** are required; with one key (or no config) the extension stays out of the way.
- Keys are used in order: the backup is only touched while the primary is cooling down, and the primary comes back automatically when the cooldown expires.
- `quotaSeconds` is the **starting** quota cooldown (30 minutes by default): each time the same key hits a quota error on the same model, the cooldown doubles (30 min → 1 h → 2 h …), never exceeding the response's `reset at` time or `maxSeconds` (one day by default). Observed in practice: the same key answered "weekly usage quota exceeded" and then served requests again ten minutes later, so benching it for a full day would take the whole pool down; genuinely exhausted keys climb to day-level cooldowns within a few hits.
- `retryAuthErrors: false` disables the 401/403 rewrite; a dead key is then only replaced on the next request.

`auth.json` (or `ARK_AGENT_PLAN_API_KEY`) must still hold **one** Agent Plan key, because pi validates provider credentials before the extension's header hook runs. The pool overrides that key on every request, so the two may be the same.

> The config holds real credentials: it is `0600` and lives outside the repository. Never commit it.

## Cooldown scope

| Error | Scope | Why |
|---|---|---|
| `401` / `403` (invalid key) | whole key | the key itself is unusable, skip it for every model |
| `429 AccountRateLimitExceeded` (rate limit) | whole key | rate limits are per account, not per model |
| `429 AccountQuotaExceeded` (quota) | **that key, that model** | quota turned out to be tracked per model: one exhausted model does not stop the same key from serving other models |

A successful request clears that key's cooldown (and its doubling counter) for the model it just served.

## How it works

| Hook | What it does |
|---|---|
| `before_provider_headers` | Picks a key from the pool and overwrites `Authorization` (healthy keys first; when everything is cooling, the soonest-recovering one — **never a silent fallback to the `auth.json` key**) |
| `message_end` | Classifies 401/403/429 and cools the key that **actually served this request** (persisted, shared across processes); a success clears that key's cooldown |
| `before_agent_start` | Clears the per-turn "already tried" set |

Two mechanisms make the failover automatic:

1. **Quota exhaustion** already produces a retryable error (`429`), so pi's retry re-enters `before_provider_headers`, which now selects the next key.
2. **Auth failures** (`401`/`403`) are not retried by pi. The extension rewrites `errorMessage` into a retryable shape (prefixed with `429`), so pi's retry loop continues on the next key.

When no key is usable, the extension appends the pool status to the error (e.g. `429 rate limit (ark-key-pool: key "backup" no healthy key left — main=quota 23h58m, backup=rate 45s): …`), so you no longer have to dig through logs to see which key is stuck.

## Commands

```
/ark-key-pool          # show key status (whole-key cooldowns and per-model quota cooldowns)
/ark-key-pool reset    # clear all cooldowns
```

## State and logs

- State: `~/.pi/agent/state/ark-key-pool.json` — stores only a SHA-256 prefix of each key, never the key itself.
- Log: `~/.pi/agent/state/ark-key-pool.log` — truncated to the last 2000 lines past 1 MB.

Cooldowns are stored on disk, so several pi processes sharing the same pool skip a key that another process already found dead.

## Limitations

- Only affects `volcengine-agent-plan`; other providers are untouched.
- Does not change model visibility: the model list follows the tier of the key in `auth.json`. Calling a model the backup account does not have fails with 401/403 and cools that key down — expected behaviour.
- Retry detection relies on pi's error-text matching (`429` and friends), which is an internal convention; re-verify after a major pi upgrade.
- Quota cooldowns are recorded per model, using the model of the request that failed. If an account's quota happens to be shared across models, a per-model cooldown is the conservative choice: it costs an extra attempt instead of benching the whole key.
- Cooldowns are keyed by key hash, so replacing a key leaves a stale entry behind (harmless).

## Verify it yourself

```bash
bash verify/run-tests.sh
```

Runs five scenarios against a local mock (normal, quota exhaustion, auth failure, both exhausted, quota cooldown scoped to one model) — no real quota is consumed.

## License & Attribution

Copyright (c) 2026 All Contributors. Released under the [MIT License](LICENSE.md).

Attribution: if you use or reference this project, please keep the copyright notice and credit the source: [ark-key-pool](https://github.com/xhqing/ark-key-pool).
