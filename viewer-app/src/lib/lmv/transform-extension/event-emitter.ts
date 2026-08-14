/**
 * Minimal event emitter replacing the 2016-era `EventsEmitter` module the
 * Forge viewer extensions were built against (on/off/emit only — the
 * transform tools use nothing else).
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Handler = (event: any) => void;

export class EventEmitter {
	private _listeners: Record<string, Handler[]> = {};

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	on(type: string, handler: Handler): this {
		(this._listeners[type] ||= []).push(handler);
		return this;
	}

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	off(type: string, handler: Handler): this {
		const handlers = this._listeners[type];
		if (handlers) {
			const index = handlers.indexOf(handler);
			if (index >= 0) handlers.splice(index, 1);
		}
		return this;
	}

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	emit(type: string, event?: any): this {
		for (const handler of this._listeners[type] ?? []) {
			handler(event);
		}
		return this;
	}
}
