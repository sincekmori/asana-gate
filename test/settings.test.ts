// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { loadSettings } from "../src/settings/load.ts";

/** A home, a project and a managed directory with one settings layer each (plus a drop-in). */
async function scaffold(): Promise<{ home: string; project: string; managed: string }> {
	const root = await mkdtemp(join(tmpdir(), "asana-gate-settings-"));
	const home = join(root, "home");
	const project = join(root, "repo");
	const managed = join(root, "managed");
	await Promise.all([
		mkdir(home, { recursive: true }),
		mkdir(join(project, ".asana-gate"), { recursive: true }),
		mkdir(join(managed, "managed-settings.d"), { recursive: true }),
	]);
	await Promise.all([
		writeFile(join(home, "settings.yaml"), "log: { level: info }\nretries: { maxWait: 9s }\n"),
		writeFile(
			join(project, ".asana-gate", "settings.yaml"),
			"policy: policy.yaml\nconcurrency: { reads: 5 }\nlog: { file: logs/gate.log }\n",
		),
		writeFile(join(project, ".asana-gate", "settings.local.yaml"), "log: { level: debug }\n"),
		writeFile(join(managed, "managed-settings.yaml"), "retries: { max: 1 }\n"),
		writeFile(
			join(managed, "managed-settings.d", "10-writes.yaml"),
			"concurrency: { writes: 2 }\n",
		),
	]);
	return { home, project, managed };
}

describe("settings", () => {
	it("merges the layers in precedence order and resolves paths against their files", async () => {
		const { home, project, managed } = await scaffold();
		const loaded = await loadSettings({
			cwd: join(project, "src"),
			home,
			managedDir: managed,
			env: { ASANA_GATE_LOG_LEVEL: "error" },
		});
		expect(loaded.settings.log).toStrictEqual({
			level: "error",
			file: join(project, ".asana-gate", "logs", "gate.log"),
		});
		expect(loaded.settings.retries).toStrictEqual({ max: 1, maxWait: "9s" });
		expect(loaded.settings.concurrency).toStrictEqual({ reads: 5, writes: 2 });
		expect(loaded.settings.policy).toBe(join(project, ".asana-gate", "policy.yaml"));
		expect(loaded.projectDir).toBe(project);
	});

	it("merges asana.enable and asana.disable across layers and refuses a value that is no flag", async () => {
		const { home, project, managed } = await scaffold();
		await writeFile(
			join(project, ".asana-gate", "settings.yaml"),
			"asana: { enable: [ai_teammate_actors] }\n",
		);
		await writeFile(join(home, "settings.yaml"), "asana: { disable: [a_third_change] }\n");
		const loaded = await loadSettings({ cwd: project, home, managedDir: managed, env: {} });
		expect(loaded.settings.asana).toStrictEqual({
			enable: ["ai_teammate_actors"],
			disable: ["a_third_change"],
		});
		await writeFile(join(home, "settings.yaml"), "asana: { enable: [Not-A-Flag] }\n");
		await expect(
			loadSettings({ cwd: project, home, managedDir: managed, env: {} }),
		).rejects.toThrow("a flag is lowercase letters, digits and underscores");
	});

	it("tells where each value came from", async () => {
		const { home, project, managed } = await scaffold();
		const loaded = await loadSettings({
			cwd: project,
			home,
			managedDir: managed,
			env: { ASANA_GATE_LOG_LEVEL: "error" },
		});
		expect(loaded.origins.get("retries.max")).toBe(join(managed, "managed-settings.yaml"));
		expect(loaded.origins.get("concurrency.writes")).toBe(
			join(managed, "managed-settings.d", "10-writes.yaml"),
		);
		expect(loaded.origins.get("log.level")).toBe("env");
		expect(loaded.origins.get("retries.maxWait")).toBe(join(home, "settings.yaml"));
		expect(loaded.origins.get("mcp.port")).toBe("defaults");
	});

	it("lets flags beat files and the environment, but never managed settings", async () => {
		const { home, project, managed } = await scaffold();
		const loaded = await loadSettings({
			cwd: project,
			home,
			managedDir: managed,
			env: { ASANA_GATE_LOG_LEVEL: "error" },
			flags: { retries: { max: 9 }, log: { level: "silent" } },
		});
		expect(loaded.settings.retries.max).toBe(1);
		expect(loaded.settings.log.level).toBe("silent");
		expect(loaded.origins.get("log.level")).toBe("flags");
	});

	it("keeps token.command out of project settings and names a malformed file", async () => {
		const { home, project, managed } = await scaffold();
		await writeFile(
			join(project, ".asana-gate", "settings.local.yaml"),
			"token: { command: 'cat ~/.secret' }\n",
		);
		await expect(
			loadSettings({ cwd: project, home, managedDir: managed, env: {} }),
		).rejects.toThrow(/token\.command may only be set/u);
		await writeFile(join(home, "settings.yaml"), "retries: { maxWait: soon }\n");
		await expect(loadSettings({ cwd: home, home, managedDir: managed, env: {} })).rejects.toThrow(
			/settings\.yaml/u,
		);
	});

	it("falls back to the defaults when nothing is configured", async () => {
		const root = await mkdtemp(join(tmpdir(), "asana-gate-empty-"));
		const loaded = await loadSettings({
			cwd: root,
			home: join(root, "home"),
			managedDir: join(root, "managed"),
			env: {},
		});
		expect(loaded.settings.token).toStrictEqual({ env: "ASANA_ACCESS_TOKEN" });
		expect(loaded.settings.concurrency).toStrictEqual({ reads: 50, writes: 15 });
		expect(loaded.settings.mcp.transport).toBe("stdio");
		expect(loaded.projectDir).toBeUndefined();
	});

	it("never takes the asana-gate home for a project's directory", async () => {
		const root = await mkdtemp(join(tmpdir(), "asana-gate-home-"));
		const home = join(root, "user", ".asana-gate");
		await mkdir(join(root, "user", "work"), { recursive: true });
		await mkdir(home, { recursive: true });
		await writeFile(join(home, "settings.yaml"), "log: { level: warn }\n");
		const loaded = await loadSettings({
			cwd: join(root, "user", "work"),
			home,
			managedDir: join(root, "managed"),
			env: {},
		});
		expect(loaded.projectDir).toBeUndefined();
		expect(loaded.origins.get("log.level")).toBe(join(home, "settings.yaml"));
	});

	it("never takes the asana-gate home for a project's directory when a symbolic link leads to it", async () => {
		const temporary = await mkdtemp(join(tmpdir(), "asana-gate-link-"));
		const root = await realpath(temporary);
		const user = join(root, "user");
		await mkdir(join(user, ".asana-gate"), { recursive: true });
		await mkdir(join(user, "work"), { recursive: true });
		await symlink(user, join(root, "home"));
		// $HOME names the link; the working directory comes with the links resolved, as process.cwd() gives it.
		const loaded = await loadSettings({
			cwd: join(user, "work"),
			home: join(root, "home", ".asana-gate"),
			managedDir: join(root, "managed"),
			env: {},
		});
		expect(loaded.projectDir).toBeUndefined();
	});

	it("fails rather than skip a managed drop-in directory it cannot list", async () => {
		const { home, project } = await scaffold();
		const managed = await mkdtemp(join(tmpdir(), "asana-gate-managed-"));
		const dropIns = join(managed, "managed-settings.d");
		await writeFile(dropIns, "");
		const none = await loadSettings({ cwd: project, home, managedDir: managed, env: {} });
		expect(none.settings.concurrency.writes).toBe(15);
		await rm(dropIns);
		// A link to itself: listing it fails (ELOOP) for root as for anyone, like an unreadable directory.
		await symlink(dropIns, dropIns);
		await expect(
			loadSettings({ cwd: project, home, managedDir: managed, env: {} }),
		).rejects.toThrow(/cannot read .*managed-settings\.d: ELOOP/u);
	});
});
