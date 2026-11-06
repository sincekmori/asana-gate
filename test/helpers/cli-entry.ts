// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

/**
 * The command line as `src/cli.ts` runs it, top-level await included, with
 * the fake Asana answering in place of Asana: the entry of a child process,
 * for tests that watch the process itself (its stdio and its exit code).
 */

import { main } from "../../src/cli/main.ts";
import { createFakeAsana } from "./fake-asana.ts";

globalThis.fetch = createFakeAsana().fetch;
// The exit code of src/cli.ts's own top-level await is what such a test watches.
// oxlint-disable-next-line node/no-top-level-await
process.exitCode = await main(process.argv.slice(2), "0.0.0-test");
