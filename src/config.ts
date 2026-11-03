import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { z } from "zod";

const providersSchema = z.array(
	z.object({
		id: z.string(),
		baseUrl: z.string().url(),
		keyEnv: z.string(),
		protocols: z.array(z.enum(["chat", "responses", "messages"])),
		note: z.string(),
	}),
);
export const providers = providersSchema.parse(
	JSON.parse(
		readFileSync(new URL("../providers/index.json", import.meta.url), "utf8"),
	),
);
// Compiled code lives directly in dist/, preserving this package-relative URL.
export const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const positive = (v: string, max: number) => {
	const n = Number(v);
	if (!Number.isSafeInteger(n) || n < 1 || n > max)
		throw new Error("Invalid positive numeric option");
	return n;
};
export function config(argv: string[]) {
	const { values } = parseArgs({
		args: argv,
		options: {
			provider: { type: "string" },
			model: { type: "string" },
			protocol: { type: "string" },
			suite: { type: "string", default: "core" },
			repetitions: { type: "string", default: "1" },
			"max-requests": { type: "string", default: "100" },
			"max-output-tokens": { type: "string", default: "1024" },
			"timeout-seconds": { type: "string", default: "90" },
			"interval-ms": { type: "string", default: "1000" },
			out: { type: "string", default: "results" },
			"base-url": { type: "string" },
			region: { type: "string", default: "unspecified" },
			"route-policy": {
				type: "string",
				default: "provider default; backend unknown",
			},
			help: { type: "boolean", default: false },
		},
	});
	if (values.help) {
		console.log(
			"llm-router-bench --provider <id> --model <id> [--protocol chat|responses|messages] [--suite core|legacy] [--repetitions 10] [--max-requests 100] [--out results]",
		);
		process.exit(0);
	}
	const provider = providers.find((p) => p.id === values.provider);
	if (!provider || !values.model)
		throw new Error(
			"Supply an agreed provider ID and explicit model with --provider and --model",
		);
	const protocol = values.protocol ?? provider.protocols[0];
	if (
		!provider.protocols.includes(protocol as "chat" | "responses" | "messages")
	)
		throw new Error("Protocol is not configured for this provider");
	if (values.suite !== "core" && values.suite !== "legacy")
		throw new Error("Suite must be core or legacy");
	if (values.suite === "legacy" && protocol === "messages")
		throw new Error("Legacy suite uses OpenAI-style protocols only");
	const apiKey = process.env[provider.keyEnv];
	if (!apiKey) throw new Error(`Missing ${provider.keyEnv}`);
	const url = new URL(values["base-url"] ?? provider.baseUrl);
	if (
		url.protocol !== "https:" ||
		url.username ||
		url.password ||
		url.search ||
		url.hash
	)
		throw new Error(
			"Target must be HTTPS without credentials, query, or fragment",
		);
	if (values["base-url"] && url.host !== new URL(provider.baseUrl).host)
		throw new Error(
			"Base URL override must retain the provider host (never forward credentials to another host)",
		);
	// Only operator-authored public profile values are published; never read secrets into the manifest.
	if (/\s/.test(values.model) || values.model.length > 200)
		throw new Error("Invalid model ID");
	return {
		provider,
		model: values.model,
		protocol: protocol as "chat" | "responses" | "messages",
		suite: values.suite as "core" | "legacy",
		apiKey,
		baseUrl: url.href.replace(/\/$/, ""),
		repetitions: positive(values.repetitions, 1000),
		maxRequests: positive(values["max-requests"], 100000),
		maxOutputTokens: positive(values["max-output-tokens"], 8192),
		timeoutMs: positive(values["timeout-seconds"], 300) * 1000,
		intervalMs: positive(values["interval-ms"], 60000),
		out: values.out,
		region: values.region,
		routePolicy: values["route-policy"],
	};
}
export type Config = ReturnType<typeof config>;
