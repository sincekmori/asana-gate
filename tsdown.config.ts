import { defineConfig } from "tsdown";

export default defineConfig([
	{
		// The library: ESM + CJS with bundled types, package.json `exports` generated from the outputs.
		entry: ["src/index.ts"],
		format: ["esm", "cjs"],
		dts: true,
		clean: true,
		sourcemap: true,
		treeshake: true,
		exports: {
			legacy: true,
			customExports(exports): Record<string, unknown> {
				// The policy and settings JSON Schemas, shipped for `"$schema"` pointers.
				return {
					...exports,
					"./schema.json": "./schema.json",
					"./settings.schema.json": "./settings.schema.json",
				};
			},
		},
		// Validate the published package shape on every build (locally and in CI).
		publint: true,
		attw: { profile: "strict" },
	},
	{
		// The CLI: ESM only (it uses top-level await), reachable through `bin`.
		entry: ["src/cli.ts"],
		format: ["esm"],
		dts: false,
		clean: false,
		sourcemap: true,
		treeshake: true,
	},
]);
