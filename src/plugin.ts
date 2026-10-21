import streamDeck from "@elgato/streamdeck";

import { FilterToggle, NextPage, PrevPage } from "./actions/navigation";
import { GameSlot } from "./actions/game-slot";
import { CloseGrid, OpenGrid } from "./actions/grid";
import { controller, type GlobalSettings } from "./controller";

streamDeck.logger.setLevel("info");

const slot = new GameSlot();
const next = new NextPage();
const prev = new PrevPage();
const filter = new FilterToggle();
const open = new OpenGrid();
const back = new CloseGrid();

controller.slots = slot;
controller.navs = [next, prev, filter];
controller.backs = back;

streamDeck.actions.registerAction(slot);
streamDeck.actions.registerAction(next);
streamDeck.actions.registerAction(prev);
streamDeck.actions.registerAction(filter);
streamDeck.actions.registerAction(open);
streamDeck.actions.registerAction(back);

streamDeck.settings.onDidReceiveGlobalSettings<GlobalSettings>((ev) => {
	const before = controller.settings.steamPath;
	controller.applySettings(ev.settings);
	if (before !== controller.settings.steamPath) {
		void controller.ensureLibrary(true).then(() => controller.renderAll());
	} else {
		controller.renderAll();
	}
});

await streamDeck.connect();

controller.applySettings(await streamDeck.settings.getGlobalSettings<GlobalSettings>());
await controller.ensureLibrary();
controller.renderAll();
