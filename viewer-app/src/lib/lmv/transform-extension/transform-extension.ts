/**
 * Viewing.Extension.Transform — TypeScript port of Philippe Leefsma's 2016
 * Forge extension (library-javascript-viewer-extensions).
 *
 * Deviations from the original, kept minimal:
 *  - `Viewer.ExtensionBase` is dropped; the extension subclasses
 *    `Autodesk.Viewing.Extension` directly (the base only added an
 *    EventsEmitter mixin the extension never used).
 *  - Only `Viewer.Toolkit.createButton` is kept, inlined as a local helper.
 *  - Font Awesome / glyphicon icon classes don't exist in this app, so the
 *    buttons get plain text labels instead (cosmetics only).
 *
 * SSR-safe: Autodesk/THREE are only touched inside registerTransformExtension(),
 * which the bridge calls at model-load time in the browser.
 */

import { EventEmitter } from './event-emitter';
import { TranslateTool } from './translate-tool';
import { createRotateToolClass } from './rotate-tool';
import { installTransformGizmos } from './transform-gizmos';

export const TRANSFORM_EXTENSION_ID = 'Viewing.Extension.Transform';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyViewer = any;

let registered = false;

export function registerTransformExtension(): void {
	if (registered) return;

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const Autodesk: any = (window as any).Autodesk;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const THREE: any = (window as any).THREE;

	if (!Autodesk?.Viewing?.theExtensionManager || !THREE) {
		throw new Error('[Transform] LMV SDK is not initialized');
	}

	installTransformGizmos(THREE);

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const RotateTool: any = createRotateToolClass(THREE, EventEmitter);

	// The only Viewer.Toolkit helper the extension actually used.
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const createButton = (id: string, label: string, tooltip: string, handler: () => void): any => {
		const button = new Autodesk.Viewing.UI.Button(id);

		// No Font Awesome / glyphicon in this app — plain text label.
		button.icon.style.fontSize = '13px';
		button.icon.className = '';
		button.icon.textContent = label;

		button.setToolTip(tooltip);

		button.onClick = handler;

		return button;
	};

	class TransformExtension extends Autodesk.Viewing.Extension {
		private _viewer: AnyViewer;
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		private _options: any;
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		public translateTool: any;
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		public rotateTool: any;
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		private _txControl: any;
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		private _rxControl: any;
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		private _comboCtrl: any;
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		private parentControl: any;

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		constructor(viewer: AnyViewer, options: any = {}) {
			super(viewer, options);

			this._viewer = viewer;
			this._options = options;

			this.translateTool = new TranslateTool(viewer);

			this._viewer.toolController.registerTool(this.translateTool);

			this.rotateTool = new RotateTool(viewer);

			this._viewer.toolController.registerTool(this.rotateTool);
		}

		static get ExtensionId(): string {
			return TRANSFORM_EXTENSION_ID;
		}

		load(): boolean {
			this._txControl = createButton('toolbar-translate', 'T', 'Translate Tool', () => {
				const txTool = this.translateTool.getName();
				const rxTool = this.rotateTool.getName();

				if (this.translateTool.active) {
					this._viewer.toolController.deactivateTool(txTool);
					this._txControl.container.classList.remove('active');
					this._comboCtrl.container.classList.remove('active');
				} else {
					this._viewer.toolController.activateTool(txTool);
					this._txControl.container.classList.add('active');

					this._viewer.toolController.deactivateTool(rxTool);
					this._rxControl.container.classList.remove('active');

					this._comboCtrl.container.classList.add('active');
				}
			});

			this._rxControl = createButton('toolbar-rotate', 'R', 'Rotate Tool', () => {
				const txTool = this.translateTool.getName();
				const rxTool = this.rotateTool.getName();

				if (this.rotateTool.active) {
					this._viewer.toolController.deactivateTool(rxTool);
					this._rxControl.container.classList.remove('active');
					this._comboCtrl.container.classList.remove('active');
				} else {
					this._viewer.toolController.activateTool(rxTool);
					this._rxControl.container.classList.add('active');

					this._viewer.toolController.deactivateTool(txTool);
					this._txControl.container.classList.remove('active');

					this._comboCtrl.container.classList.add('active');
				}
			});

			this.parentControl = this._options.parentControl;

			if (!this.parentControl) {
				const viewerToolbar = this._viewer.getToolbar(true);

				this.parentControl = new Autodesk.Viewing.UI.ControlGroup('transform');

				viewerToolbar.addControl(this.parentControl);
			}

			this._comboCtrl = new Autodesk.Viewing.UI.ComboButton('transform-combo');

			this._comboCtrl.setToolTip('Transform Tools');

			this._comboCtrl.icon.style.fontSize = '13px';
			this._comboCtrl.icon.className = '';
			this._comboCtrl.icon.textContent = 'T/R';

			this._comboCtrl.addControl(this._txControl);
			this._comboCtrl.addControl(this._rxControl);

			const openCombo = this._comboCtrl.onClick;

			// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars
			this._comboCtrl.onClick = (_e: any) => {
				if (this._comboCtrl.container.classList.contains('active')) {
					this._txControl.container.classList.remove('active');
					this._rxControl.container.classList.remove('active');

					this._comboCtrl.container.classList.remove('active');

					const txTool = this.translateTool.getName();
					const rxTool = this.rotateTool.getName();

					this._viewer.toolController.deactivateTool(txTool);
					this._viewer.toolController.deactivateTool(rxTool);
				} else {
					openCombo();
				}
			};

			this.parentControl.addControl(this._comboCtrl);

			console.log('Viewing.Extension.Transform loaded');

			return true;
		}

		unload(): boolean {
			this.parentControl.removeControl(this._comboCtrl);

			this._viewer.toolController.deactivateTool(this.translateTool.getName());

			this._viewer.toolController.deactivateTool(this.rotateTool.getName());

			console.log('Viewing.Extension.Transform unloaded');

			return true;
		}
	}

	Autodesk.Viewing.theExtensionManager.registerExtension(
		TRANSFORM_EXTENSION_ID,
		TransformExtension
	);

	registered = true;
}
