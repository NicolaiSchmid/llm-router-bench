import { afterEach, expect, it, vi } from "vitest";
import { discoverCapabilities } from "./capabilities.ts";

afterEach(() => vi.restoreAllMocks());
it.each([true, false])(
	"distinguishes an advertised gateway input limit from native context testing: %s",
	async (limited) => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				Response.json({
					data: [
						{
							id: "synthetic",
							architecture: { input_modalities: ["text"] },
							supported_parameters: [],
							...(limited ? { gateway_limits: { input_characters: 100 } } : {}),
						},
					],
				}),
			),
		);
		const caps = await discoverCapabilities({
			baseUrl: `https://${limited ? "limited" : "native"}.invalid`,
			apiKey: "synthetic",
			model: "synthetic",
			timeoutMs: 100,
		});
		expect(caps?.has("gateway_input_limit")).toBe(limited);
		expect(caps?.has("native_context_overflow")).toBe(!limited);
		vi.unstubAllGlobals();
	},
);

it.each([true, false])(
	"honours declared JSON Schema dialect limits: %s",
	async (supported) => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				Response.json({
					data: [
						{
							id: "synthetic",
							architecture: { input_modalities: ["text"] },
							supported_parameters: ["structured_outputs"],
							json_schema_dialect: {
								optional_properties: supported,
								unconstrained_subschemas: supported,
							},
						},
					],
				}),
			),
		);
		const caps = await discoverCapabilities({
			baseUrl: `https://dialect-${supported}.invalid`,
			apiKey: "synthetic",
			model: "synthetic",
			timeoutMs: 100,
		});
		expect(caps?.has("structured_outputs")).toBe(true);
		expect(caps?.has("json_schema_optional")).toBe(supported);
		expect(caps?.has("json_schema_unconstrained")).toBe(supported);
		vi.unstubAllGlobals();
	},
);
