// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import { AsanaClient } from "../asana/client.ts";
import type { JsonObject } from "../json.ts";
import {
	createLogger,
	fileSink,
	type Logger,
	type LogLevel,
	messageOf,
	type Sink,
} from "../log.ts";
import { durationMs } from "../policy/durations.ts";
import type { LoadedSettings } from "../settings/load.ts";
import { type CommonOptions, loadCliSettings } from "./context.ts";
import { tokenOf, type TokenSource } from "./token.ts";

/** The log file the settings name, and why it could not be opened when it could not. */
interface LogState {
	readonly file?: string;
	readonly problem?: string;
}

/** What a command needs to talk to Asana. */
interface CommandContext {
	readonly client: AsanaClient;
	readonly logger: Logger;
	readonly loaded: LoadedSettings;
	/** Where the token came from (never the token itself). */
	readonly token: TokenSource;
	readonly log: LogState;
}

/** Opens the log file the settings name; one that cannot be opened is reported on stderr and remembered. */
async function openSink(
	file: string | null | undefined,
	level: LogLevel,
): Promise<{ sink?: Sink; log: LogState }> {
	if (file === null || file === undefined) {
		return { log: {} };
	}
	try {
		return { sink: await fileSink(file), log: { file } };
	} catch (error) {
		const problem = messageOf(error);
		createLogger(level).warn(
			`log file ${file} cannot be opened: ${problem}; logging to stderr only`,
		);
		return { log: { file, problem } };
	}
}

/** Builds the client and the logger the settings describe, with the token they lead to. */
async function connect(loaded: LoadedSettings): Promise<CommandContext> {
	const { settings } = loaded;
	const [opened, { token, ...source }] = await Promise.all([
		openSink(settings.log.file, settings.log.level),
		tokenOf(loaded),
	]);
	const logger = createLogger(settings.log.level, opened.sink);
	const client = new AsanaClient({
		token,
		logger,
		maxConcurrentReads: settings.concurrency.reads,
		maxConcurrentWrites: settings.concurrency.writes,
		maxRetries: settings.retries.max,
		maxRetryAfterSeconds: durationMs(settings.retries.maxWait) / 1000,
		enable: settings.asana.enable,
		disable: settings.asana.disable,
	});
	return { client, logger, loaded, token: source, log: opened.log };
}

/** Loads the settings with the command line as their `flags` layer, then connects. */
async function createContext(options: CommonOptions, extra?: JsonObject): Promise<CommandContext> {
	return connect(await loadCliSettings(options, extra));
}

export { connect, createContext };
export type { CommandContext };
