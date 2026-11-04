// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import { CLIENT_DEFAULTS } from "../asana/client.ts";
import { isObject, type JsonObject } from "../json.ts";
import { messageOf } from "../log.ts";
import { envValue, firstWhere, isFile, isMissing, readIfPresent } from "../system.ts";
import { parseYaml, validated } from "../yaml.ts";
import {
	findProjectDir,
	homeDir,
	managedDir,
	POLICY_FILE,
	PROJECT_DIR,
	resolveFrom,
} from "./paths.ts";
import { type Settings, type SettingsFile, SettingsFileSchema, SettingsSchema } from "./schema.ts";

/** A settings file or layer is malformed, or says something it may not. */
class SettingsError extends Error {
	public override readonly name: string = "SettingsError";
}

const fail = (message: string): Error => new SettingsError(message);

/** One source of settings (a file path, `env`, `flags` or `defaults`) and what it says. */
interface SettingsLayer {
	readonly source: string;
	readonly values: SettingsFile;
}

/** The settings in force, with where each value came from. */
interface LoadedSettings {
	readonly settings: Settings;
	/** Per dotted key (`cache.ttl`), the source that set it. */
	readonly origins: ReadonlyMap<string, string>;
	readonly home: string;
	/** The project directory (the one holding `.asana-gate`), when the working directory is inside one. */
	readonly projectDir?: string;
}

/** Where settings are looked for. */
interface LoadOptions {
	/** The working directory; the project is the nearest ancestor holding `.asana-gate`. */
	readonly cwd: string;
	readonly env: NodeJS.ProcessEnv;
	/** Defaults to `~/.asana-gate` (or `ASANA_GATE_HOME`). */
	readonly home?: string;
	/** Defaults to the platform's managed directory. */
	readonly managedDir?: string;
	/** Values given on the command line, as one more layer; paths are relative to `cwd`. */
	readonly flags?: JsonObject;
}

/** The settings in force when no layer says otherwise; {@link defaults} adds the log file and the cache directory, which live under the home directory. */
const DEFAULTS = {
	token: { env: "ASANA_ACCESS_TOKEN" },
	log: { level: "warn" },
	cache: { enabled: true, ttl: "7d" },
	concurrency: {
		reads: CLIENT_DEFAULTS.maxConcurrentReads,
		writes: CLIENT_DEFAULTS.maxConcurrentWrites,
	},
	retries: { max: CLIENT_DEFAULTS.maxRetries, maxWait: `${CLIENT_DEFAULTS.maxRetryAfterSeconds}s` },
	asana: { enable: [], disable: [] },
	mcp: {
		transport: "stdio",
		host: "127.0.0.1",
		port: 3845,
		allowedHosts: [],
		authTokenEnv: "ASANA_GATE_MCP_TOKEN",
	},
} satisfies Omit<Settings, "cache"> & { cache: Omit<Settings["cache"], "dir"> };

function defaults(home: string): Settings {
	return {
		...DEFAULTS,
		log: { ...DEFAULTS.log, file: join(home, "logs", "asana-gate.log") },
		cache: { ...DEFAULTS.cache, dir: join(home, "cache") },
	};
}

/** Where the policy file is looked for when no layer names one, in order. */
function policyCandidates(
	place: { readonly home: string; readonly projectDir?: string | undefined },
	cwd: string,
): string[] {
	return [
		...(place.projectDir === undefined ? [] : [join(place.projectDir, PROJECT_DIR, POLICY_FILE)]),
		join(cwd, "asana-gate.yaml"),
		join(place.home, POLICY_FILE),
	];
}

/** One layer's values validated, with its paths made absolute against `base` (the directory of the file naming them). */
function parseLayer(raw: unknown, source: string, base: string): SettingsFile {
	const { $schema: _pointer, ...values } = validated(SettingsFileSchema, raw, { source, fail });
	return {
		...values,
		...(values.policy !== undefined && { policy: resolveFrom(base, values.policy) }),
		...(values.token?.file !== undefined && {
			token: { ...values.token, file: resolveFrom(base, values.token.file) },
		}),
		...(typeof values.log?.file === "string" && {
			log: { ...values.log, file: resolveFrom(base, values.log.file) },
		}),
		...(values.cache?.dir !== undefined && {
			cache: { ...values.cache, dir: resolveFrom(base, values.cache.dir) },
		}),
	};
}

/** Reads a settings file; `undefined` when it does not exist. */
async function readLayer(file: string): Promise<SettingsLayer | undefined> {
	const text = await readIfPresent(file).catch((error: unknown) => {
		throw new SettingsError(`cannot read ${file}: ${messageOf(error)}`);
	});
	if (text === undefined) {
		return undefined;
	}
	return {
		source: file,
		values: parseLayer(parseYaml(text, file, fail) ?? {}, file, dirname(file)),
	};
}

/** The files of the managed drop-in directory: none when it is absent, a failure when it cannot be read. */
async function dropInsOf(dir: string): Promise<string[]> {
	try {
		return await readdir(dir);
	} catch (error) {
		if (isMissing(error)) {
			return [];
		}
		// An administrator's settings that cannot be read must not be skipped silently.
		throw new SettingsError(`cannot read ${dir}: ${messageOf(error)}`);
	}
}

/** The managed settings: `managed-settings.yaml`, then `managed-settings.d/*.yaml` in name order. */
async function managedLayers(dir: string): Promise<SettingsLayer[]> {
	const dropIns = await dropInsOf(join(dir, "managed-settings.d"));
	const files = [
		join(dir, "managed-settings.yaml"),
		...dropIns
			.filter((name) => name.endsWith(".yaml"))
			.toSorted()
			.map((name) => join(dir, "managed-settings.d", name)),
	];
	const layers = await Promise.all(files.map((file) => readLayer(file)));
	return layers.filter((layer) => layer !== undefined);
}

const OFF = new Set(["0", "false", "off", "no"]);
const ON = new Set(["1", "true", "on", "yes"]);

/** `ASANA_GATE_CACHE` as a switch, whatever its case; an unknown spelling leaves the settings alone. */
function cacheSwitch(value: string | undefined): boolean | undefined {
	const word = value?.trim().toLowerCase() ?? "";
	if (OFF.has(word)) {
		return false;
	}
	return ON.has(word) ? true : undefined;
}

/** The layer the environment variables make. */
function envLayer(env: NodeJS.ProcessEnv, cwd: string): SettingsLayer {
	const policy = envValue(env, "ASANA_GATE_POLICY");
	const level = envValue(env, "ASANA_GATE_LOG_LEVEL");
	const cache = cacheSwitch(envValue(env, "ASANA_GATE_CACHE"));
	const raw = {
		...(policy !== undefined && { policy }),
		...(level !== undefined && { log: { level } }),
		...(cache !== undefined && { cache: { enabled: cache } }),
	};
	return { source: "env", values: parseLayer(raw, "environment", cwd) };
}

/** One layer's values while they are merged: where they come from, and the key path so far. */
interface Merging {
	readonly source: string;
	readonly values: JsonObject;
	readonly prefix: string;
}

/** Merges a layer's values into `target`, recording where each leaf came from. */
function mergeLayer(target: JsonObject, layer: Merging, origins: Map<string, string>): void {
	for (const [key, value] of Object.entries(layer.values)) {
		if (isObject(value)) {
			const nested = isObject(target[key]) ? target[key] : {};
			target[key] = nested;
			mergeLayer(nested, { ...layer, values: value, prefix: `${layer.prefix}${key}.` }, origins);
		} else if (value !== undefined) {
			target[key] = value;
			origins.set(`${layer.prefix}${key}`, layer.source);
		}
	}
}

/** A project's settings are trusted like its code, so they may not run commands. */
function assertPersonal(layer: SettingsLayer): void {
	if (layer.values.token?.command !== undefined) {
		throw new SettingsError(
			`${layer.source}: token.command may only be set in your own settings (~/.asana-gate/settings.yaml) or in managed settings, not in a project's`,
		);
	}
}

/**
 * Loads the settings in force. Layers, lowest precedence first: defaults,
 * `~/.asana-gate/settings.yaml`, the project's `.asana-gate/settings.yaml`,
 * its `settings.local.yaml`, environment variables, command-line flags, and
 * the administrator's managed settings, which nothing overrides. When no
 * layer names a policy file, the conventional places are searched.
 */
async function loadSettings(options: LoadOptions): Promise<LoadedSettings> {
	const { cwd, env } = options;
	const home = options.home ?? homeDir(env);
	const projectDir = await findProjectDir(cwd, home);
	const projectFiles =
		projectDir === undefined
			? []
			: ["settings.yaml", "settings.local.yaml"].map((name) => join(projectDir, PROJECT_DIR, name));
	const [user, managed, ...project] = await Promise.all([
		readLayer(join(home, "settings.yaml")),
		managedLayers(options.managedDir ?? managedDir(env)),
		...projectFiles.map((file) => readLayer(file)),
	]);
	const projectLayers = project.filter((layer) => layer !== undefined);
	for (const layer of projectLayers) {
		assertPersonal(layer);
	}
	const layers: SettingsLayer[] = [
		{ source: "defaults", values: defaults(home) },
		...(user === undefined ? [] : [user]),
		...projectLayers,
		envLayer(env, cwd),
		...(options.flags === undefined
			? []
			: [{ source: "flags", values: parseLayer(options.flags, "flags", cwd) }]),
		...managed,
	];
	const merged: JsonObject = {};
	const origins = new Map<string, string>();
	for (const layer of layers) {
		mergeLayer(merged, { source: layer.source, values: layer.values, prefix: "" }, origins);
	}
	if (merged.policy === undefined) {
		const found = await firstWhere(policyCandidates({ home, projectDir }, cwd), (file) =>
			isFile(file),
		);
		if (found !== undefined) {
			merged.policy = found;
			origins.set("policy", "defaults");
		}
	}
	return {
		settings: validated(SettingsSchema, merged, { source: "settings", fail }),
		origins,
		home,
		...(projectDir !== undefined && { projectDir }),
	};
}

export { DEFAULTS, loadSettings, policyCandidates, SettingsError };
export type { LoadedSettings, LoadOptions };
