// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import { timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { hostHeaderValidation, originValidation, toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";

import type { Gate } from "../gate/gate.ts";
import type { Logger } from "../log.ts";
import { createAsanaGateServer } from "./server.ts";

/** A running MCP endpoint. */
interface Serving {
	/** Where clients connect: `stdio`, or the HTTP URL. */
	readonly endpoint: string;
	close(): Promise<void>;
}

/** Options for {@link serveHttp}. */
interface HttpOptions {
	gate: Gate;
	version: string;
	logger: Logger;
	host: string;
	port: number;
	/** Host names accepted in `Host` and `Origin` headers (DNS rebinding protection). */
	allowedHosts: readonly string[];
	/** When set, every request must carry `Authorization: Bearer <token>`. */
	authToken?: string;
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost", "[::1]"]);

/** Whether a bind address only accepts local connections. */
function isLoopback(host: string): boolean {
	return LOOPBACK.has(host);
}

function bearerMatches(header: string | undefined, token: string): boolean {
	const expected = Buffer.from(`Bearer ${token}`);
	const actual = Buffer.from(header ?? "");
	return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function reject(res: ServerResponse, status: number, message: string): void {
	res.writeHead(status, {
		"content-type": "application/json",
		...(status === 401 && { "www-authenticate": "Bearer" }),
	});
	res.end(JSON.stringify({ error: message }));
}

/** Serves the gate over stdio (one connection, the current process's stdin/stdout). */
function serveOverStdio(gate: Gate, version: string, logger: Logger): Serving {
	const handle = serveStdio((ctx) => createAsanaGateServer(gate, { version, era: ctx.era }), {
		onerror: (error) => {
			logger.error(`stdio: ${error.message}`);
		},
	});
	return { endpoint: "stdio", close: () => handle.close() };
}

/** Serves the gate over Streamable HTTP on `host:port`. */
async function serveHttp(options: HttpOptions): Promise<Serving> {
	const { gate, logger } = options;
	const handler = createMcpHandler(
		(ctx) => createAsanaGateServer(gate, { version: options.version, era: ctx.era }),
		{
			onerror: (error) => {
				logger.error(`http: ${error.message}`);
			},
		},
	);
	const nodeHandler = toNodeHandler(handler);
	const validateHost = hostHeaderValidation([...options.allowedHosts]);
	const validateOrigin = originValidation([...options.allowedHosts]);
	const server = createServer((req: IncomingMessage, res: ServerResponse) => {
		if (!validateHost(req, res) || !validateOrigin(req, res)) {
			return;
		}
		if (
			options.authToken !== undefined &&
			!bearerMatches(req.headers.authorization, options.authToken)
		) {
			reject(res, 401, "a bearer token is required");
			return;
		}
		void nodeHandler(req, res);
	});
	server.listen(options.port, options.host);
	await once(server, "listening");
	const address = server.address();
	const port = typeof address === "object" && address !== null ? address.port : options.port;
	const hostForUrl = options.host.includes(":") ? `[${options.host}]` : options.host;
	return {
		endpoint: `http://${hostForUrl}:${port}/mcp`,
		close: async () => {
			await handler.close();
			server.close();
			await once(server, "close");
		},
	};
}

export { isLoopback, serveHttp, serveOverStdio };
export type { HttpOptions, Serving };
