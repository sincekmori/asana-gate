// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { text as readStream } from "node:stream/consumers";

import { AsanaClient } from "../asana/client.ts";
import { AsanaApiError } from "../asana/errors.ts";
import { AsanaNameResolver } from "../gate/resolver.ts";
import type { Me } from "../policy/types.ts";
import { UsageError } from "./context.ts";
import { tokenText } from "./token.ts";

/** Whose a token is, and how a token is read without being seen. */

/** `name <email> (gid)` of a user, with what is unknown as `?`. */
function describeUser(me: Me): string {
	return `${me.name ?? "?"} <${me.email ?? "?"}> (${me.gid})`;
}

/** Who a token belongs to, as Asana says. */
async function identify(token: string): Promise<string> {
	try {
		const me = await new AsanaNameResolver(new AsanaClient({ token })).me();
		return describeUser(me);
	} catch (error) {
		if (error instanceof AsanaApiError && error.status === 401) {
			throw new UsageError("Asana rejected the token (401 Unauthorized)");
		}
		throw error;
	}
}

/** Reads a secret from standard input: piped text as it is, or typed on a terminal without echo. */
async function readSecret(prompt: string): Promise<string> {
	if (!process.stdin.isTTY) {
		const piped = await readStream(process.stdin);
		return tokenText(piped, "standard input");
	}
	process.stderr.write(prompt);
	const muted = new Writable({
		write(_chunk, _encoding, done): void {
			done();
		},
	});
	const lines = createInterface({ input: process.stdin, output: muted, terminal: true });
	const aborted = new AbortController();
	lines.on("SIGINT", () => {
		aborted.abort();
	});
	try {
		const line = await lines.question("", { signal: aborted.signal });
		return line.trim();
	} catch {
		throw new UsageError("aborted");
	} finally {
		lines.close();
		process.stderr.write("\n");
	}
}

export { describeUser, identify, readSecret };
