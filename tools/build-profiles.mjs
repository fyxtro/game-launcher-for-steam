/**
 * Generates the bundled Stream Deck profiles (the auto-filled game grid) and
 * registers them in manifest.json.
 *
 * Format: Stream Deck profile schema 3.0, as written by Stream Deck 7.x:
 *   <PROFILE-UUID>.sdProfile/manifest.json
 *   <PROFILE-UUID>.sdProfile/Profiles/<PAGE-UUID>/manifest.json   (Controllers > Keypad > Actions "col,row")
 *
 * Stream Deck installs a bundled profile only once per file name. When a layout
 * changes after release, bump REVISION so the file name changes too.
 *
 * Run: node tools/build-profiles.mjs
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import AdmZip from "adm-zip";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_UUID = "tools.quin.steamlibrary";
const PLUGIN_DIR = path.join(ROOT, `${PLUGIN_UUID}.sdPlugin`);
const PLUGIN_NAME = "Game Launcher for Steam";
const BASE = "Game Launcher";
const REVISION = 1;

/** Supported decks. Keep suffixes in sync with PROFILE_SUFFIX in src/profiles.ts. */
const DECKS = [
	{ deviceType: 0, suffix: " (Stream Deck)", model: "20GBA9901", columns: 5, rows: 3 },
	{ deviceType: 1, suffix: " (Stream Deck Mini)", model: "", columns: 3, rows: 2 },
	{ deviceType: 2, suffix: " (Stream Deck XL)", model: "", columns: 8, rows: 4 },
];

const ACTION_NAMES = {
	back: "Back",
	slot: "Game Slot",
	prev: "Previous Page",
	filter: "Filter & Settings",
	next: "Next Page",
};

/** Deterministic UUID so rebuilding gives identical ids. */
function uuid(seed) {
	const h = createHash("sha1").update(seed).digest("hex");
	return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** Top-left: back. Bottom-right three: prev, filter, next. Everything else: game slots. */
function layout(deck) {
	const keys = {};
	const last = deck.rows - 1;
	for (let r = 0; r < deck.rows; r++) {
		for (let c = 0; c < deck.columns; c++) {
			let kind = "slot";
			if (r === 0 && c === 0) kind = "back";
			else if (r === last && c === deck.columns - 3) kind = "prev";
			else if (r === last && c === deck.columns - 2) kind = "filter";
			else if (r === last && c === deck.columns - 1) kind = "next";
			keys[`${c},${r}`] = kind;
		}
	}
	return keys;
}

function actionEntry(title, position, kind) {
	return {
		ActionID: uuid(`${title}|${position}|action`),
		LinkedTitle: true,
		Name: ACTION_NAMES[kind],
		Plugin: { Name: PLUGIN_NAME, UUID: PLUGIN_UUID },
		Resources: null,
		Settings: {},
		State: 0,
		States: [
			{
				FontFamily: "",
				FontSize: 9,
				FontStyle: "",
				FontUnderline: false,
				OutlineThickness: 2,
				ShowTitle: kind === "slot",
				TitleAlignment: "bottom",
				TitleColor: "#ffffff",
			},
		],
		UUID: `${PLUGIN_UUID}.${kind}`,
	};
}

const EPOCH = new Date(Date.UTC(2020, 0, 1));
const outDir = path.join(PLUGIN_DIR, "profiles");
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const registered = [];
for (const deck of DECKS) {
	const title = `${BASE}${deck.suffix}`;
	const file = REVISION > 1 ? `${title} r${REVISION}` : title;
	const profileId = uuid(`${file}|profile`).toUpperCase();
	const page = uuid(`${file}|page`);
	const defaultPage = uuid(`${file}|default`);

	const actions = {};
	for (const [pos, kind] of Object.entries(layout(deck))) actions[pos] = actionEntry(file, pos, kind);

	const zip = new AdmZip();
	const root = `${profileId}.sdProfile`;
	zip.addFile(
		`${root}/manifest.json`,
		Buffer.from(
			JSON.stringify({
				Device: { Model: deck.model, UUID: "" },
				InstalledByPluginUUID: PLUGIN_UUID,
				Name: file,
				Pages: { Current: page, Default: defaultPage, Pages: [page] },
				PreconfiguredName: file,
				Version: "3.0",
			}),
		),
	);
	zip.addFile(`${root}/Profiles/`, Buffer.alloc(0));
	for (const [id, controllers] of [
		[page, [{ Actions: actions, Type: "Keypad" }]],
		[defaultPage, [{ Actions: null, Type: "Keypad" }]],
	]) {
		const dir = `${root}/Profiles/${id.toUpperCase()}`;
		zip.addFile(`${dir}/`, Buffer.alloc(0));
		zip.addFile(`${dir}/Images/`, Buffer.alloc(0));
		zip.addFile(`${dir}/manifest.json`, Buffer.from(JSON.stringify({ Controllers: controllers, Icon: "", Name: "" })));
	}
	for (const entry of zip.getEntries()) entry.header.time = EPOCH;
	zip.writeZip(path.join(outDir, `${file}.streamDeckProfile`));

	registered.push({ Name: `profiles/${file}`, DeviceType: deck.deviceType, Readonly: false, DontAutoSwitchWhenInstalled: true });
	console.log(`profiles/${file}.streamDeckProfile  (${deck.columns}x${deck.rows})`);
}

// Register in manifest.json
const manifestPath = path.join(PLUGIN_DIR, "manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
manifest.Profiles = registered;
writeFileSync(manifestPath, JSON.stringify(manifest, null, "\t") + "\n");

// Embed the paths for the plugin (it must not read manifest.json at runtime).
writeFileSync(
	path.join(ROOT, "src", "profiles.generated.ts"),
	`// Generated by tools/build-profiles.mjs. Do not edit.\nexport const PROFILES: Record<number, string> = ${JSON.stringify(
		Object.fromEntries(registered.map((p) => [p.DeviceType, p.Name])),
		null,
		"\t",
	)};\n`,
);
