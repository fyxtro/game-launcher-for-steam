import streamDeck, {
	action,
	type KeyDownEvent,
	type KeyUpEvent,
	type SendToPluginEvent,
	SingletonAction,
	type WillAppearEvent,
} from "@elgato/streamdeck";
import type { JsonObject, JsonValue } from "@elgato/utils";

import { controller } from "../controller";

const LONG_PRESS_MS = 700;

@action({ UUID: "tools.quin.steamlibrary.next" })
export class NextPage extends SingletonAction {
	override onWillAppear(ev: WillAppearEvent): void {
		controller.scheduleRender(ev.action.device.id);
	}

	override onKeyDown(ev: KeyDownEvent): void {
		const d = ev.action.device.id;
		controller.setPage(d, controller.page(d) + 1);
	}
}

@action({ UUID: "tools.quin.steamlibrary.prev" })
export class PrevPage extends SingletonAction {
	override onWillAppear(ev: WillAppearEvent): void {
		controller.scheduleRender(ev.action.device.id);
	}

	override onKeyDown(ev: KeyDownEvent): void {
		const d = ev.action.device.id;
		controller.setPage(d, controller.page(d) - 1);
	}
}

/**
 * Press: cycle Favorites > Installed > Recent > All.
 * Hold (0.7s): rescan Steam and rebuild artwork.
 */
@action({ UUID: "tools.quin.steamlibrary.filter" })
export class FilterToggle extends SingletonAction {
	private downAt = new Map<string, number>();

	override async onWillAppear(ev: WillAppearEvent): Promise<void> {
		controller.scheduleRender(ev.action.device.id);
		await controller.ensureLibrary();
		controller.scheduleRender(ev.action.device.id);
	}

	override onKeyDown(ev: KeyDownEvent): void {
		this.downAt.set(ev.action.id, Date.now());
	}

	override async onKeyUp(ev: KeyUpEvent): Promise<void> {
		const held = Date.now() - (this.downAt.get(ev.action.id) ?? Date.now());
		this.downAt.delete(ev.action.id);
		if (held >= LONG_PRESS_MS) {
			await controller.rescan();
			if (ev.action.isKey()) await ev.action.showOk();
		} else {
			await controller.cycleMode(ev.action.device.id);
		}
	}

	override async onSendToPlugin(ev: SendToPluginEvent<JsonValue, JsonObject>): Promise<void> {
		const payload = ev.payload as { event?: string } | null;
		if (payload?.event === "getCollections") {
			await controller.ensureLibrary();
			await streamDeck.ui.sendToPropertyInspector({ event: "getCollections", items: controller.collectionItems() });
		} else if (payload?.event === "rescan") {
			await controller.rescan();
		}
	}

}
