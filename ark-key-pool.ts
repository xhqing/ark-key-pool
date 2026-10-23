/**
 * Agent Plan Key 池（A2 方案）：为 volcengine-agent-plan 提供多 Key 自动切换。
 *
 * 原理：
 *   1. before_provider_headers 里把 Authorization 换成池中当前可用的 Key；
 *   2. message_end 里识别 401/403（Key 失效）与 429（额度耗尽 / 限流），给该 Key 写冷却；
 *   3. 401/403 原本不会被 pi 重试，这里把 errorMessage 改写成可重试形态（带 429），
 *      让 pi 的自动重试带着「下一个 Key」继续跑。
 *
 * 配置：~/.pi/agent/ark-agent-plan-keys.json（0600）
 * 状态：~/.pi/agent/state/ark-key-pool.json（跨进程共享冷却）
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const AGENT_DIR = path.join(os.homedir(), ".pi", "agent");
const CONFIG_PATH =
	process.env.ARK_KEY_POOL_CONFIG ?? path.join(AGENT_DIR, "ark-agent-plan-keys.json");
const STATE_PATH =
	process.env.ARK_KEY_POOL_STATE ?? path.join(AGENT_DIR, "state", "ark-key-pool.json");
const LOG_PATH = process.env.ARK_KEY_POOL_LOG ?? path.join(AGENT_DIR, "state", "ark-key-pool.log");
const PROVIDER = process.env.ARK_KEY_POOL_PROVIDER ?? "volcengine-agent-plan";

const DEFAULT_COOLDOWN = {
	authSeconds: 600,
	rateLimitSeconds: 60,
	quotaSeconds: 1800,
	maxSeconds: 86_400,
};

interface PoolKey {
	name: string;
	key: string;
}

interface PoolConfig {
	provider?: string;
	keys: PoolKey[];
	cooldown?: Partial<typeof DEFAULT_COOLDOWN>;
	retryAuthErrors?: boolean;
}

interface KeyState {
	name: string;
	cooldownUntil: number;
	reason?: string;
	lastError?: string;
}

interface PoolState {
	version: 1;
	keys: Record<string, KeyState>;
	updatedAt?: number;
}

interface Pick {
	hash: string;
	name: string;
	index: number;
}

const lastPick = new Map<string, Pick>();
const attempted = new Map<string, Set<string>>();
const lastError = new Map<string, string>();

function hashKey(key: string): string {
	return crypto.createHash("sha256").update(key).digest("hex").slice(0, 16);
}

function log(line: string): void {
	try {
		fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
		const stamp = new Date().toISOString();
		fs.appendFileSync(LOG_PATH, `${stamp} ${line}\n`);
		const st = fs.statSync(LOG_PATH);
		if (st.size > 1_048_576) {
			const lines = fs.readFileSync(LOG_PATH, "utf-8").split("\n").slice(-2000);
			fs.writeFileSync(LOG_PATH, lines.join("\n"));
		}
	} catch {
		// 日志失败不影响主流程
	}
}

function readJson<T>(file: string): T | undefined {
	try {
		return JSON.parse(fs.readFileSync(file, "utf-8")) as T;
	} catch {
		return undefined;
	}
}

function writeJsonAtomic(file: string, value: unknown, mode = 0o600): void {
	try {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		const tmp = `${file}.tmp-${process.pid}`;
		fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode });
		fs.renameSync(tmp, file);
		fs.chmodSync(file, mode);
	} catch (error) {
		log(`state write failed: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function loadConfig(): PoolConfig | undefined {
	const raw = readJson<PoolConfig>(CONFIG_PATH);
	if (!raw || !Array.isArray(raw.keys)) return undefined;
	const keys = raw.keys
		.filter((k): k is PoolKey => typeof k?.key === "string" && k.key.trim().length > 0)
		// 跳过模板占位符，避免 install.sh 刚创建的模板被当成真实 Key 发请求。
		.filter((k) => !/REPLACE_ME|^sk-\.\.\.$/i.test(k.key.trim()))
		.map((k, i) => ({ name: (k.name || `key${i + 1}`).trim(), key: k.key.trim() }));
	if (keys.length === 0) return undefined;
	return { ...raw, keys };
}

function cooldownConfig(cfg: PoolConfig) {
	return { ...DEFAULT_COOLDOWN, ...(cfg.cooldown ?? {}) };
}

function loadState(): PoolState {
	return readJson<PoolState>(STATE_PATH) ?? { version: 1, keys: {} };
}

function availableKeys(cfg: PoolConfig, state: PoolState): PoolKey[] {
	const now = Date.now();
	return cfg.keys.filter((k) => {
		const entry = state.keys[hashKey(k.key)];
		return !entry || entry.cooldownUntil <= now;
	});
}

function coolingKeys(cfg: PoolConfig, state: PoolState): Array<{ key: PoolKey; entry: KeyState }> {
	const now = Date.now();
	const out: Array<{ key: PoolKey; entry: KeyState }> = [];
	for (const k of cfg.keys) {
		const entry = state.keys[hashKey(k.key)];
		if (entry && entry.cooldownUntil > now) out.push({ key: k, entry });
	}
	return out;
}

function pickKey(sessionId: string): Pick | undefined {
	const cfg = loadConfig();
	if (!cfg || cfg.keys.length < 2) return undefined;

	const state = loadState();
	const tried = attempted.get(sessionId) ?? new Set<string>();
	const now = Date.now();

	// 优先：未冷却且本次序列没试过的 Key，按配置顺序。
	const fresh = cfg.keys.filter((k) => {
		const hash = hashKey(k.key);
		const entry = state.keys[hash];
		return !tried.has(hash) && (!entry || entry.cooldownUntil <= now);
	});
	const pick = fresh[0];

	if (!pick) {
		// 全部冷却或都试过：若有冷却中的，挑最早解冻的兜底（至少发得出请求）。
		const all = cfg.keys
			.map((k) => ({ k, entry: state.keys[hashKey(k.key)] }))
			.filter((x) => !tried.has(hashKey(x.k.key)))
			.sort((a, b) => (a.entry?.cooldownUntil ?? 0) - (b.entry?.cooldownUntil ?? 0));
		if (!all[0]) return undefined;
		const fallback = all[0].k;
		const result = { hash: hashKey(fallback.key), name: fallback.name, index: cfg.keys.indexOf(fallback) };
		lastPick.set(sessionId, result);
		tried.add(result.hash);
		attempted.set(sessionId, tried);
		log(`pick#fallback session=${sessionId} key=${result.name} (all cooling/tried)`);
		return result;
	}

	const result = { hash: hashKey(pick.key), name: pick.name, index: cfg.keys.indexOf(pick) };
	lastPick.set(sessionId, result);
	tried.add(result.hash);
	attempted.set(sessionId, tried);
	log(`pick session=${sessionId} key=${result.name}`);
	return result;
}

function cool(sessionId: string, seconds: number, reason: string, errorText: string): void {
	const cfg = loadConfig();
	const picked = lastPick.get(sessionId);
	if (!cfg || !picked) return;
	const state = loadState();
	const until = Date.now() + Math.max(1, seconds) * 1000;
	state.keys[picked.hash] = {
		name: picked.name,
		cooldownUntil: until,
		reason,
		lastError: errorText.slice(0, 300),
	};
	state.updatedAt = Date.now();
	writeJsonAtomic(STATE_PATH, state);
	log(
		`cool session=${sessionId} key=${picked.name} reason=${reason} ${seconds}s until=${new Date(until).toISOString()}`,
	);
}

type ErrorKind = "auth" | "quota" | "rate" | "other";

function classifyError(message: string): ErrorKind {
	const text = message.toLowerCase();
	if (
		/\b401\b|\b403\b/.test(text) ||
		text.includes("authenticationerror") ||
		text.includes("invalid api key") ||
		text.includes("unauthorized") ||
		text.includes("forbidden") ||
		text.includes("api key format")
	) {
		return "auth";
	}
	if (
		text.includes("accountquotaexceeded") ||
		text.includes("quota") ||
		text.includes("insufficient_funds") ||
		text.includes("insufficient_quota") ||
		text.includes("balance")
	) {
		return "quota";
	}
	if (/\b429\b/.test(text) || text.includes("rate limit") || text.includes("too many requests")) {
		return "rate";
	}
	return "other";
}

/** 从 "It will reset at 2026-10-28 00:00:00 +0800" 解析重置时间。 */
function parseResetSeconds(message: string): number | undefined {
	const m = message.match(/reset at (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) \+(\d{4})/);
	if (!m) return undefined;
	const iso = `${m[1]}T${m[2]}+${m[3].slice(0, 2)}:${m[3].slice(2)}`;
	const at = Date.parse(iso);
	if (!Number.isFinite(at)) return undefined;
	const seconds = Math.round((at - Date.now()) / 1000);
	return seconds > 0 ? seconds : undefined;
}

function cooldownFor(kind: ErrorKind, message: string, cfg: PoolConfig): number {
	const c = cooldownConfig(cfg);
	let seconds: number;
	if (kind === "auth") seconds = c.authSeconds;
	else if (kind === "rate") seconds = c.rateLimitSeconds;
	else if (kind === "quota") {
		seconds = parseResetSeconds(message) ?? c.quotaSeconds;
		if (/weekly/i.test(message) && !parseResetSeconds(message)) seconds = Math.max(seconds, 3600);
	} else seconds = c.rateLimitSeconds;
	return Math.min(seconds, c.maxSeconds);
}

/** 冷却之后，池里是否还有「本次没试过且未冷却」的 Key。 */
function hasAnotherKey(sessionId: string): boolean {
	const cfg = loadConfig();
	if (!cfg || cfg.keys.length < 2) return false;
	const state = loadState();
	const tried = attempted.get(sessionId) ?? new Set<string>();
	const now = Date.now();
	return cfg.keys.some((k) => {
		const hash = hashKey(k.key);
		const entry = state.keys[hash];
		return !tried.has(hash) && (!entry || entry.cooldownUntil <= now);
	});
}

function rewriteToRetryable(sessionId: string, message: string): string | undefined {
	const picked = lastPick.get(sessionId);
	const who = picked ? `key "${picked.name}"` : "current key";
	return `429 rate limit (ark-key-pool: ${who} cooled down, retrying with next key): ${message}`;
}

function sessionIdOf(ctx: { sessionManager?: { getSessionId?: () => string } }): string {
	try {
		return String(ctx.sessionManager?.getSessionId?.() ?? "unknown");
	} catch {
		return "unknown";
	}
}

function fmtDuration(ms: number): string {
	if (ms <= 0) return "ready";
	const s = Math.round(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m`;
	return `${Math.floor(m / 60)}h${m % 60}m`;
}

export default function arkKeyPool(pi: ExtensionAPI) {
	pi.on("before_provider_headers", (event, ctx) => {
		try {
			if (ctx.model?.provider !== PROVIDER) return;
			const sessionId = sessionIdOf(ctx);
			const cfg = loadConfig();
			if (!cfg || cfg.keys.length < 2) return;
			const pick = pickKey(sessionId);
			if (!pick) return;
			const key = cfg.keys[pick.index]?.key;
			if (!key) return;
			event.headers.Authorization = `Bearer ${key}`;
		} catch (error) {
			log(`before_provider_headers failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	});

	pi.on("message_end", (event, ctx) => {
		try {
			if (ctx.model?.provider !== PROVIDER) return;
			const msg = event.message;
			if (msg.role !== "assistant" || !msg.errorMessage) {
				if (msg.role === "assistant" && msg.stopReason !== "error") {
					const sessionId = sessionIdOf(ctx);
					attempted.delete(sessionId);
					lastError.delete(sessionId);
				}
				return;
			}
			const sessionId = sessionIdOf(ctx);
			const errorText = msg.errorMessage;
			if (lastError.get(sessionId) === errorText) return;
			lastError.set(sessionId, errorText);

			const cfg = loadConfig();
			if (!cfg || cfg.keys.length < 2) return;

			const kind = classifyError(errorText);
			if (kind === "other") return;

			const seconds = cooldownFor(kind, errorText, cfg);
			cool(sessionId, seconds, kind, errorText);

			const retryAuth = cfg.retryAuthErrors !== false;
			if (kind === "auth" && retryAuth && hasAnotherKey(sessionId)) {
				const rewritten = rewriteToRetryable(sessionId, errorText);
				if (rewritten) {
					msg.errorMessage = rewritten;
					log(`rewrite session=${sessionId} auth-error -> retryable`);
				}
			}
		} catch (error) {
			log(`message_end failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	});

	pi.on("before_agent_start", (_event, ctx) => {
		const sessionId = sessionIdOf(ctx);
		attempted.delete(sessionId);
		lastError.delete(sessionId);
	});

	pi.registerCommand("ark-key-pool", {
		description: "查看 / 重置 Agent Plan Key 池",
		handler: async (args: string, ctx: { ui: { notify: (msg: string, level?: string) => void } }) => {
			const notify = (msg: string) => ctx.ui.notify(msg, "info");
			const cfg = loadConfig();
			if (!cfg) {
				notify(
					`未找到配置：${CONFIG_PATH}（复制 .example 模板并填入至少 2 个 Key 后生效）`,
				);
				return;
			}
			if (args.trim() === "reset") {
				writeJsonAtomic(STATE_PATH, { version: 1, keys: {}, updatedAt: Date.now() });
				notify(`已清除 ${cfg.keys.length} 个 Key 的冷却状态。`);
				return;
			}
			const state = loadState();
			const now = Date.now();
			const lines = cfg.keys.map((k, i) => {
				const entry = state.keys[hashKey(k.key)];
				const cd = entry ? entry.cooldownUntil - now : 0;
				const status = cd > 0 ? `冷却中 ${fmtDuration(cd)}（${entry?.reason ?? "?"}）` : "可用";
				return `${i + 1}. ${k.name}：${status}`;
			});
			notify([`Agent Plan Key 池（provider=${PROVIDER}）`, ...lines].join("\n"));
		},
	});
}
