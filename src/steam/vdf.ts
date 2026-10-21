/**
 * Minimal parser for Valve's text KeyValues format (.vdf / .acf).
 * Keys are stored as-is; use `get()` for case-insensitive lookups.
 */
export type VdfObject = { [key: string]: VdfValue };
export type VdfValue = string | VdfObject;

export function parseVdf(text: string): VdfObject {
	let i = 0;
	const len = text.length;

	function skipWs(): void {
		while (i < len) {
			const c = text[i];
			if (c === " " || c === "\t" || c === "\r" || c === "\n" || c === "﻿") {
				i++;
			} else if (c === "/" && text[i + 1] === "/") {
				while (i < len && text[i] !== "\n") i++;
			} else {
				break;
			}
		}
	}

	function readToken(): string | null {
		skipWs();
		if (i >= len) return null;
		const c = text[i];
		if (c === "{" || c === "}") {
			i++;
			return c;
		}
		if (c === '"') {
			i++;
			let out = "";
			while (i < len && text[i] !== '"') {
				if (text[i] === "\\" && i + 1 < len) {
					const n = text[i + 1];
					out += n === "n" ? "\n" : n === "t" ? "\t" : n;
					i += 2;
				} else {
					out += text[i++];
				}
			}
			i++; // closing quote
			return out;
		}
		// unquoted token
		const start = i;
		while (i < len && !/[\s{}"]/.test(text[i])) i++;
		return text.slice(start, i);
	}

	function parseObject(): VdfObject {
		const obj: VdfObject = {};
		for (;;) {
			const key = readToken();
			if (key === null || key === "}") return obj;
			const next = readToken();
			if (next === null) return obj;
			if (next === "{") {
				obj[key] = parseObject();
			} else {
				obj[key] = next;
			}
			// skip optional conditionals like [$WIN32]
			skipWs();
			if (text[i] === "[") {
				while (i < len && text[i] !== "]") i++;
				i++;
			}
		}
	}

	return parseObject();
}

/** Case-insensitive path lookup, e.g. get(root, "UserLocalConfigStore", "Software", "Valve"). */
export function get(obj: VdfValue | undefined, ...path: string[]): VdfValue | undefined {
	let cur: VdfValue | undefined = obj;
	for (const p of path) {
		if (cur === undefined || typeof cur === "string") return undefined;
		const lower = p.toLowerCase();
		const key: string | undefined = Object.keys(cur).find((k) => k.toLowerCase() === lower);
		cur = key === undefined ? undefined : cur[key];
	}
	return cur;
}

export function getString(obj: VdfValue | undefined, ...path: string[]): string | undefined {
	const v = get(obj, ...path);
	return typeof v === "string" ? v : undefined;
}

export function getObject(obj: VdfValue | undefined, ...path: string[]): VdfObject | undefined {
	const v = get(obj, ...path);
	return v !== undefined && typeof v !== "string" ? v : undefined;
}
