import { execFile } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { getObject, getString, parseVdf, type VdfObject } from "./vdf";

const execFileAsync = promisify(execFile);
const STEAMID64_BASE = 76561197960265728n;

/** Apps that are tools/runtimes rather than games. */
const EXCLUDED_APPIDS = new Set([228980, 1070560, 1391110, 1628350, 1493710, 1826330, 1161040]);
const EXCLUDED_NAME = /(redistributable|steam linux runtime|^proton\b|steamworks common|dedicated server)/i;

export interface Game {
	appid: number;
	name: string;
	installed: boolean;
	/** Unix seconds, 0 when never played. */
	lastPlayed: number;
	/** Steam StateFlags from the appmanifest; 4 = fully installed. */
	stateFlags: number;
	libraryPath?: string;
}

export interface Collection {
	id: string;
	name: string;
	appids: number[];
}

export interface LibrarySnapshot {
	steamPath: string;
	accountId?: string;
	games: Map<number, Game>;
	collections: Collection[];
	hidden: Set<number>;
	scannedAt: number;
}

export interface Logger {
	info(...args: unknown[]): void;
	warn(...args: unknown[]): void;
	error(...args: unknown[]): void;
}

const silentLogger: Logger = { info() {}, warn() {}, error() {} };

/** Finds the Steam install folder (registry first, then common defaults). */
export async function findSteamPath(override?: string): Promise<string | undefined> {
	if (override && existsSync(override)) return override;

	if (process.platform === "win32") {
		for (const [hive, value] of [
			["HKCU\\Software\\Valve\\Steam", "SteamPath"],
			["HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam", "InstallPath"],
			["HKLM\\SOFTWARE\\Valve\\Steam", "InstallPath"],
		]) {
			try {
				const { stdout } = await execFileAsync("reg", ["query", hive, "/v", value], { windowsHide: true });
				const m = stdout.match(new RegExp(`${value}\\s+REG_\\w+\\s+(.+)`, "i"));
				if (m) {
					const p = path.normalize(m[1].trim());
					if (existsSync(p)) return p;
				}
			} catch {
				// try next
			}
		}
		for (const p of ["C:\\Program Files (x86)\\Steam", "C:\\Program Files\\Steam"]) {
			if (existsSync(p)) return p;
		}
	} else if (process.platform === "darwin") {
		const p = path.join(os.homedir(), "Library", "Application Support", "Steam");
		if (existsSync(p)) return p;
	} else {
		for (const p of [path.join(os.homedir(), ".steam", "steam"), path.join(os.homedir(), ".local", "share", "Steam")]) {
			if (existsSync(p)) return p;
		}
	}
	return undefined;
}

async function readVdf(file: string): Promise<VdfObject | undefined> {
	try {
		return parseVdf(await fs.readFile(file, "utf8"));
	} catch {
		return undefined;
	}
}

/** All library folders (supports the old and new libraryfolders.vdf layouts). */
export async function getLibraryFolders(steamPath: string): Promise<string[]> {
	const folders = new Set<string>([steamPath]);
	const vdf =
		(await readVdf(path.join(steamPath, "steamapps", "libraryfolders.vdf"))) ??
		(await readVdf(path.join(steamPath, "config", "libraryfolders.vdf")));
	const root = getObject(vdf, "libraryfolders");
	if (root) {
		for (const [key, value] of Object.entries(root)) {
			if (!/^\d+$/.test(key)) continue;
			const p = typeof value === "string" ? value : getString(value, "path");
			if (p) folders.add(path.normalize(p));
		}
	}
	return [...folders].filter((f) => existsSync(path.join(f, "steamapps")));
}

/** Picks the account that logged in most recently, falling back to the newest userdata folder. */
export async function findAccountId(steamPath: string): Promise<string | undefined> {
	const userdata = path.join(steamPath, "userdata");
	const users = getObject(await readVdf(path.join(steamPath, "config", "loginusers.vdf")), "users");
	if (users) {
		const entries = Object.entries(users).filter(([id]) => /^\d+$/.test(id));
		const best =
			entries.find(([, u]) => getString(u, "MostRecent") === "1") ??
			entries.sort((a, b) => Number(getString(b[1], "Timestamp") ?? 0) - Number(getString(a[1], "Timestamp") ?? 0))[0];
		if (best) {
			const accountId = (BigInt(best[0]) - STEAMID64_BASE).toString();
			if (existsSync(path.join(userdata, accountId))) return accountId;
		}
	}
	try {
		const dirs = (await fs.readdir(userdata)).filter((d) => /^\d+$/.test(d) && d !== "0");
		let newest: { id: string; mtime: number } | undefined;
		for (const d of dirs) {
			const stat = await fs.stat(path.join(userdata, d, "config", "localconfig.vdf")).catch(() => undefined);
			const mtime = stat?.mtimeMs ?? 0;
			if (!newest || mtime > newest.mtime) newest = { id: d, mtime };
		}
		return newest?.id;
	} catch {
		return undefined;
	}
}

async function scanInstalled(folders: string[], log: Logger): Promise<Game[]> {
	const games: Game[] = [];
	for (const folder of folders) {
		const steamapps = path.join(folder, "steamapps");
		let files: string[] = [];
		try {
			files = (await fs.readdir(steamapps)).filter((f) => /^appmanifest_\d+\.acf$/i.test(f));
		} catch (e) {
			log.warn(`Cannot read ${steamapps}`, e);
			continue;
		}
		for (const file of files) {
			const state = getObject(await readVdf(path.join(steamapps, file)), "AppState");
			if (!state) continue;
			const appid = Number(getString(state, "appid"));
			const name = getString(state, "name") ?? `App ${appid}`;
			if (!appid) continue;
			games.push({
				appid,
				name,
				installed: true,
				lastPlayed: Number(getString(state, "LastPlayed") ?? 0) || 0,
				stateFlags: Number(getString(state, "StateFlags") ?? 4) || 0,
				libraryPath: folder,
			});
		}
	}
	return games;
}

/** LastPlayed per app from the user's localconfig.vdf. */
async function readLastPlayed(steamPath: string, accountId: string): Promise<Map<number, number>> {
	const result = new Map<number, number>();
	const vdf = await readVdf(path.join(steamPath, "userdata", accountId, "config", "localconfig.vdf"));
	const apps = getObject(vdf, "UserLocalConfigStore", "Software", "Valve", "Steam", "apps");
	if (apps) {
		for (const [id, data] of Object.entries(apps)) {
			const lp = Number(getString(data, "LastPlayed") ?? 0);
			if (lp > 0) result.set(Number(id), lp);
		}
	}
	return result;
}

/** Static user collections (incl. Favorites and Hidden) from the new Steam library's cloud storage. */
export async function readCollections(steamPath: string, accountId: string, log: Logger = silentLogger): Promise<Collection[]> {
	const file = path.join(steamPath, "userdata", accountId, "config", "cloudstorage", "cloud-storage-namespace-1.json");
	let raw: unknown;
	try {
		raw = JSON.parse(await fs.readFile(file, "utf8"));
	} catch {
		log.info(`No collections found (${file})`);
		return [];
	}
	if (!Array.isArray(raw)) return [];

	const collections: Collection[] = [];
	for (const entry of raw) {
		if (!Array.isArray(entry) || entry.length < 2) continue;
		const [key, meta] = entry as [string, { value?: string; is_deleted?: boolean }];
		if (typeof key !== "string" || !key.startsWith("user-collections.") || !meta || meta.is_deleted || !meta.value) continue;
		try {
			const value = JSON.parse(meta.value) as { id?: string; name?: string; added?: number[]; removed?: number[] };
			if (!Array.isArray(value.added)) continue; // dynamic collections only have a filterSpec
			const removed = new Set(value.removed ?? []);
			const id = value.id ?? key.slice("user-collections.".length);
			collections.push({
				id,
				name: value.name || (id === "favorite" ? "Favorites" : id === "hidden" ? "Hidden" : id),
				appids: value.added.filter((a) => !removed.has(a)),
			});
		} catch {
			// ignore malformed entry
		}
	}
	return collections;
}

/** Full scan: installed games, last played, collections and hidden apps. */
export async function scanLibrary(opts: { steamPath?: string; names?: Map<number, string>; log?: Logger } = {}): Promise<LibrarySnapshot> {
	const log = opts.log ?? silentLogger;
	const steamPath = await findSteamPath(opts.steamPath);
	if (!steamPath) throw new Error("Steam installation not found");

	const folders = await getLibraryFolders(steamPath);
	const installed = await scanInstalled(folders, log);
	const accountId = await findAccountId(steamPath);
	const lastPlayed = accountId ? await readLastPlayed(steamPath, accountId) : new Map<number, number>();
	const collections = accountId ? await readCollections(steamPath, accountId, log) : [];

	const games = new Map<number, Game>();
	for (const g of installed) {
		if (EXCLUDED_APPIDS.has(g.appid) || EXCLUDED_NAME.test(g.name)) continue;
		g.lastPlayed = Math.max(g.lastPlayed, lastPlayed.get(g.appid) ?? 0);
		games.set(g.appid, g);
	}

	// Collection members that are not installed still deserve an entry.
	for (const c of collections) {
		if (c.id === "hidden") continue;
		for (const appid of c.appids) {
			if (games.has(appid) || EXCLUDED_APPIDS.has(appid)) continue;
			games.set(appid, {
				appid,
				name: opts.names?.get(appid) ?? `App ${appid}`,
				installed: false,
				lastPlayed: lastPlayed.get(appid) ?? 0,
				stateFlags: 0,
			});
		}
	}

	const hidden = new Set(collections.find((c) => c.id === "hidden")?.appids ?? []);
	log.info(`Steam: ${steamPath}, account ${accountId ?? "?"}, ${folders.length} libraries, ${installed.length} manifests, ${collections.length} collections`);
	return { steamPath, accountId, games, collections, hidden, scannedAt: Date.now() };
}

export type Mode = "favorites" | "installed" | "recent" | "all";
export type Sort = "recent" | "name";

export const MODES: Mode[] = ["favorites", "installed", "recent", "all"];

/** Returns the ordered game list for a filter mode. */
export function selectGames(lib: LibrarySnapshot, mode: Mode, sort: Sort, favoritesCollection = "favorite"): Game[] {
	const all = [...lib.games.values()].filter((g) => !lib.hidden.has(g.appid));
	let list: Game[];
	switch (mode) {
		case "favorites": {
			const ids = new Set(lib.collections.find((c) => c.id === favoritesCollection)?.appids ?? []);
			list = all.filter((g) => ids.has(g.appid));
			break;
		}
		case "installed":
			list = all.filter((g) => g.installed);
			break;
		case "recent":
			list = all.filter((g) => g.lastPlayed > 0);
			break;
		default:
			list = all;
	}
	const byName = (a: Game, b: Game) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
	if (mode === "recent" || sort === "recent") {
		list.sort((a, b) => b.lastPlayed - a.lastPlayed || byName(a, b));
	} else {
		list.sort(byName);
	}
	return list;
}
