import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import streamDeck, { type KeyAction as SdKeyAction } from "@elgato/streamdeck";
import type { JsonObject } from "@elgato/utils";

type KeyAction = SdKeyAction<JsonObject>;

import { PROFILES } from "./profiles.generated";
import { ArtCache, emptyTile, svgDataUrl } from "./steam/images";
import { type Game, type LibrarySnapshot, type Mode, MODES, scanLibrary, selectGames, type Sort } from "./steam/library";

export type GlobalSettings = {
	mode?: Mode;
	sort?: Sort;
	favoritesCollection?: string;
	showTitles?: boolean;
	returnAfterLaunch?: boolean;
	steamPath?: string;
};

export const MODE_LABEL: Record<Mode, { icon: string; label: string }> = {
	favorites: { icon: "★", label: "Favorites" },
	installed: { icon: "▣", label: "Installed" },
	recent: { icon: "↻", label: "Recent" },
	all: { icon: "∞", label: "All" },
};

const PLUGIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STALE_MS = 20_000;
/** Outside the plugin folder so it survives updates and never touches protected plugin files. */
const CACHE_DIR = path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), ".cache"), "quin.tools", "GameLauncherForSteam");

const log = {
	info: (...a: unknown[]) => streamDeck.logger.info(...a),
	warn: (...a: unknown[]) => streamDeck.logger.warn(...a),
	error: (...a: unknown[]) => streamDeck.logger.error(...a),
};

/** Minimal surface the controller needs from each action class. */
export interface ActionSource {
	readonly actions: Iterable<{ isKey(): boolean; device: { id: string } } & Partial<KeyAction>>;
}

function escapeXml(s: string): string {
	return s.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]!);
}

function labelTile(big: string, small: string, accent = "#38BDF8", dim = false): string {
	return svgDataUrl(
		`<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">` +
			`<rect width="144" height="144" fill="#101A2B"/>` +
			`<text x="72" y="66" font-family="Segoe UI Symbol, Segoe UI, Arial" font-size="58" fill="${dim ? "#33445C" : accent}" text-anchor="middle" dominant-baseline="middle">${escapeXml(big)}</text>` +
			`<text x="72" y="118" font-family="Segoe UI, Arial" font-size="22" font-weight="600" fill="${dim ? "#33445C" : "#CBD5E1"}" text-anchor="middle">${escapeXml(small)}</text>` +
			`</svg>`,
	);
}

class Controller {
	settings: Required<Omit<GlobalSettings, "steamPath">> & { steamPath?: string } = {
		mode: "favorites",
		sort: "recent",
		favoritesCollection: "favorite",
		showTitles: false,
		returnAfterLaunch: true,
	};
	lib?: LibrarySnapshot;
	error?: string;

	private loading?: Promise<void>;
	private pages = new Map<string, number>();
	private renderTimers = new Map<string, NodeJS.Timeout>();
	private renderToken = new Map<string, number>();
	private art = new ArtCache(CACHE_DIR, path.join(PLUGIN_DIR, "imgs", "overlay", "download.png"), log);
	private artReady = this.art.init().catch((e) => log.error("Cache init failed", e));

	slots?: ActionSource;
	navs: ActionSource[] = [];
	backs?: ActionSource;

	/** Opens the bundled, auto-filled game grid on this device. Returns false for unsupported decks. */
	async openGrid(device: { id: string; type: number }): Promise<boolean> {
		const profile = PROFILES[device.type];
		if (!profile) {
			log.warn(`No bundled profile for device type ${device.type}`);
			return false;
		}
		this.resetPage(device.id);
		void this.ensureLibrary();
		await streamDeck.profiles.switchToProfile(device.id, profile, 0);
		return true;
	}

	/** Back to whatever profile was active before the grid opened. */
	async closeGrid(deviceId: string): Promise<void> {
		await streamDeck.profiles.switchToProfile(deviceId);
	}

	/** True when the bundled grid (recognisable by its Back key) is showing on this device. */
	isGridOpen(deviceId: string): boolean {
		if (!this.backs) return false;
		for (const a of this.backs.actions) if (a.device.id === deviceId) return true;
		return false;
	}

	applySettings(s: GlobalSettings): void {
		this.settings = {
			mode: s.mode && MODES.includes(s.mode) ? s.mode : this.settings.mode,
			sort: s.sort === "name" ? "name" : s.sort === "recent" ? "recent" : this.settings.sort,
			favoritesCollection: s.favoritesCollection || this.settings.favoritesCollection,
			showTitles: s.showTitles ?? this.settings.showTitles,
			returnAfterLaunch: s.returnAfterLaunch ?? this.settings.returnAfterLaunch,
			steamPath: s.steamPath?.trim() || undefined,
		};
	}

	async saveSettings(): Promise<void> {
		await streamDeck.settings.setGlobalSettings({ ...this.settings });
	}

	/** Scans Steam when there is no snapshot yet, it is stale, or when forced. */
	async ensureLibrary(force = false): Promise<void> {
		if (!force && this.lib && Date.now() - this.lib.scannedAt < STALE_MS) return;
		if (this.loading) return this.loading;
		this.loading = (async () => {
			try {
				await this.artReady;
				this.lib = await scanLibrary({ steamPath: this.settings.steamPath, names: this.art.knownNames, log });
				this.error = undefined;
				// Resolve names of not-installed favorites in the background, then re-render.
				const unnamed = [...this.lib.games.values()].filter((g) => !g.installed);
				if (unnamed.length) {
					void this.art.resolveNames(unnamed).then((changed) => changed && this.renderAll());
				}
			} catch (e) {
				this.error = e instanceof Error ? e.message : String(e);
				log.error("Scan failed", e);
			} finally {
				this.loading = undefined;
			}
		})();
		return this.loading;
	}

	list(): Game[] {
		if (!this.lib) return [];
		return selectGames(this.lib, this.settings.mode, this.settings.sort, this.settings.favoritesCollection);
	}

	/** Visible game-slot keys on a device, ordered left-to-right, top-to-bottom. */
	slotKeys(deviceId: string): KeyAction[] {
		if (!this.slots) return [];
		const keys: KeyAction[] = [];
		for (const a of this.slots.actions) {
			if (!a.isKey() || a.device.id !== deviceId) continue;
			const key = a as unknown as KeyAction;
			if (key.isInMultiAction() || !key.coordinates) continue;
			keys.push(key);
		}
		return keys.sort((a, b) => a.coordinates!.row - b.coordinates!.row || a.coordinates!.column - b.coordinates!.column);
	}

	pageCount(deviceId: string): number {
		const per = Math.max(1, this.slotKeys(deviceId).length);
		return Math.max(1, Math.ceil(this.list().length / per));
	}

	page(deviceId: string): number {
		const p = this.pages.get(deviceId) ?? 0;
		return Math.min(p, this.pageCount(deviceId) - 1);
	}

	setPage(deviceId: string, page: number): void {
		const count = this.pageCount(deviceId);
		this.pages.set(deviceId, ((page % count) + count) % count);
		this.scheduleRender(deviceId);
	}

	resetPage(deviceId: string): void {
		this.pages.set(deviceId, 0);
	}

	gameForKey(key: KeyAction): Game | undefined {
		const keys = this.slotKeys(key.device.id);
		const idx = keys.findIndex((k) => k.id === key.id);
		if (idx < 0) return undefined;
		return this.list()[this.page(key.device.id) * keys.length + idx];
	}

	async cycleMode(deviceId: string): Promise<void> {
		const next = MODES[(MODES.indexOf(this.settings.mode) + 1) % MODES.length];
		this.settings.mode = next;
		this.resetPage(deviceId);
		await this.saveSettings();
		this.renderAll();
	}

	scheduleRender(deviceId: string): void {
		clearTimeout(this.renderTimers.get(deviceId));
		this.renderTimers.set(
			deviceId,
			setTimeout(() => void this.render(deviceId).catch((e) => log.error("Render failed", e)), 40),
		);
	}

	renderAll(): void {
		const devices = new Set<string>();
		for (const src of [this.slots, ...this.navs]) {
			if (!src) continue;
			for (const a of src.actions) devices.add(a.device.id);
		}
		devices.forEach((d) => this.scheduleRender(d));
	}

	private async render(deviceId: string): Promise<void> {
		const keys = this.slotKeys(deviceId);
		const list = this.list();
		const page = this.page(deviceId);
		const pages = this.pageCount(deviceId);

		// Navigation and filter keys.
		for (const src of this.navs) {
			for (const a of src.actions) {
				if (a.device.id !== deviceId || !a.isKey()) continue;
				const key = a as unknown as KeyAction & { manifestId: string };
				const kind = key.manifestId.split(".").pop();
				if (kind === "next") await key.setImage(labelTile("▶", `${page + 1}/${pages}`, undefined, pages <= 1));
				else if (kind === "prev") await key.setImage(labelTile("◀", `${page + 1}/${pages}`, undefined, pages <= 1));
				else if (kind === "filter") {
					const m = MODE_LABEL[this.settings.mode];
					await key.setImage(labelTile(m.icon, this.error ? "No Steam" : `${m.label} ${list.length}`, this.error ? "#e35b5b" : "#38BDF8"));
				}
				await key.setTitle("");
			}
		}

		// Game slots.
		const token = (this.renderToken.get(deviceId) ?? 0) + 1;
		this.renderToken.set(deviceId, token);
		const start = page * keys.length;
		await Promise.all(
			keys.map(async (key, i) => {
				const game = list[start + i];
				if (!game || !this.lib) {
					await key.setImage(emptyTile());
					await key.setTitle(i === 0 && this.lib && list.length === 0 ? "Empty" : "");
					return;
				}
				const img = await this.art.getImage(this.lib.steamPath, game);
				if (this.renderToken.get(deviceId) !== token) return; // a newer render took over
				await key.setImage(img);
				const isTextTile = img.startsWith("data:image/svg");
				await key.setTitle(this.settings.showTitles && !isTextTile ? shortTitle(game.name) : "");
			}),
		);
	}

	async rescan(): Promise<void> {
		await this.art.clear();
		await this.ensureLibrary(true);
		this.renderAll();
	}

	launch(game: Game): void {
		const url = `steam://rungameid/${game.appid}`;
		log.info(`Launch ${game.name} (${url})`);
		try {
			const cmd = process.platform === "win32" ? "explorer.exe" : process.platform === "darwin" ? "open" : "xdg-open";
			const child = spawn(cmd, [url], { detached: true, stdio: "ignore", windowsHide: true });
			child.on("error", () => void streamDeck.system.openUrl(url));
			child.unref();
		} catch {
			void streamDeck.system.openUrl(url);
		}
	}

	collectionItems(): { label: string; value: string }[] {
		const items = [{ label: "Steam Favorites", value: "favorite" }];
		for (const c of this.lib?.collections ?? []) {
			if (c.id === "favorite" || c.id === "hidden") continue;
			items.push({ label: `${c.name} (${c.appids.length})`, value: c.id });
		}
		return items;
	}
}

function shortTitle(name: string): string {
	const clean = name.replace(/[™®©]/g, "").trim();
	return clean.length > 14 ? clean.slice(0, 13) + "…" : clean;
}

export const controller = new Controller();
