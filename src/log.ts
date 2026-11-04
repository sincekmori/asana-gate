// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import { createWriteStream } from "node:fs";
import { rename } from "node:fs/promises";
import { dirname } from "node:path";

import { privateDir, statIfPresent } from "./system.ts";

/** Log levels, least to most verbose. */
const LOG_LEVELS = ["silent", "error", "warn", "info", "debug"] as const;

type LogLevel = (typeof LOG_LEVELS)[number];

/** A minimal logger. Everything goes to stderr: stdout belongs to the MCP stdio transport. */
interface Logger {
	error(message: string): void;
	warn(message: string): void;
	info(message: string): void;
	debug(message: string): void;
}

/** Where a logger's lines go. */
type Sink = (line: string) => void;

const stderrSink: Sink = (line) => {
	process.stderr.write(`${line}\n`);
};

/** A logger writing to `sink` (stderr by default), filtered by `level`. */
function createLogger(level: LogLevel = "warn", sink: Sink = stderrSink): Logger {
	const threshold = LOG_LEVELS.indexOf(level);
	const emit = (at: LogLevel, message: string): void => {
		if (LOG_LEVELS.indexOf(at) <= threshold) {
			sink(`[asana-gate] ${at}: ${message}`);
		}
	};
	return {
		error: (message) => {
			emit("error", message);
		},
		warn: (message) => {
			emit("warn", message);
		},
		info: (message) => {
			emit("info", message);
		},
		debug: (message) => {
			emit("debug", message);
		},
	};
}

/** A logger that discards everything. */
const silentLogger: Logger = createLogger("silent");

/** A log file this big is moved aside (one generation, `.1`) before it is appended to again. */
const LOG_ROTATE_BYTES = 10 * 1024 * 1024;

/**
 * A sink that writes to stderr and appends a timestamped copy to `file`,
 * created owner-only and rotated once it grows past {@link LOG_ROTATE_BYTES}.
 * Opening it fails when the file cannot be created; a failure while writing
 * later is reported on stderr once, and the file is left alone from then on.
 */
async function fileSink(file: string): Promise<Sink> {
	await privateDir(dirname(file));
	const existing = await statIfPresent(file);
	if ((existing?.size ?? 0) > LOG_ROTATE_BYTES) {
		await rename(file, `${file}.1`);
	}
	const stream = createWriteStream(file, { flags: "a", mode: 0o600 });
	let failed = false;
	stream.on("error", (failure: Error) => {
		failed = true;
		stderrSink(`[asana-gate] warn: log file ${file}: ${failure.message}; logging to stderr only`);
	});
	return (line) => {
		stderrSink(line);
		if (!failed) {
			stream.write(`${new Date().toISOString()} ${line}\n`);
		}
	};
}

export { messageOf } from "./message.ts";
export { createLogger, fileSink, LOG_LEVELS, silentLogger };
export type { Logger, LogLevel, Sink };
