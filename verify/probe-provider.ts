import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PORT = Number(process.env.MOCK_PORT ?? 8796);

export default function (pi: ExtensionAPI) {
	pi.registerProvider("probe-ark", {
		name: "Probe Ark",
		baseUrl: `http://127.0.0.1:${PORT}`,
		apiKey: "sk-auth-json-fallback",
		api: "openai-responses",
		models: [
			{
				id: "probe-model",
				name: "Probe Model",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 100000,
				maxTokens: 1000,
			},
			{
				id: "probe-model-2",
				name: "Probe Model 2",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 100000,
				maxTokens: 1000,
			},
		],
	});
}
