/**
 * Agent Plan Key 池（A2 方案）：为 volcengine-agent-plan 提供多 Key 自动切换。
 *
 * 原理：
 *   1. before_provider_headers 里把 Authorization 换成池中当前可用的 Key；
 *   2. message_end 里识别 401/403（Key 失效）与 429（额度耗尽 / 限流），给「本次实际用到的那把 Key」写冷却；
 *   3. 401/403 原本不会被 pi 重试，这里把 errorMessage 改写成可重试形态（带 429），
 *      让 pi 的自动重试带着「下一把 Key」继续跑。
 *
 * 冷却粒度：
 *   - auth（Key 失效）、rate（限流）按整把 Key 冷却；
 *   - quota（额度耗尽）按「Key + 模型」冷却——实测同一把 Key 的额度是按模型算的，
 *     某个模型额度用完不影响这把 Key 跑别的模型；且逐次翻倍重试，避免一次误报就停用一整天。
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

/** 某个模型上的额度冷却（逐次翻倍）。 */
interface ModelState {
	cooldownUntil: number;
	reason: string;
	hits: number;
	lastError?: string;
}

interface KeyState {
	name: string;
	/** 整把 Key 的冷却：auth / rate。0 表示没有。 */
	cooldownUntil: number;
	reason?: string;
	lastError?: string;
	/** 按模型记的额度冷却：模型 id → 状态。 */
	models?: Record<string, ModelState>;
}

interface PoolState {
	version: 1;
	keys: Record<string, KeyState>;
	updatedAt?: number;
}

/** 本次请求实际插进 header 的那把 Key（冷却只认它，避免把错误记到别的 Key 头上）。 */
interface Applied {
	hash: string;
	name: string;
	index: number;
	model: string;
	/** fresh=健康 Key；cooling=退路（还没解冻）；reuse=本轮都试过了 */
	kind: "fresh" | "cooling" | "reuse";
	until: number;
}

const applied = new Map<string, Applied>();
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

/** 这把 Key 在某个模型上的冷却截止时间（整把 Key 冷却与模型冷却取较晚者）。 */
function cooldownUntil(state: PoolState, hash: string, model: string): number {
	const entry = state.keys[hash];
	if (!entry) return 0;
	const modelUntil = entry.models?.[model]?.cooldownUntil ?? 0;
	return Math.max(entry.cooldownUntil ?? 0, modelUntil);
}

function coolingReason(state: PoolState, hash: string, model: string): string {
	const entry = state.keys[hash];
	if (!entry) return "";
	const modelState = entry.models?.[model];
	const modelUntil = modelState?.cooldownUntil ?? 0;
	const globalUntil = entry.cooldownUntil ?? 0;
	const reason = modelUntil >= globalUntil ? modelState?.reason : entry.reason;
	return reason ?? "cooldown";
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

/**
 * 额度冷却时长：从 quotaSeconds 起逐次翻倍（1 次 30 分钟、2 次 1 小时……），
 * 但不超过响应里给的重置时间，也不超过 maxSeconds。
 *
 * 为什么不用「直接按重置时间冷却」：实测同一把 Key 报「weekly usage quota exceeded」后
 * 十分钟内又能正常请求，一次就停用一整天会把整个池子拖死；翻倍重试能同时兜住
 * 「真用完」（很快翻到天数级）和「误报 / 滚动窗口」（几分钟后自动恢复）两种情况。
 */
function quotaCooldownSeconds(message: string, cfg: PoolConfig, hits: number): number {
	const c = cooldownConfig(cfg);
	const backoff = c.quotaSeconds * 2 ** Math.max(0, hits - 1);
	const reset = parseResetSeconds(message);
	const ceiling = reset ? Math.min(reset, c.maxSeconds) : c.maxSeconds;
	return Math.max(30, Math.min(Math.round(backoff), ceiling));
}

/** 本轮（同一会话的连续重试）里，除当前这把之外还有没有「没试过且没冷却」的 Key。 */
function hasAnotherKey(sessionId: string, model: string, currentHash: string): boolean {
	const cfg = loadConfig();
	if (!cfg || cfg.keys.length < 2) return false;
	const state = loadState();
	const tried = attempted.get(sessionId) ?? new Set<string>();
	const now = Date.now();
	return cfg.keys.some((k) => {
		const hash = hashKey(k.key);
		return hash !== currentHash && !tried.has(hash) && cooldownUntil(state, hash, model) <= now;
	});
}

function fmtDuration(ms: number): string {
	if (ms <= 0) return "now";
	const s = Math.round(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h}h${m % 60}m`;
	return `${Math.floor(h / 24)}d${h % 24}h`;
}

/**
 * 选 Key。永不返回 undefined（只要池里有 2 把以上）——不再静默回落到 auth.json 里那把，
 * 否则池子试完一圈后会一直打同一把死 Key，用户只看到一堆一样的 429。
 */
function pickKey(sessionId: string, model: string): Applied | undefined {
	const cfg = loadConfig();
	if (!cfg || cfg.keys.length < 2) return undefined;

	const state = loadState();
	const tried = attempted.get(sessionId) ?? new Set<string>();
	const now = Date.now();

	const rows = cfg.keys.map((k, index) => {
		const hash = hashKey(k.key);
		return { key: k, index, hash, until: cooldownUntil(state, hash, model) };
	});

	// 排序：已解冻优先 → 冷却结束得早优先 → 本轮没试过优先。
	const ranked = [...rows].sort((a, b) => {
		const aReady = a.until <= now ? 0 : 1;
		const bReady = b.until <= now ? 0 : 1;
		if (aReady !== bReady) return aReady - bReady;
		if (a.until !== b.until) return a.until - b.until;
		return (tried.has(a.hash) ? 1 : 0) - (tried.has(b.hash) ? 1 : 0);
	});
	const chosen = ranked[0];
	if (!chosen) return undefined;

	const kind: Applied["kind"] =
		chosen.until > now ? "cooling" : tried.has(chosen.hash) ? "reuse" : "fresh";
	const result: Applied = {
		hash: chosen.hash,
		name: chosen.key.name,
		index: chosen.index,
		model,
		kind,
		until: chosen.until,
	};

	applied.set(sessionId, result);
	tried.add(result.hash);
	attempted.set(sessionId, tried);

	if (kind === "fresh") {
		log(`pick session=${sessionId} model=${model} key=${result.name}`);
	} else {
		const left = kind === "cooling" ? ` cooldown=${fmtDuration(chosen.until - now)}` : "";
		log(
			`pick#${kind} session=${sessionId} model=${model} key=${result.name}${left}` +
				` (${kind === "cooling" ? "all cooling/tried" : "all tried"})`,
		);
	}
	return result;
}

function cool(sessionId: string, kind: ErrorKind, message: string): void {
	const picked = applied.get(sessionId);
	if (!picked) {
		// 没有插过池里的 Key，就不该记冷却（否则会把错误算到别的 Key 头上）。
		log(`cool#skip session=${sessionId} reason=${kind} (no pool key applied)`);
		return;
	}
	const cfg = loadConfig();
	if (!cfg) return;

	const c = cooldownConfig(cfg);
	const now = Date.now();
	const state = loadState();
	const entry: KeyState = state.keys[picked.hash] ?? { name: picked.name, cooldownUntil: 0 };
	entry.name = picked.name;

	if (kind === "quota") {
		// 额度按「Key + 模型」冷却，并按「事故次数」逐次翻倍。
		// 冷却期内被当作退路重试（同一轮里连打几次）不重复计数，否则一次报错就能把时长吹到几小时。
		const models = entry.models ?? (entry.models = {});
		const prev = models[picked.model];
		const sameIncident = !!prev && prev.cooldownUntil > now;
		const hits = sameIncident ? prev.hits : (prev?.hits ?? 0) + 1;
		const seconds = quotaCooldownSeconds(message, cfg, hits);
		const until = now + Math.max(1, seconds) * 1000;
		models[picked.model] = {
			cooldownUntil: until,
			reason: kind,
			hits,
			lastError: message.slice(0, 300),
		};
		state.keys[picked.hash] = entry;
		state.updatedAt = now;
		writeJsonAtomic(STATE_PATH, state);
		log(
			`cool session=${sessionId} key=${picked.name} model=${picked.model} reason=quota hit=${hits}` +
				` ${seconds}s until=${new Date(until).toISOString()}`,
		);
		return;
	}

	const base = kind === "auth" ? c.authSeconds : c.rateLimitSeconds;
	const seconds = Math.min(base, c.maxSeconds);
	const until = now + Math.max(1, seconds) * 1000;
	entry.cooldownUntil = until;
	entry.reason = kind;
	entry.lastError = message.slice(0, 300);
	state.keys[picked.hash] = entry;
	state.updatedAt = now;
	writeJsonAtomic(STATE_PATH, state);
	log(
		`cool session=${sessionId} key=${picked.name} reason=${kind} ${seconds}s until=${new Date(until).toISOString()}`,
	);
}

/** 请求成功了：说明这把 Key 在模型上是好的，把它的（可能多余的）冷却清掉。 */
function clearCooldown(sessionId: string): void {
	const picked = applied.get(sessionId);
	if (!picked) return;
	const state = loadState();
	const entry = state.keys[picked.hash];
	if (!entry) return;
	let changed = false;
	if ((entry.cooldownUntil ?? 0) > Date.now()) {
		entry.cooldownUntil = 0;
		entry.reason = undefined;
		entry.lastError = undefined;
		changed = true;
	}
	const modelState = entry.models?.[picked.model];
	if (modelState) {
		// 成功一次就把翻倍计数清零，下次真耗尽时重新从最短档位开始。
		delete entry.models?.[picked.model];
		changed = true;
	}
	if (!changed) return;
	state.updatedAt = Date.now();
	writeJsonAtomic(STATE_PATH, state);
	log(`clear session=${sessionId} key=${picked.name} model=${picked.model} (request succeeded)`);
}

/** 池子全干时给用户看的现状摘要。 */
function poolSummary(model: string): string {
	const cfg = loadConfig();
	if (!cfg) return "";
	const state = loadState();
	const now = Date.now();
	return cfg.keys
		.map((k) => {
			const hash = hashKey(k.key);
			const until = cooldownUntil(state, hash, model);
			if (until <= now) return `${k.name}=可用`;
			return `${k.name}=${coolingReason(state, hash, model)} ${fmtDuration(until - now)}`;
		})
		.join("，");
}

function rewriteToRetryable(sessionId: string, message: string, tail: string): string | undefined {
	const picked = applied.get(sessionId);
	const who = picked ? `key "${picked.name}"` : "current key";
	return `429 rate limit (ark-key-pool: ${who} ${tail}): ${message}`;
}

/** 不改可重试性，只在末尾补一句池子现状。 */
function appendSummary(message: string, summary: string): string {
	return `${message} (ark-key-pool: no healthy key left — ${summary})`;
}

function sessionIdOf(ctx: { sessionManager?: { getSessionId?: () => string } }): string {
	try {
		return String(ctx.sessionManager?.getSessionId?.() ?? "unknown");
	} catch {
		return "unknown";
	}
}

function modelIdOf(ctx: { model?: { id?: string } }): string {
	try {
		return String(ctx.model?.id ?? "unknown");
	} catch {
		return "unknown";
	}
}

export default function arkKeyPool(pi: ExtensionAPI) {
	pi.on("before_provider_headers", (event, ctx) => {
		try {
			if (ctx.model?.provider !== PROVIDER) return;
			const sessionId = sessionIdOf(ctx);
			const model = modelIdOf(ctx);
			const pick = pickKey(sessionId, model);
			if (!pick) return;
			const cfg = loadConfig();
			const key = cfg?.keys[pick.index]?.key;
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
			const sessionId = sessionIdOf(ctx);

			if (msg.role === "assistant" && msg.stopReason !== "error") {
				// 成功：本轮记录清零，并清掉这把 Key 可能多余的冷却。
				clearCooldown(sessionId);
				attempted.delete(sessionId);
				lastError.delete(sessionId);
				applied.delete(sessionId);
				return;
			}
			if (msg.role !== "assistant" || !msg.errorMessage) return;

			const errorText = msg.errorMessage;
			const picked = applied.get(sessionId);
			// 去重要带上「哪把 Key / 哪个模型」，否则两次不同 Key 的同样报错会被误吞。
			const fingerprint = `${picked?.hash ?? "-"}|${picked?.model ?? "-"}|${errorText}`;
			if (lastError.get(sessionId) === fingerprint) return;
			lastError.set(sessionId, fingerprint);

			const cfg = loadConfig();
			if (!cfg || cfg.keys.length < 2) return;

			const kind = classifyError(errorText);
			if (kind === "other") return;

			cool(sessionId, kind, errorText);

			const model = picked?.model ?? modelIdOf(ctx);
			const stillHasAnother = picked ? hasAnotherKey(sessionId, model, picked.hash) : false;

			if (kind === "auth") {
				if (cfg.retryAuthErrors === false) return;
				if (stillHasAnother) {
					// 401/403 pi 不会重试，改写成可重试形态，让重试带着下一把 Key 跑。
					const rewritten = rewriteToRetryable(
						sessionId,
						errorText,
						"cooled down, retrying with next key",
					);
					if (rewritten) {
						msg.errorMessage = rewritten;
						log(`rewrite session=${sessionId} auth-error -> retryable`);
					}
					return;
				}
				// 没有别的 Key 可换：保持不可重试，只把现状补在后面。
				const summary = poolSummary(model);
				if (summary) msg.errorMessage = appendSummary(errorText, summary);
				return;
			}

			if (!stillHasAnother) {
				// 池子里没有可用的 Key 了：把现状写进错误里，别让用户只看到一堆一样的 429。
				const summary = poolSummary(model);
				if (summary) {
					const rewritten = rewriteToRetryable(
						sessionId,
						errorText,
						`no healthy key left — ${summary}`,
					);
					if (rewritten) msg.errorMessage = rewritten;
					log(`rewrite session=${sessionId} pool-exhausted -> ${summary}`);
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
		applied.delete(sessionId);
	});

	pi.registerCommand("ark-key-pool", {
		description: "查看 / 重置 Agent Plan Key 池",
		handler: async (args: string, ctx: { ui: { notify: (msg: string, level?: string) => void } }) => {
			const notify = (msg: string) => ctx.ui.notify(msg, "info");
			const cfg = loadConfig();
			if (!cfg) {
				notify(`未找到配置：${CONFIG_PATH}（复制 .example 模板并填入至少 2 个 Key 后生效）`);
				return;
			}
			if (args.trim() === "reset") {
				writeJsonAtomic(STATE_PATH, { version: 1, keys: {}, updatedAt: Date.now() });
				notify(`已清除 ${cfg.keys.length} 个 Key 的全部冷却状态。`);
				return;
			}
			const state = loadState();
			const now = Date.now();
			const lines = cfg.keys.map((k, i) => {
				const hash = hashKey(k.key);
				const entry = state.keys[hash];
				const parts: string[] = [];
				const globalLeft = (entry?.cooldownUntil ?? 0) - now;
				if (globalLeft > 0) parts.push(`整把冷却 ${fmtDuration(globalLeft)}（${entry?.reason ?? "?"}）`);
				for (const [m, ms] of Object.entries(entry?.models ?? {})) {
					const left = ms.cooldownUntil - now;
					if (left > 0) {
						parts.push(`${m} 额度冷却 ${fmtDuration(left)}（第 ${ms.hits} 次）`);
					}
				}
				const status = parts.length > 0 ? parts.join("；") : "可用";
				return `${i + 1}. ${k.name}：${status}`;
			});
			notify([`Agent Plan Key 池（provider=${PROVIDER}）`, ...lines].join("\n"));
		},
	});
}
