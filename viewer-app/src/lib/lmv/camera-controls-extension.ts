/**
 * Camera-controls extension — adds a Map/Walk camera toggle pair to the LMV
 * toolbar.
 *
 *  - "Map camera"  : standard MapLibre orbit camera (also ends LMV
 *                    interaction mode).
 *  - "Walk camera" : streetwalk first-person camera (WASD + mouse-look via
 *                    pointer lock) driven through the custom-view-matrix
 *                    patch. The LMV model stays pinned to MapLibre's camera,
 *                    so it follows the walk automatically.
 *
 * The buttons only report the user's choice through `options.onSelect`; all
 * state changes live in the bridge (lmv-maplibre-bridge.ts). The bridge calls
 * setActiveMode() back to sync the buttons when mode changes come from
 * elsewhere (Esc exit, tool auto-switch).
 *
 * SSR-safe: Autodesk globals are only touched inside registerCameraControlsExtension(),
 * which the bridge calls at viewer-init time in the browser.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

export const CAMERA_CONTROLS_EXTENSION_ID = 'CameraControlsExtension';

export type CameraControlsMode = 'map' | 'walk';

const MAP_ICON =
	'data:image/svg+xml;charset=utf-8,' +
	encodeURIComponent(
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
			<g fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
				<path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2z"/>
				<path d="M9 4v14M15 6v14"/>
			</g>
		</svg>`
	);

const WALK_ICON =
	'data:image/svg+xml;charset=utf-8,' +
	encodeURIComponent(
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
			<g fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
				<circle cx="13" cy="4.5" r="2"/>
				<path d="M13 8l-3 5 2 3-1 5M13 8l3 3 3 1M10 13l-3 2M12 16l3 1 1 4"/>
			</g>
		</svg>`
	);

let registered = false;

export function registerCameraControlsExtension(): void {
	if (registered) return;

	const Autodesk: any = (window as any).Autodesk;
	if (!Autodesk?.Viewing?.theExtensionManager) {
		throw new Error('[CameraControls] LMV SDK is not initialized');
	}

	class CameraControlsExtension extends Autodesk.Viewing.Extension {
		private _mapButton: any = null;
		private _walkButton: any = null;
		private _mode: CameraControlsMode = 'map';

		load(): boolean {
			return true;
		}

		unload(): boolean {
			const group = this.viewer.toolbar?.getControl('camera-controls-toolbar-group');
			if (group) {
				if (this._mapButton) group.removeControl(this._mapButton);
				if (this._walkButton) group.removeControl(this._walkButton);
			}
			this._mapButton = null;
			this._walkButton = null;
			return true;
		}

		onToolbarCreated(): void {
			// Re-entrant: LMV calls this again whenever the toolbar is rebuilt
			// (first model load, site switch), and the bridge may call it
			// manually when the extension loaded before the toolbar existed.
			if (this._mapButton) {
				this._syncButtons();
				return;
			}
			let group = this.viewer.toolbar.getControl('camera-controls-toolbar-group');
			if (!group) {
				group = new Autodesk.Viewing.UI.ControlGroup('camera-controls-toolbar-group');
				this.viewer.toolbar.addControl(group);
			}

			this._mapButton = this._makeButton('camera-controls-map-button', 'Map camera', MAP_ICON);
			this._walkButton = this._makeButton('camera-controls-walk-button', 'Walk camera (WASD + mouse)', WALK_ICON);

			this._mapButton.onClick = () => this.options.onSelect?.('map');
			this._walkButton.onClick = () => this.options.onSelect?.('walk');

			group.addControl(this._mapButton);
			group.addControl(this._walkButton);
			this._syncButtons();
		}

		setActiveMode(mode: CameraControlsMode): void {
			this._mode = mode;
			this._syncButtons();
		}

		private _makeButton(id: string, tooltip: string, icon: string): any {
			const button = new Autodesk.Viewing.UI.Button(id);
			button.setToolTip(tooltip);
			const iconEl = button.container.querySelector('.adsk-button-icon');
			if (iconEl) {
				iconEl.style.backgroundImage = `url("${icon}")`;
				iconEl.style.backgroundSize = '24px';
				iconEl.style.backgroundPosition = 'center';
			}
			return button;
		}

		private _syncButtons(): void {
			const State = Autodesk.Viewing.UI.Button.State;
			this._mapButton?.setState(this._mode === 'map' ? State.ACTIVE : State.INACTIVE);
			this._walkButton?.setState(this._mode === 'walk' ? State.ACTIVE : State.INACTIVE);
		}
	}

	Autodesk.Viewing.theExtensionManager.registerExtension(CAMERA_CONTROLS_EXTENSION_ID, CameraControlsExtension);
	registered = true;
}
