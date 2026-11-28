// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import type { PolicyContext } from "../../src/policy/compile.ts";

/**
 * The sandbox the tests describe, as the fake Asana seeds it: workspace 1
 * (Acme) with teams 11 (Platform) and 12 (Design), projects 21 (Backend),
 * 22 (Design System) and 23 (Secret), sections 31 (Backlog) and 32 (Done)
 * of project 21, 33 (Inbox) of 22 and 34 (Vault) of 23, tags 41 (ai-ok) and
 * 42 (frozen), users 51 (Me) and 52 (Bob), and custom field 61 (Owner) with
 * options 71 (AI) and 72 (Human).
 */
const WORLD = {
	workspace: { gid: "1", name: "Acme" },
	me: { gid: "51", email: "me@acme.test", name: "Me" },
};

/** Whom the tests compile a policy for: the fake's own user, in its workspace. */
const CONTEXT: PolicyContext = { me: WORLD.me, workspaceName: WORLD.workspace.name };

export { CONTEXT, WORLD };
