/**
 * Phasing UI — TypeScript port of wallabyway/phase-lmv-extension
 * (ext/ui.mjs). Toolbar button, slider bar, tooltip chip, and the extension
 * wiring. Phase data (DEFAULT_PHASES) lives here too; all phasing
 * calculations and fragment manipulation live in phasing-engine.ts.
 *
 * The slider bar markup (#phasing-bar & friends) is rendered by
 * ViewerCanvas.svelte; this extension only wires events onto those elements.
 *
 * SSR-safe: Autodesk/THREE are only touched inside registerPhasingExtension(),
 * which the bridge calls at model-load time in the browser.
 */

import { PhasingEngine, type PhasingConfig, type Phase } from './phasing-engine';

/* eslint-disable @typescript-eslint/no-explicit-any */

export const PHASING_EXTENSION_ID = 'PhasingExtension';

// Synthetic construction schedule (former phases.json, now embedded).
// The timeline follows a real build sequence: structure rises floor by floor,
// then floors, walls, envelope (glazing), stairs, and doors — each level
// category dropping L0..L5 — followed by whole-building bursts: roof, MEP,
// finishes & FF&E, site & landscape, and a catch-all 'Other'.
export const DEFAULT_PHASES: PhasingConfig = {
	dropHeight: 150, // how far elements hang above their resting place at phase start
	overlap: 2, // conveyor-belt: parts in flight at once (2 or 3)
	levelCategories: ['Structure', 'Floors', 'Walls', 'Envelope', 'Stairs', 'Doors'],
	levelProps: ['Base Constraint', 'Base Level', 'Level'],
	// Revit exports sub-categories (and LMV prefixes values with 'Revit ') —
	// normalize components onto their construction parent
	categoryMap: {
		// structure (rises first; foundations/rebar band to L0)
		'Structural Framing': 'Structure', 'Structural Columns': 'Structure',
		'Structural Foundations': 'Structure', 'Structural Rebar': 'Structure',
		'Structural Connections': 'Structure', 'Columns': 'Structure',
		// envelope: glazing follows the wall shell
		'Curtain Panels': 'Envelope', 'Curtain Wall Mullions': 'Envelope', 'Windows': 'Envelope',
		// walls / floors components
		'Wall Sweeps': 'Walls', 'Slab Edges': 'Floors',
		// stairs + vertical circulation
		'Runs': 'Stairs', 'Supports': 'Stairs', 'Landings': 'Stairs',
		'Handrails': 'Stairs', 'Top Rails': 'Stairs', 'Railings': 'Stairs',
		'Vertical Circulation': 'Stairs', 'Ramps': 'Stairs'
	},
	roofLevels: ['R1', 'R2', 'M1', 'Parapet', 'Block', 'Green Roof'],
	colors: [
		[150, 154, 162], // Structure — steel
		[91, 155, 213], // Floors — blue
		[198, 90, 17], // Walls — orange
		[0, 169, 176], // Envelope — glass teal
		[112, 173, 71], // Stairs — green
		[146, 100, 200] // Doors — purple
	],
	byCategory: [
		{ id: 'roof', name: 'Roof', short: 'Roof', color: [164, 38, 44], categories: ['Roofs'] },
		{ id: 'mep', name: 'MEP', short: 'MEP', color: [176, 122, 10], categories: ['Lighting Fixtures', 'Plumbing Fixtures', 'Specialty Equipment', 'Food Service Equipment'] },
		{ id: 'ffe', name: 'Finishes & FF&E', short: 'FF&E', color: [226, 140, 190], categories: ['Ceilings', 'Casework', 'Furniture', 'Generic Models'] },
		{ id: 'site', name: 'Site & Landscape', short: 'Site', color: [133, 138, 60], categories: ['Site', 'Planting', 'Hardscape', 'Parking', 'Entourage'] }
	]
};

const ICON =
	'data:image/svg+xml;charset=utf-8,' +
	encodeURIComponent(
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
			<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
				<path d="M3 6h18M3 12h12M3 18h15"/>
			</g>
			<circle cx="18.5" cy="12" r="3.2" fill="#4aa8ff"/>
		</svg>`
	);

let registered = false;

export function registerPhasingExtension(): void {
	if (registered) return;

	const Autodesk: any = (window as any).Autodesk;
	if (!Autodesk?.Viewing?.theExtensionManager) {
		throw new Error('[Phasing] LMV SDK is not initialized');
	}

	class PhasingExtension extends Autodesk.Viewing.Extension {
		private _button: any = null;
		private _t = 0;
		private _enabled = false;
		private _active: string | null = null;
		private _tooltip: HTMLElement | null = null;
		private _onLoaded: any = null;
		public engine: PhasingEngine;

		constructor(viewer: any, options: any) {
			super(viewer, options);
			this.engine = new PhasingEngine(viewer);
			this.engine.onFinalize = () => {
				this.buildTooltip();
				this._active = null; // force label refresh
				if (this._enabled) this.update();
			};
		}

		load(): boolean {
			this.engine.setPhases({ ...DEFAULT_PHASES });
			this._onLoaded = () => {
				if (!this._enabled) return;
				this.engine.reset(); // re-apply for newly streamed fragments
				this.update();
			};
			this.viewer.addEventListener(Autodesk.Viewing.GEOMETRY_LOADED_EVENT, this._onLoaded);
			return true;
		}

		unload(): boolean {
			this.viewer.removeEventListener(Autodesk.Viewing.GEOMETRY_LOADED_EVENT, this._onLoaded);
			if (this._button) {
				const g = this.viewer.toolbar.getControl('phasing-toolbar-group');
				if (g) g.removeControl(this._button);
			}
			document.getElementById('phasing-bar')?.classList.add('hidden');
			this.engine.clearOverrides();
			return true;
		}

		onToolbarCreated(): void {
			let group = this.viewer.toolbar.getControl('phasing-toolbar-group');
			if (!group) {
				group = new Autodesk.Viewing.UI.ControlGroup('phasing-toolbar-group');
				this.viewer.toolbar.addControl(group);
			}
			const b = new Autodesk.Viewing.UI.Button('phasing-toolbar-button');
			b.setToolTip('Construction Phasing');
			group.addControl(b);
			const icon = b.container.querySelector('.adsk-button-icon');
			if (icon) {
				icon.style.backgroundImage = `url("${ICON}")`;
				icon.style.backgroundSize = '24px';
				icon.style.backgroundPosition = 'center';
			}
			b.onClick = () => this.toggleBar(b);
			this._button = b;

			document.getElementById('phasing-slider')?.addEventListener('input', (e) => {
				this._t = +(e.target as HTMLInputElement).value;
				this.update();
			});
			document.getElementById('phasing-reset')?.addEventListener('click', () => {
				const slider = document.getElementById('phasing-slider') as HTMLInputElement | null;
				if (slider) slider.value = '0';
				this._t = 0;
				this.engine.reset();
				this.update();
			});
		}

		toggleBar(button: any): void {
			const bar = document.getElementById('phasing-bar');
			if (!bar) return;
			// toggle() returns true when the class was ADDED, i.e. the bar is now hidden
			const show = !bar.classList.toggle('hidden');
			button.setState(show ? Autodesk.Viewing.UI.Button.State.ACTIVE : Autodesk.Viewing.UI.Button.State.INACTIVE);
			this._enabled = show;
			if (show) {
				this.engine.reset();
				this.update();
			} else {
				this.engine.clearOverrides(); // restore visibility, colors, and drop transforms
			}
		}

		setPhases(cfg: Partial<PhasingConfig>): void {
			this.engine.setPhases({ ...DEFAULT_PHASES, ...cfg });
		}

		addModel(model: any, category?: string): void {
			this.engine.addModel(model, category);
		}

		/**
		 * Site switch (bridge unloaded every model): hide the bar, restore
		 * overrides on the departing models, and drop all engine state so
		 * stale buckets never reference dead model objects.
		 */
		resetForNewModel(): void {
			this._t = 0;
			this._active = null;
			const slider = document.getElementById('phasing-slider') as HTMLInputElement | null;
			if (slider) slider.value = '0';
			if (this._enabled) {
				this._enabled = false;
				this._button?.setState(Autodesk.Viewing.UI.Button.State.INACTIVE);
				document.getElementById('phasing-bar')?.classList.add('hidden');
			}
			try {
				this.engine.clearOverrides();
			} catch {
				// departing models may already be gone — buckets get cleared below
			}
			this.engine.clearModels();
			const label = document.getElementById('phasing-current');
			if (label) label.textContent = '—';
			const legend = document.getElementById('phasing-legend');
			if (legend) legend.innerHTML = '';
			this._tooltip = null;
		}

		update(): void {
			const t = this._t / 10; // slider spans 0..1000; the phase timeline is 0..100
			// With the conveyor-belt schedule several phases are in flight at
			// once — the label/tooltip track the NEWEST part to appear (last
			// phase with start <= t still airborne).
			let cur: Phase | null = null;
			for (const p of this.engine.phases) {
				if (p.start > t) break;
				if (t < p.end) cur = p;
			}
			const id = t >= 100 ? 'done' : cur ? cur.id : null;
			// tooltip chip follows the thumb
			if (this._tooltip) {
				this._tooltip.style.left = `calc(${t}% + ${(8 - 0.16 * t).toFixed(2)}px)`;
			}
			if (id !== this._active) {
				this._active = id;
				const label = document.getElementById('phasing-current');
				if (id === 'done') {
					if (label) {
						label.textContent = 'Complete';
						label.classList.add('dim');
					}
					if (this._tooltip) this._tooltip.textContent = 'Complete';
				} else if (cur) {
					if (label) {
						label.textContent = cur.name.length > 12 ? cur.short : cur.name;
						label.classList.remove('dim');
					}
					if (this._tooltip) {
						const [r, g, b] = cur.color;
						this._tooltip.innerHTML = `<span class="dot" style="background:rgb(${r},${g},${b})"></span>${cur.short}`;
					}
				} else if (label) {
					label.textContent = '—';
				}
			}
			this.engine.update(t);
		}

		// single tooltip chip that follows the thumb and shows the active phase
		private buildTooltip(): void {
			const legend = document.getElementById('phasing-legend');
			if (!legend) return;
			legend.innerHTML = '<span class="phasing-chip" id="phasing-tooltip"></span>';
			this._tooltip = document.getElementById('phasing-tooltip');
		}
	}

	Autodesk.Viewing.theExtensionManager.registerExtension(PHASING_EXTENSION_ID, PhasingExtension);
	registered = true;
}
