/**
 * Phasing engine — TypeScript port of wallabyway/phase-lmv-extension
 * (ext/phasing.mjs). Level detection, phase construction, hide/theming, and
 * the fall-in animation via `fragList.updateAnimTransform`.
 *
 * Pure logic + viewer API; no DOM. Driven by PhasingExtension
 * (phasing-extension.ts).
 *
 * Additions vs the original (MapLibre bridge integration):
 *  - `clearModels()` drops all per-model analysis state so a site switch
 *    (which unloads every model) leaves no stale buckets behind.
 *  - THREE is read lazily from window (SSR-safe module scope).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

export type PhaseColor = [number, number, number];

export type PhasingConfig = {
	dropHeight: number;
	levelCategories: string[];
	levelProps: string[];
	roofLevels: string[];
	colors: PhaseColor[];
	byCategory: Array<{ id: string; name: string; short: string; color: PhaseColor; categories: string[] }>;
};

export type Phase = {
	id: string;
	name: string;
	short: string;
	start: number;
	end: number;
	color: PhaseColor;
	_lastStatus?: number;
	_lastP?: number;
	_drop?: boolean;
};

const three = (): any => (window as any).THREE;

export class PhasingEngine {
	private viewer: any;
	private _cfg: PhasingConfig | null = null;
	private _phases: Phase[] = [];
	private _phaseById = new Map<string, Phase>();
	private _catPhase = new Map<string, string>(); // category -> static phase id (roof / finishes)
	private _entries: Array<{ model: any; category: string; dbid: number; level: number | string | null; z: number | null }> = [];
	private _buckets = new Map<string, Map<any, number[]>>(); // phaseId -> Map(model -> [dbids])
	private _modelZ = new Map<any, { min: number; max: number } | null>(); // model -> {min, max} (height guess baseline)
	private _trees = new Map<any, any>(); // model -> object tree (fragment enumeration)
	private _pending = 0;
	private _pos: any = null;
	private _statusKey: string | null = null;
	onFinalize: (() => void) | null = null; // called once phases + buckets are built

	constructor(viewer: any) {
		this.viewer = viewer;
	}

	get phases(): Phase[] {
		return this._phases;
	}
	get buckets(): Map<string, Map<any, number[]>> {
		return this._buckets;
	}

	private get pos(): any {
		this._pos ??= new (three().Vector3)();
		return this._pos;
	}

	setPhases(cfg: PhasingConfig): void {
		this._cfg = cfg;
		this._catPhase.clear();
		for (const p of cfg.byCategory) {
			for (const c of p.categories) this._catPhase.set(c, p.id);
		}
	}

	reset(): void {
		this._statusKey = null;
		for (const p of this._phases) p._lastStatus = undefined;
	}

	/**
	 * Drop all per-model state (site switch unloaded the models). Config
	 * (_cfg/_catPhase) survives — the schedule is model-independent.
	 */
	clearModels(): void {
		this._phases = [];
		this._phaseById.clear();
		this._entries = [];
		this._buckets.clear();
		this._modelZ.clear();
		this._trees.clear();
		this._pending = 0;
		this._statusKey = null;
	}

	/* ---- analysis ---- */

	addModel(model: any, category: string): void {
		this._pending++;
		this.analyze(model, category).finally(() => {
			if (--this._pending === 0) this.finalize();
		});
	}

	private async analyze(model: any, category: string): Promise<void> {
		const tree = await new Promise<any>((res, rej) => model.getObjectTree(res, rej));
		this._trees.set(model, tree);
		const dbids: number[] = [];
		tree.enumNodeChildren(tree.getRootId(), (d: number) => {
			if (tree.getChildCount(d) === 0) dbids.push(d);
		}, true);

		// level from Revit constraints (only categories that are phased by level)
		const level = new Map<number, number | string | null>();
		if (this._cfg && !this._catPhase.has(category)) {
			const props = await new Promise<Map<number, Map<string, unknown>>>((res) => {
				const map = new Map<number, Map<string, unknown>>();
				model.getBulkProperties(dbids, { propFilter: this._cfg!.levelProps }, (r: any[]) => {
					for (const p of r) {
						const m = new Map<string, unknown>();
						for (const pr of p.properties) {
							const prev = m.get(pr.displayName);
							m.set(pr.displayName, prev === undefined ? pr.displayValue : ([] as unknown[]).concat(prev as any, pr.displayValue));
						}
						map.set(p.dbId, m);
					}
					res(map);
				}, () => res(map));
			});
			for (const d of dbids) level.set(d, this.resolve(props.get(d)));
		}

		// world Z per element (for the height-based level guess below)
		const box = new Array(6);
		tree.getNodeBox(tree.getRootId(), box);
		this._modelZ.set(model, isFinite(box[0]) ? { min: box[2], max: box[5] } : null);
		for (const d of dbids) {
			tree.getNodeBox(d, box);
			this._entries.push({
				model, category, dbid: d,
				level: level.get(d) ?? null,
				z: isFinite(box[0]) ? (box[2] + box[5]) / 2 : null
			});
		}
		console.log(`[phasing] ${category}: ${dbids.length} elements`);
	}

	// Parking -> 0, "L1 - Block 35" -> 1, roof-level names -> 'roof', else null
	private resolve(props: Map<string, unknown> | undefined): number | string | null {
		if (!props || !this._cfg) return null;
		for (const name of this._cfg.levelProps) {
			for (const v of ([] as unknown[]).concat(props.get(name) as any)) {
				if (typeof v !== 'string') continue;
				if (/^parking/i.test(v)) return 0;
				const m = v.match(/^L(\d+)/i);
				if (m) return +m[1];
				if (this._cfg.roofLevels.some((r) => new RegExp('^' + r, 'i').test(v))) return 'roof';
			}
		}
		return null;
	}

	/* ---- phases & buckets ---- */

	private finalize(): void {
		if (!this._cfg) return;
		const levels = [...new Set(this._entries.map((e) => e.level).filter((l): l is number => typeof l === 'number'))].sort((a, b) => a - b);
		if (!levels.length) levels.push(1);

		// guess levels for elements without level props: assume the levels are
		// evenly spaced over the model's height (no per-level bounds analysis)
		const band = (e: { model: any; z: number | null }): number => {
			const r = this._modelZ.get(e.model);
			if (!r || r.max <= r.min || e.z == null) return levels[0];
			const i = Math.min(levels.length - 1, Math.max(0, Math.floor(((e.z - r.min) / (r.max - r.min)) * levels.length)));
			return levels[i];
		};

		// phases: category-major (floors, then walls, then stairs), level-minor
		const cats = this._cfg.levelCategories;
		const all: Array<Omit<Phase, 'start' | 'end'>> = [];
		for (let ci = 0; ci < cats.length; ci++) {
			for (const lv of levels) {
				all.push({
					id: cats[ci].toLowerCase() + '-' + lv,
					name: cats[ci] + ' L' + lv,
					short: cats[ci] + ' L' + lv,
					color: this._cfg.colors[ci % this._cfg.colors.length]
				});
			}
		}
		for (const p of this._cfg.byCategory) all.push(p);
		const span = 100 / all.length;
		this._phases = all.map((p, i) => ({ ...p, start: i * span, end: (i + 1) * span }));
		this._phaseById = new Map(this._phases.map((p) => [p.id, p]));

		this._buckets = new Map();
		const push = (pid: string, model: any, dbid: number) => {
			if (!this._buckets.has(pid)) this._buckets.set(pid, new Map());
			const m = this._buckets.get(pid)!;
			if (!m.has(model)) m.set(model, []);
			m.get(model)!.push(dbid);
		};
		for (const e of this._entries) {
			const lv = e.level === 'roof' ? null : (e.level ?? band(e));
			const pid = this._catPhase.get(e.category) || (lv === null ? 'roof' : e.category.toLowerCase() + '-' + lv);
			push(pid, e.model, e.dbid);
		}
		console.log('[phasing]', this._phases.map((p) => p.short).join(' '));

		this._statusKey = null;
		if (this.onFinalize) this.onFinalize();
	}

	/* ---- state ---- */

	statusOf(p: Phase, t: number): number {
		return t < p.start ? 0 : t >= p.end ? 2 : 1;
	}
	progress(p: Phase, t: number): number {
		return Math.min(1, Math.max(0, (t - p.start) / (p.end - p.start)));
	}

	// Called on every slider input: render when the phase status set changes,
	// and keep the in-progress phase's drop height in sync with t.
	update(t: number): void {
		const key = this._phases.map((p) => this.statusOf(p, t)).join('');
		if (key !== this._statusKey) {
			this._statusKey = key;
			this.render(t);
		}
		const cur = this._phases.find((p) => p.start <= t && t < p.end);
		if (cur) {
			const p = this.progress(cur, t);
			if (p !== cur._lastP) {
				cur._lastP = p;
				this.drop(cur, p);
				this.viewer.impl.invalidate(true);
			}
		}
	}

	render(t: number): void {
		for (const [pid, byModel] of this._buckets) {
			const p = this._phaseById.get(pid);
			if (!p) continue;
			const s = this.statusOf(p, t);
			if (s === p._lastStatus) continue;
			p._lastStatus = s;
			for (const [model, dbids] of byModel) {
				if (model.isLoadDone && !model.isLoadDone()) continue;
				try {
					if (s === 0) {
						this.viewer.hide(dbids, model);
					} else {
						this.viewer.show(dbids, model);
						const [r, g, b] = p.color;
						const c = new (three().Vector4)(r / 255, g / 255, b / 255, s === 2 ? 0.35 : 1);
						for (const d of dbids) model.setThemingColor(d, c);
					}
				} catch (err: any) {
					console.warn('[phasing]', pid, err?.message);
				}
			}
			if (s === 1) this.drop(p, this.progress(p, t));
			else if (p._drop) this.drop(p, null);
		}
		this.viewer.impl.invalidate(true);
	}

	// lift (or reset) a phase's fragments; prog 0..1 -> lift = (1-prog) * dropHeight
	private drop(p: Phase, prog: number | null): void {
		if (!this._cfg) return;
		const reset = prog == null;
		const byModel = this._buckets.get(p.id) || new Map();
		this.pos.set(0, 0, reset ? 0 : (1 - prog) * this._cfg.dropHeight);
		for (const [model, dbids] of byModel) {
			const fl = model.getFragmentList();
			const tree = this._trees.get(model);
			if (!fl || !fl.updateAnimTransform || !tree) continue;
			for (const d of dbids) {
				// NOTE: the SVF2 fragment list has no dbId2fragId map — enumerate
				// the node's fragments through the instance tree instead.
				tree.enumNodeFragments(d, (f: number) => {
					if (reset) fl.updateAnimTransform(f);
					else fl.updateAnimTransform(f, null, null, this.pos);
				});
			}
		}
		p._drop = !reset;
	}

	clearOverrides(): void {
		for (const p of this._phases) {
			p._lastStatus = undefined;
			p._lastP = undefined;
			if (p._drop) this.drop(p, null); // restore fragment transforms
		}
		// On a site switch the old models are already unloaded — skip them, or
		// clearThemingColors/show throw on the dead model objects.
		const live = new Set<any>(this.viewer.impl?.modelQueue?.()?.getModels?.() ?? []);
		for (const byModel of this._buckets.values()) {
			for (const [model, dbids] of byModel) {
				if (!live.has(model)) continue;
				try {
					this.viewer.clearThemingColors(model);
					this.viewer.show(dbids, model);
				} catch (err: any) {
					console.warn('[phasing] clearOverrides', err?.message);
				}
			}
		}
		this._statusKey = null;
		this.viewer.impl.invalidate(true);
	}
}
