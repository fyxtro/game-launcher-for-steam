import { action, type KeyDownEvent, SingletonAction } from "@elgato/streamdeck";

import { controller } from "../controller";

/** One key on your normal profile that opens the auto-filled game grid (like Elgato's Audio Mixer). */
@action({ UUID: "tools.quin.steamlibrary.open" })
export class OpenGrid extends SingletonAction {
	override async onKeyDown(ev: KeyDownEvent): Promise<void> {
		const ok = await controller.openGrid(ev.action.device);
		if (!ok && ev.action.isKey()) await ev.action.showAlert();
	}
}

/** Top-left key of the grid: back to the previous profile. */
@action({ UUID: "tools.quin.steamlibrary.back" })
export class CloseGrid extends SingletonAction {
	override async onKeyDown(ev: KeyDownEvent): Promise<void> {
		await controller.closeGrid(ev.action.device.id);
	}
}
