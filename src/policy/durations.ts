// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import * as z from "zod";

/** Durations (`24h`, `7d`) and date bounds (`today`, `+7d`, ISO dates) as policies and settings write them. */

/** A duration as policies write it: a number and a unit. */
const DURATION_PATTERN = /^(?<amount>\d+)(?<unit>ms|s|m|h|d|w)$/u;
const UNIT_MS: Record<string, number> = {
	ms: 1,
	s: 1000,
	m: 60_000,
	h: 3_600_000,
	d: 86_400_000,
	w: 604_800_000,
};

/** Parses `24h`, `7d`, `30m`, `500ms` into milliseconds; `undefined` for anything else. */
function parseDuration(text: string): number | undefined {
	const match = DURATION_PATTERN.exec(text.trim());
	const amount = match?.groups?.amount;
	const unit = match?.groups?.unit;
	if (amount === undefined || unit === undefined) {
		return undefined;
	}
	return Number(amount) * (UNIT_MS[unit] ?? 0);
}

/** The milliseconds of a duration {@link DurationSchema} accepted; anything else is a programming error. */
function durationMs(text: string): number {
	const ms = parseDuration(text);
	if (ms === undefined) {
		throw new TypeError(`not a duration: "${text}"`);
	}
	return ms;
}

/** A duration longer than nothing, as policies and settings write it. */
const DurationSchema = z
	.string()
	.regex(DURATION_PATTERN, "a duration such as 30m, 24h or 7d")
	.refine((text) => (parseDuration(text) ?? 0) > 0, "a duration must be longer than 0")
	.describe("A duration: a number followed by ms, s, m, h, d or w");

const RELATIVE_DATE = /^(?<sign>[+-])(?<amount>\d+)(?<unit>d|w|h|m)$/u;

/**
 * The timestamp of a date or date-time, `NaN` when it is none. One without an
 * offset is UTC, as a date alone already is: `Date.parse` would read a
 * date-time like `2026-11-05T09:00` in the machine's time zone, so the gate
 * would judge it differently on different machines. Whatever reads as a
 * valid instant with `Z` appended had no offset of its own.
 */
function parseInstant(text: string): number {
	const utc = Date.parse(`${text}Z`);
	return Number.isNaN(utc) ? Date.parse(text) : utc;
}

/**
 * Resolves a date bound: `today` / `now`, `+7d` / `-1d` (relative to now),
 * or an absolute `YYYY-MM-DD` / ISO 8601 value (UTC without an offset).
 * Resolves to a timestamp.
 */
function resolveDateBound(value: string, now: Date): number | undefined {
	const text = value.trim();
	if (text === "now") {
		return now.getTime();
	}
	if (text === "today") {
		return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
	}
	const relative = RELATIVE_DATE.exec(text);
	if (relative?.groups !== undefined) {
		const amount = Number(relative.groups.amount) * (UNIT_MS[relative.groups.unit ?? "d"] ?? 0);
		return now.getTime() + (relative.groups.sign === "-" ? -amount : amount);
	}
	const absolute = parseInstant(text);
	return Number.isNaN(absolute) ? undefined : absolute;
}

export { DurationSchema, durationMs, parseDuration, parseInstant, resolveDateBound };
