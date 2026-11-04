// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

/** The message of a thrown value, whatever its type. */
function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export { messageOf };
