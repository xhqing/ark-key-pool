import http from "node:http";
import fs from "node:fs";

const LOG = process.env.MOCK_LOG ?? "/tmp/a2-mock.log";
const PORT = Number(process.env.MOCK_PORT ?? 8796);
// 形如 "sk-pool-1:429,sk-pool-2:ok"；未列出的 key 一律 ok。
// 可选第三段限定模型："sk-pool-1:429@probe-model"——只有该模型的请求才按这个模式回。
const scenario = new Map<string, string>();
for (const raw of (process.env.MOCK_SCENARIO ?? "").split(",")) {
	const entry = raw.trim();
	if (!entry) continue;
	const [key, rest = "ok"] = entry.split(":");
	scenario.set(key, rest);
}

fs.writeFileSync(LOG, "");
let requestSeq = 0;

function sse(res: http.ServerResponse, events: Array<{ event: string; data: unknown }>) {
	res.writeHead(200, {
		"Content-Type": "text/event-stream",
		"Cache-Control": "no-cache",
		Connection: "keep-alive",
	});
	for (const e of events) res.write(`event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`);
	res.end();
}

const server = http.createServer((req, res) => {
	if (req.url === "/__shutdown") {
		res.writeHead(200, { "Content-Type": "text/plain" });
		res.end("bye");
		server.close(() => process.exit(0));
		return;
	}

	let body = "";
	req.on("data", (chunk) => {
		body += chunk;
	});
	req.on("end", () => {
		let model = "?";
		try {
			model = JSON.parse(body)?.model ?? "?";
		} catch {
			// 忽略解析失败
		}
		requestSeq += 1;
		const auth = req.headers.authorization ?? "(none)";
		const keyName = auth.replace(/^Bearer\s+/i, "");
		fs.appendFileSync(LOG, `${new Date().toISOString()} #${requestSeq} ${req.method} ${req.url} key=${keyName} model=${model}\n`);

		const rule = scenario.get(keyName) ?? "ok";
		const [mode, modelFilter] = rule.split("@");
		const active = !modelFilter || modelFilter === model;

		if (active && mode === "429") {
			// 每次报错都带唯一 Request id，贴近真实响应。
			res.writeHead(429, { "Content-Type": "application/json" });
			res.end(
				JSON.stringify({
					error: {
						code: "AccountQuotaExceeded",
						message: `You have exceeded the weekly usage quota. It will reset at 2026-10-28 00:00:00 +0800 CST. Request id: mock-${requestSeq}`,
					},
				}),
			);
			return;
		}
		if (active && mode === "401") {
			res.writeHead(401, { "Content-Type": "application/json" });
			res.end(
				JSON.stringify({
					error: {
						code: "AuthenticationError",
						message: `The API key format is incorrect. Request id: mock-${requestSeq}`,
						type: "Unauthorized",
					},
				}),
			);
			return;
		}

		const item = {
			type: "message",
			id: "msg_1",
			role: "assistant",
			status: "completed",
			content: [{ type: "output_text", text: "hi", annotations: [] }],
		};
		sse(res, [
			{ event: "response.created", data: { type: "response.created", response: { id: "resp_1", status: "in_progress" } } },
			{
				event: "response.output_item.added",
				data: {
					type: "response.output_item.added",
					output_index: 0,
					item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
				},
			},
			{
				event: "response.output_text.delta",
				data: { type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: "msg_1", delta: "hi" },
			},
			{ event: "response.output_item.done", data: { type: "response.output_item.done", output_index: 0, item } },
			{
				event: "response.completed",
				data: {
					type: "response.completed",
					response: {
						id: "resp_1",
						status: "completed",
						output: [item],
						usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
					},
				},
			},
		]);
	});
});

server.listen(PORT, "127.0.0.1", () => console.log(`mock listening on ${PORT} scenario=${process.env.MOCK_SCENARIO ?? "all-ok"}`));
