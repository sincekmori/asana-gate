// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import { createInterface } from "node:readline/promises";

import { describePending } from "../gate/confirmation.ts";
import type { PendingConfirmation } from "../gate/errors.ts";
import type { ConfirmHandler } from "../gate/gate.ts";

/** Whether a person is at the terminal to answer questions. */
function isInteractive(): boolean {
	return process.stdin.isTTY && process.stderr.isTTY;
}

/**
 * The confirmation handler of the command line: `--yes` confirms everything
 * and a terminal asks. A non-interactive run without `--yes` has no handler,
 * so the gate answers 428 and scripts must opt in explicitly.
 */
function cliConfirmHandler(yes: boolean): ConfirmHandler | undefined {
	if (yes) {
		return () => Promise.resolve(true);
	}
	if (!isInteractive()) {
		return undefined;
	}
	return async (pending: readonly PendingConfirmation[]) => {
		const lines = pending.map((p) => `  ${describePending(p)}`);
		const rl = createInterface({ input: process.stdin, output: process.stderr });
		try {
			const answer = await rl.question(
				`The policy asks for confirmation before:\n${lines.join("\n")}\nProceed? [y/N] `,
			);
			return /^y(?:es)?$/iu.test(answer.trim());
		} finally {
			rl.close();
		}
	};
}

export { cliConfirmHandler };
