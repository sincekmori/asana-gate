#!/usr/bin/env node
// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import { version } from "../package.json" with { type: "json" };
import { main } from "./cli/main.ts";

process.exitCode = await main(process.argv.slice(2), version);
