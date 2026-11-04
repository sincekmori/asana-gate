// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import { once } from "node:events";
import { parseArgs } from "node:util";

import { messageOf } from "../log.ts";
import { isLoopback, serveHttp, serveOverStdio, type Serving } from "../mcp/serve.ts";
import { envValue } from "../system.ts";
import { refreshSkillCopies } from "./agent.ts";
import { COMMON_OPTIONS, UsageError, usageRows } from "./context.ts";
import { openGate } from "./policy.ts";
import { createContext } from "./session.ts";

const MCP_OPTIONS = {
	transport: { type: "string", placeholder: "<kind>", description: "stdio (default) or http" },
	host: {
		type: "string",
		placeholder: "<host>",
		description: "HTTP bind address (default: 127.0.0.1)",
	},
	port: { type: "string", placeholder: "<port>", description: "HTTP port (default: 3845)" },
	"allowed-host": {
		type: "string",
		multiple: true,
		placeholder: "<name>",
		description: "Extra host name accepted in Host/Origin headers (repeatable)",
	},
	"auth-token-env": {
		type: "string",
		placeholder: "<NAME>",
		description:
			"Environment variable with a bearer token HTTP clients must present (default: ASANA_GATE_MCP_TOKEN; required when binding beyond loopback)",
	},
	...COMMON_OPTIONS,
} as const;

const USAGE = `Usage: asana-gate mcp [options]

Serve the policy-gated Asana API as an MCP server.

Options:
${usageRows(MCP_OPTIONS)}`;

function httpAuthToken(envName: string, host: string): string | undefined {
	const token = envValue(process.env, envName);
	if (token === undefined && !isLoopback(host)) {
		throw new UsageError(
			`binding to ${host} exposes the Asana token to the network; set ${envName} to a bearer token clients must present`,
		);
	}
	return token;
}

async function runMcp(argv: readonly string[], version: string): Promise<number> {
	const { values } = parseArgs({ args: [...argv], options: MCP_OPTIONS, strict: true });
	if (values.help === true) {
		console.log(USAGE);
		return 0;
	}
	const context = await createContext(values, {
		mcp: {
			...(values.transport !== undefined && { transport: values.transport }),
			...(values.host !== undefined && { host: values.host }),
			...(values.port !== undefined && { port: Number(values.port) }),
			...(values["allowed-host"] !== undefined && { allowedHosts: values["allowed-host"] }),
			...(values["auth-token-env"] !== undefined && { authTokenEnv: values["auth-token-env"] }),
		},
	});
	const { mcp } = context.loaded.settings;
	const { projectDir } = context.loaded;
	if (projectDir !== undefined) {
		try {
			for (const copy of await refreshSkillCopies(projectDir, version)) {
				context.logger.info(`refreshed ${copy} to the skill of asana-gate ${version}`);
			}
		} catch (error) {
			context.logger.warn(`the skill copies could not be refreshed: ${messageOf(error)}`);
		}
	}
	const gate = await openGate(context);
	const { policy } = gate;
	context.logger.info(
		`policy loaded: workspace ${policy.workspaceName} (${policy.workspace}), ${policy.rules.length} rules`,
	);
	const serving: Serving = await (mcp.transport === "stdio"
		? Promise.resolve(serveOverStdio(gate, version, context.logger))
		: serveHttp({
				gate,
				version,
				logger: context.logger,
				host: mcp.host,
				port: mcp.port,
				allowedHosts: ["localhost", "127.0.0.1", "[::1]", mcp.host, ...mcp.allowedHosts],
				authToken: httpAuthToken(mcp.authTokenEnv, mcp.host),
			}));
	context.logger.info(`serving MCP on ${serving.endpoint}`);
	// Signal listeners do not keep the event loop alive: over stdio the process
	// ends when the client closes stdin; over HTTP the listening socket keeps it
	// up until a signal arrives.
	await Promise.race([once(process, "SIGINT"), once(process, "SIGTERM")]);
	await serving.close();
	return 0;
}

export { runMcp };
