import { existsSync, promises as fs } from "node:fs";
import path from "node:path";

import { Jimp } from "jimp";

import type { Game, Logger } from "./library";

const KEY = 144; // @2x key size; Stream Deck scales down for 72px keys

/** Local artwork candidates, best first (old flat layout and new per-app folder layout). */
const LOCAL_NAMES = ["header.jpg", "library_header.jpg", "library_600x900.jpg", "library_capsule.jpg", "capsule_616x353.jpg"];

async function findInDir(dir: string, names: string[], depth = 2): Promise<string | undefined> {
	if (!existsSync(dir)) return undefined;
	for (const n of names) {
		const p = path.join(dir, n);
		if (existsSync(p)) return p;
	}
	if (depth <= 0) return undefined;
	try {
		for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
			if (entry.isDirectory()) {
				const found = await findInDir(path.join(dir, entry.name), names, depth - 1);
				if (found) return found;
			}
		}
	} catch {
		// ignore
	}
	return undefined;
}

export async function findLocalArt(steamPath: string, appid: number): Promise<string | undefined> {
	const cache = path.join(steamPath, "appcache", "librarycache");
	const nested = await findInDir(path.join(cache, String(appid)), LOCAL_NAMES);
	if (nested) return nested;
	for (const n of LOCAL_NAMES) {
		const p = path.join(cache, `${appid}_${n}`);
		if (existsSync(p)) return p;
	}
	return undefined;
}

async function fetchBuffer(url: string): Promise<Buffer | undefined> {
	try {
		const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
		if (!res.ok) return undefined;
		return Buffer.from(await res.arrayBuffer());
	} catch {
		return undefined;
	}
}

interface StoreDetails {
	name?: string;
	header?: string;
}

/** Name and header URL from the public store API (used for favorites that are not installed). */
export async function fetchStoreDetails(appid: number): Promise<StoreDetails | undefined> {
	try {
		const res = await fetch(`https://store.steampowered.com/api/appdetails?appids=${appid}&filters=basic`, {
			signal: AbortSignal.timeout(6000),
		});
		if (!res.ok) return undefined;
		const json = (await res.json()) as Record<string, { success: boolean; data?: { name?: string; header_image?: string } }>;
		const entry = json[String(appid)];
		if (!entry?.success || !entry.data) return undefined;
		return { name: entry.data.name, header: entry.data.header_image };
	} catch {
		return undefined;
	}
}

async function fetchRemoteArt(appid: number, headerUrl?: string): Promise<Buffer | undefined> {
	const urls = [
		headerUrl,
		`https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/${appid}/header.jpg`,
		`https://cdn.cloudflare.steamstatic.com/steam/apps/${appid}/header.jpg`,
		`https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/${appid}/library_600x900.jpg`,
	].filter((u): u is string => !!u);
	for (const url of urls) {
		const buf = await fetchBuffer(url);
		if (buf && buf.length > 1000) return buf;
	}
	return undefined;
}

function escapeXml(s: string): string {
	return s.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]!);
}

/** Splits a name into max 3 short lines for the text fallback tile. */
function wrap(name: string, max = 11): string[] {
	const words = name.split(/\s+/);
	const lines: string[] = [];
	let cur = "";
	for (const w of words) {
		if ((cur + " " + w).trim().length > max && cur) {
			lines.push(cur);
			cur = w;
		} else {
			cur = (cur + " " + w).trim();
		}
	}
	if (cur) lines.push(cur);
	if (lines.length > 3) {
		lines.length = 3;
		lines[2] = lines[2].slice(0, max - 1) + "…";
	}
	return lines.map((l) => (l.length > max + 2 ? l.slice(0, max + 1) + "…" : l));
}

export function svgDataUrl(svg: string): string {
	return `data:image/svg+xml;charset=utf8,${svg}`;
}

/** Text tile used when no artwork is available. */
export function textTile(name: string, installed: boolean): string {
	const lines = wrap(name);
	const startY = 72 - (lines.length - 1) * 13;
	const text = lines
		.map((l, i) => `<text x="72" y="${startY + i * 26}" font-family="Segoe UI, Arial" font-size="22" font-weight="600" fill="#fff" text-anchor="middle" dominant-baseline="middle">${escapeXml(l)}</text>`)
		.join("");
	const bg = installed ? "#16263A" : "#2a2a2a";
	const badge = installed ? "" : `<text x="124" y="24" font-size="20" fill="#94A3B8" text-anchor="middle">⤓</text>`;
	return svgDataUrl(`<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144"><rect width="144" height="144" fill="${bg}"/>${text}${badge}</svg>`);
}

export function emptyTile(): string {
	return svgDataUrl(`<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144"><rect width="144" height="144" fill="#0A111F"/></svg>`);
}

/** Composes artwork into a square key image: blurred backdrop + full artwork centered. */
export async function renderArt(source: Buffer | string, installed: boolean, downloadBadge?: Buffer): Promise<string> {
	const img = await Jimp.read(source as Buffer);
	const bg = img.clone().cover({ w: KEY, h: KEY }).blur(6).brightness(0.45);
	const fg = img.clone().scaleToFit({ w: KEY, h: KEY });
	bg.composite(fg, Math.round((KEY - fg.width) / 2), Math.round((KEY - fg.height) / 2));
	if (!installed) {
		bg.greyscale().brightness(0.7);
		if (downloadBadge) {
			const badge = await Jimp.read(downloadBadge);
			bg.composite(badge, KEY - badge.width - 4, 4);
		}
	}
	return bg.getBase64("image/png");
}

/**
 * Resolves and caches key images per app. Rendered PNGs are stored on disk so
 * paging is instant after the first visit.
 */
export class ArtCache {
	private memory = new Map<string, string>();
	private names = new Map<number, string>();
	private headers = new Map<number, string>();
	private inflight = new Map<string, Promise<string>>();
	private badge?: Buffer;

	constructor(
		private readonly cacheDir: string,
		private readonly badgePath: string | undefined,
		private readonly log: Logger,
	) {}

	async init(): Promise<void> {
		await fs.mkdir(path.join(this.cacheDir, "art"), { recursive: true });
		try {
			const raw = JSON.parse(await fs.readFile(path.join(this.cacheDir, "names.json"), "utf8")) as Record<string, string>;
			for (const [k, v] of Object.entries(raw)) this.names.set(Number(k), v);
		} catch {
			// first run
		}
		if (this.badgePath && existsSync(this.badgePath)) this.badge = await fs.readFile(this.badgePath);
	}

	get knownNames(): Map<number, string> {
		return this.names;
	}

	/** Fills in names for not-installed games (from cache or the store API). Returns true when something changed. */
	async resolveNames(games: Game[]): Promise<boolean> {
		let changed = false;
		const missing = games.filter((g) => !g.installed && /^App \d+$/.test(g.name));
		for (const g of missing) {
			const cached = this.names.get(g.appid);
			if (cached) {
				g.name = cached;
				changed = true;
				continue;
			}
			const details = await fetchStoreDetails(g.appid);
			if (details?.name) {
				g.name = details.name;
				this.names.set(g.appid, details.name);
				if (details.header) this.headers.set(g.appid, details.header);
				changed = true;
			}
		}
		if (changed) {
			await fs
				.writeFile(path.join(this.cacheDir, "names.json"), JSON.stringify(Object.fromEntries(this.names), null, 1))
				.catch(() => undefined);
		}
		return changed;
	}

	async getImage(steamPath: string, game: Game): Promise<string> {
		const key = `${game.appid}-${game.installed ? "i" : "n"}`;
		const mem = this.memory.get(key);
		if (mem) return mem;
		let p = this.inflight.get(key);
		if (!p) {
			p = this.load(steamPath, game, key).finally(() => this.inflight.delete(key));
			this.inflight.set(key, p);
		}
		return p;
	}

	private async load(steamPath: string, game: Game, key: string): Promise<string> {
		const file = path.join(this.cacheDir, "art", `${key}.png`);
		try {
			const buf = await fs.readFile(file);
			const url = `data:image/png;base64,${buf.toString("base64")}`;
			this.memory.set(key, url);
			return url;
		} catch {
			// not cached yet
		}

		try {
			const local = await findLocalArt(steamPath, game.appid);
			const source = local ? await fs.readFile(local) : await fetchRemoteArt(game.appid, this.headers.get(game.appid));
			if (source) {
				const url = await renderArt(source, game.installed, this.badge);
				await fs.writeFile(file, Buffer.from(url.split(",")[1], "base64")).catch(() => undefined);
				this.memory.set(key, url);
				return url;
			}
		} catch (e) {
			this.log.warn(`Artwork for ${game.appid} failed`, e);
		}
		// No artwork: text tile (not cached on disk so we retry next session).
		const tile = textTile(game.name, game.installed);
		this.memory.set(key, tile);
		return tile;
	}

	async clear(): Promise<void> {
		this.memory.clear();
		await fs.rm(path.join(this.cacheDir, "art"), { recursive: true, force: true }).catch(() => undefined);
		await fs.mkdir(path.join(this.cacheDir, "art"), { recursive: true });
	}
}
