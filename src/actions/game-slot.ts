import { action, type KeyDownEvent, SingletonAction, type WillAppearEvent, type WillDisappearEvent } from "@elgato/streamdeck";

import { controller } from "../controller";

/**
 * One tile in the game grid. Place as many as you like in a folder/page; they are
 * filled in reading order (left to right, top to bottom).
 */
@action({ UUID: "tools.quin.steamlibrary.slot" })
export class GameSlot extends SingletonAction {
	private visible = new Map<string, number>();

	override async onWillAppear(ev: WillAppearEvent): Promise<void> {
		const device = ev.action.device.id;
		const before = this.visible.get(device) ?? 0;
		this.visible.set(device, before + 1);

		if (before === 0) {
			// The grid just opened: start at page 1 and refresh when the data is stale.
			controller.resetPage(device);
			controller.scheduleRender(device);
			await controller.ensureLibrary();
		}
		controller.scheduleRender(device);
	}

	override onWillDisappear(ev: WillDisappearEvent): void {
		const device = ev.action.device.id;
		this.visible.set(device, Math.max(0, (this.visible.get(device) ?? 1) - 1));
	}

	override async onKeyDown(ev: KeyDownEvent): Promise<void> {
		if (!ev.action.isKey()) return;
		const game = controller.gameForKey(ev.action);
		if (!game) {
			await ev.action.showAlert();
			return;
		}
		controller.launch(game);
		await ev.action.showOk();
		const device = ev.action.device.id;
		if (controller.settings.returnAfterLaunch && controller.isGridOpen(device)) {
			setTimeout(() => void controller.closeGrid(device), 400);
		}
	}
}
