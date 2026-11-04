// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import {
	chmod,
	lstat,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { tokenOf, tokenPlaces, tokenText } from "../src/cli/token.ts";
import { type LoadedSettings, loadSettings } from "../src/settings/load.ts";
import { ensureLine, privateFile } from "../src/system.ts";

/** An environment variable nothing sets, so the token comes from files. */
const UNSET = "ASANA_GATE_TEST_NO_SUCH_VARIABLE";

/** A home and a project directory, both empty. */
async function scaffold(): Promise<{ home: string; project: string }> {
	const root = await mkdtemp(join(tmpdir(), "asana-gate-token-"));
	const home = join(root, "home");
	const project = join(root, "repo");
	await Promise.all([
		mkdir(home, { recursive: true }),
		mkdir(join(project, ".asana-gate"), { recursive: true }),
	]);
	return { home, project };
}

function load(cwd: string, home: string): Promise<LoadedSettings> {
	return loadSettings({
		cwd,
		home,
		managedDir: join(home, "managed"),
		env: {},
		flags: { token: { env: UNSET } },
	});
}

/** The permission bits of `path`. */
async function modeOf(path: string): Promise<number> {
	const info = await stat(path);
	return info.mode % 0o1000;
}

describe("private files", () => {
	it.skipIf(process.platform === "win32")(
		"are written 0600 over a file others could read, and through a symbolic link",
		async () => {
			const root = await mkdtemp(join(tmpdir(), "asana-gate-private-"));
			const dir = join(root, "dir");
			const file = join(dir, "token");
			await privateFile(file, "a\n");
			const created = await Promise.all([modeOf(file), modeOf(dir)]);
			expect(created).toStrictEqual([0o600, 0o700]);
			await chmod(file, 0o644);
			await privateFile(file, "b\n");
			await expect(modeOf(file)).resolves.toBe(0o600);
			const link = join(root, "link");
			await symlink(file, link);
			await privateFile(link, "c\n");
			const linked = await lstat(link);
			expect(linked.isSymbolicLink()).toBe(true);
			await expect(readFile(file, "utf8")).resolves.toBe("c\n");
			await expect(readdir(dir)).resolves.toStrictEqual(["token"]);
		},
	);
});

describe("token files", () => {
	it("prefers the project's token file over the home directory's", async () => {
		const { home, project } = await scaffold();
		const projectFile = join(project, ".asana-gate", "token");
		await writeFile(join(home, "token"), "home-token\n");
		await writeFile(projectFile, "project-token\n");
		const loaded = await load(project, home);
		expect(tokenPlaces(loaded).map((place) => place.file)).toStrictEqual([
			projectFile,
			join(home, "token"),
		]);
		await expect(tokenOf(loaded)).resolves.toMatchObject({
			token: "project-token",
			source: projectFile,
			file: projectFile,
		});
	});

	it("falls back to the home directory's file, and names the places it looked", async () => {
		const { home, project } = await scaffold();
		await writeFile(join(home, "token"), "home-token\n");
		const loaded = await load(project, home);
		await expect(tokenOf(loaded)).resolves.toMatchObject({
			token: "home-token",
			source: join(home, "token"),
		});
		await writeFile(join(home, "token"), "\n");
		await expect(tokenOf(loaded)).rejects.toThrow(/is empty/u);
		await rm(join(home, "token"));
		await expect(tokenOf(loaded)).rejects.toThrow(/asana-gate token set/u);
	});

	it("reads token.file from the settings, relative to the settings file", async () => {
		const { home, project } = await scaffold();
		await writeFile(
			join(project, ".asana-gate", "settings.yaml"),
			"token: { file: secrets/asana }\n",
		);
		await mkdir(join(project, ".asana-gate", "secrets"), { recursive: true });
		await writeFile(join(project, ".asana-gate", "secrets", "asana"), "from-file");
		const loaded = await load(project, home);
		await expect(tokenOf(loaded)).resolves.toMatchObject({
			token: "from-file",
			file: join(project, ".asana-gate", "secrets", "asana"),
		});
	});

	it("takes the first line of a token file and refuses control characters without quoting them", async () => {
		const { home, project } = await scaffold();
		const file = join(project, ".asana-gate", "token");
		await writeFile(file, "first-line\r\nsecond-line\n");
		await expect(tokenOf(await load(project, home))).resolves.toMatchObject({
			token: "first-line",
		});
		await writeFile(file, "sec\u0007ret\n");
		const refused = tokenOf(await load(project, home));
		await expect(refused).rejects.toThrow(`${file}: the token contains a control character`);
		await expect(refused).rejects.not.toThrow(/sec.ret/u);
	});

	it("does not add a line a CRLF file already has", async () => {
		const { project } = await scaffold();
		const file = join(project, ".asana-gate", ".gitignore");
		await writeFile(file, "token\r\nlogs\r\n");
		await ensureLine(file, "token");
		await expect(readFile(file, "utf8")).resolves.toBe("token\r\nlogs\r\n");
	});

	it("reads piped and command output the same way", () => {
		expect(tokenText("  abc  \nignored", "stdin")).toBe("abc");
		expect(tokenText("", "stdin")).toBe("");
		expect(() => tokenText("a\tb", "token.command")).toThrow(/^token\.command: /u);
	});
});
