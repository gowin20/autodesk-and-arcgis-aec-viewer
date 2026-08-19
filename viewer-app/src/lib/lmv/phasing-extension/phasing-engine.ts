/**
 * Phasing engine — TypeScript port of wallabyway/phase-lmv-extension
 * (ext/phasing.mjs @ 949139d). Level detection, phase construction,
 * isolate-based visibility/theming, and the fall-in animation (fragment
 * transform manipulation; the 0..1000 slider drives the drop height
 * directly — no tweening).
 *
 * Pure logic + viewer API; no DOM. Driven by PhasingExtension
 * (phasing-extension.ts).
 *
 * Additions vs the original (MapLibre bridge integration):
 *  - `clearModels()` drops all per-model analysis state so a site switch
 *    (which unloads every model) leaves no stale buckets behind.
 *  - `clearOverrides()` skips models that are no longer in the viewer
 *    (dead model objects from a site switch throw inside LMV).
 *  - THREE is read lazily from window (SSR-safe module scope).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

export type PhaseColor = [number, number, number];

export type PhasingConfig = {
	dropHeight: number;
	/** Conveyor-belt: how many parts are in flight at once (2 or 3). */
	overlap?: number;
	levelCategories: string[];
	levelProps: string[];
	roofLevels: string[];
	colors: PhaseColor[];
	/** Normalize Revit sub-categories onto their construction parent. */
	categoryMap?: Record<string, string>;
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
	_lift?: number;
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

	addModel(model: any, category?: string): void {
		this._pending++;
		this.analyze(model, category).finally(() => {
			if (--this._pending === 0) this.finalize();
		});
	}

	private async analyze(model: any, category?: string): Promise<void> {
		const tree = await new Promise<any>((res, rej) => model.getObjectTree(res, rej));
		this._trees.set(model, tree);
		const dbids: number[] = [];
		tree.enumNodeChildren(tree.getRootId(), (d: number) => {
			if (tree.getChildCount(d) === 0) dbids.push(d);
		}, true);

		// per-element Revit category + level from constraints. With a combined
		// model (single {3D} view) the category can no longer be tagged per
		// model, so it comes from the element's 'Category' property; the model
		// tag is only a fallback when the property is missing.
		const props = await new Promise<Map<number, Map<string, unknown>>>((res) => {
			const map = new Map<number, Map<string, unknown>>();
			model.getBulkProperties(dbids, { propFilter: ['Category', ...(this._cfg?.levelProps ?? [])] }, (r: any[]) => {
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

		// world Z per element (for the height-based level guess below)
		const box = new Array(6);
		tree.getNodeBox(tree.getRootId(), box);
		this._modelZ.set(model, isFinite(box[0]) ? { min: box[2], max: box[5] } : null);
		for (const d of dbids) {
			tree.getNodeBox(d, box);
			const pr = props.get(d);
			let cat = pr ? ([] as unknown[]).concat(pr.get('Category') as any).find((v): v is string => typeof v === 'string') ?? null : null;
			if (cat && this._cfg) {
				cat = cat.replace(/^Revit\s+/i, ''); // LMV prefixes category values with 'Revit '
				cat = (this._cfg.categoryMap && this._cfg.categoryMap[cat]) || cat;
			}
			this._entries.push({
				model, category: cat || category || 'Other', dbid: d,
				level: pr ? this.resolve(pr) : null,
				z: isFinite(box[0]) ? (box[2] + box[5]) / 2 : null
			});
		}
		console.log(`[phasing] ${category || 'model'}: ${dbids.length} elements`);
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

		// phases: category-major (structure, floors, walls, envelope, stairs, doors), level-minor
		const cats = this._cfg.levelCategories;
		let all: Array<Omit<Phase, 'start' | 'end'>> = [];
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

		// bucket by per-element category: level categories drop level by level,
		// roof/finishes via their static phase, everything else goes to 'other'
		// (appended at the end of the belt only if it has any elements)
		this._buckets = new Map();
		const push = (pid: string, model: any, dbid: number) => {
			if (!this._buckets.has(pid)) this._buckets.set(pid, new Map());
			const m = this._buckets.get(pid)!;
			if (!m.has(model)) m.set(model, []);
			m.get(model)!.push(dbid);
		};
		let sawOther = false;
		for (const e of this._entries) {
			const cat = e.category;
			const lv = e.level === 'roof' ? null : (e.level ?? band(e));
			let pid: string;
			if (this._catPhase.has(cat)) pid = this._catPhase.get(cat)!;
			else if (lv === null) pid = 'roof';
			else if (cats.includes(cat)) pid = cat.toLowerCase() + '-' + lv;
			else { pid = 'other'; sawOther = true; }
			push(pid, e.model, e.dbid);
		}
		if (sawOther) {
			all.push({ id: 'other', name: 'Other', short: 'Other', color: [110, 110, 110] });
		}
		// drop phases that ended up with no elements — no dead slots on the belt
		all = all.filter((p) => this._buckets.has(p.id));

		// Conveyor-belt timeline: a new part appears every `step` units, but each
		// part stays in flight for `overlap` steps, so several parts hang and fall
		// simultaneously (exactly `overlap` of them at any interior time). The
		// last part lands exactly at t=100.
		const overlap = this._cfg.overlap ?? 2;
		const step = 100 / (all.length - 1 + overlap);
		this._phases = all.map((p, i) => ({
			...p,
			start: i * step,
			end: i * step + overlap * step,
			_lift: 0 // current visual lift (last applied drop height)
		}));
		this._phaseById = new Map(this._phases.map((p) => [p.id, p]));
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
	// ease-out (cubic): parts drop quickly at first, then settle gently into place
	private easeOut(u: number): number {
		return 1 - Math.pow(1 - u, 3);
	}
	// Target lift (hanging height) of a phase at time t; 0 = settled on the floor.
	private liftTarget(p: Phase, t: number): number {
		return this.statusOf(p, t) === 1 ? (1 - this.easeOut(this.progress(p, t))) * (this._cfg?.dropHeight ?? 0) : 0;
	}

	// Called on every slider input: rebuild the isolated visible set and reapply
	// theming when the phase status set changes, then move every in-flight phase's
	// lift exactly where t puts it. The 0..1000 slider stepping makes the fall
	// smooth — no tweening.
	update(t: number): void {
		const key = this._phases.map((p) => this.statusOf(p, t)).join('');
		const keyChanged = key !== this._statusKey;
		if (keyChanged) this._statusKey = key;
		// Always re-apply visibility via isolate(); LMV state can drift while
		// scrubbing (new fragments stream, isolation state is shared, etc.), so
		// relying only on the status key lets geometry leak when scrubbing back
		// to an earlier slider position.
		this.render(t, keyChanged);
		for (const p of this._phases) {
			const target = this.liftTarget(p, t);
			if (p._lift === target) continue;
			// skip sub-step jitter mid-curve, but NEVER when settling: the eased
			// tail moves < 0.5 units per step, so target 0 must always land exactly
			if (target !== 0 && Math.abs((p._lift ?? 0) - target) < 0.5) continue;
			p._lift = target;
			this._applyLift(p, target);
		}
	}

	render(t: number, applyTheming: boolean): void {
		// Build the set of dbIds that should be visible at this t, per model.
		// viewer.isolate() is the renderer's own "source of truth" visibility call:
		// it hides every fragment except the isolated set in one shot. This avoids
		// the SVF2 visibility-manager race that could leave furniture/windows/etc.
		// drawn at t=0 when viewer.hide() was issued before all fragments streamed.
		const visibleByModel = new Map<any, Set<number>>();
		for (const [pid, byModel] of this._buckets) {
			const p = this._phaseById.get(pid);
			if (!p) continue;
			const s = this.statusOf(p, t);
			const statusChanged = s !== p._lastStatus;
			if (statusChanged) p._lastStatus = s;
			const [r, g, b] = p.color;
			const c = s === 0 ? null : new (three().Vector4)(r / 255, g / 255, b / 255, s === 2 ? 0.35 : 1);
			for (const [model, dbids] of byModel) {
				if (!visibleByModel.has(model)) visibleByModel.set(model, new Set());
				if (s !== 0) {
					const visible = visibleByModel.get(model)!;
					for (const d of dbids) visible.add(d);
				}
				if (applyTheming && statusChanged) {
					try {
						for (const d of dbids) model.setThemingColor(d, c);
					} catch (err: any) {
						console.warn('[phasing] theming', pid, err?.message);
					}
				}
			}
		}
		for (const [model, visible] of visibleByModel) {
			try {
				this.viewer.isolate([...visible], model);
			} catch (err: any) {
				console.warn('[phasing] isolate', err?.message);
			}
		}
		this.viewer.impl.invalidate(true);
	}

	/* ---- fall-in animation ----
	 * The slider drives the drop height directly (0..1000 steps = ~1% of
	 * dropHeight per step, so the fall is smooth without tweening). */

	// Set a phase's fragments to the given lift (z offset above their resting place).
	private _applyLift(p: Phase, z: number): void {
		this.pos.set(0, 0, z);
		const byModel = this._buckets.get(p.id) || new Map();
		for (const [model, dbids] of byModel) {
			// NOTE: no isLoadDone() guard here — SVF2 models can report false
			// even when fully rendered, and the transform is harmless to apply.
			const fl = model.getFragmentList();
			const tree = this._trees.get(model);
			if (!fl || !fl.updateAnimTransform || !tree) continue;
			for (const d of dbids) {
				// NOTE: the SVF2 fragment list has no dbId2fragId map — enumerate
				// the node's fragments through the instance tree instead.
				tree.enumNodeFragments(d, (f: number) => fl.updateAnimTransform(f, null, null, this.pos));
			}
		}
		this.viewer.impl.invalidate(true);
	}

	// Remove the anim transform entirely (original position).
	private _resetLift(p: Phase): void {
		const byModel = this._buckets.get(p.id) || new Map();
		for (const [model, dbids] of byModel) {
			const fl = model.getFragmentList();
			const tree = this._trees.get(model);
			if (!fl || !fl.updateAnimTransform || !tree) continue;
			for (const d of dbids) tree.enumNodeFragments(d, (f: number) => fl.updateAnimTransform(f));
		}
		this.viewer.impl.invalidate(true);
	}

	clearOverrides(): void {
		for (const p of this._phases) {
			p._lastStatus = undefined;
			p._lift = 0;
			this._resetLift(p); // restore fragment transforms
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
		// Fully exit isolation mode so the next bar activation starts from a
		// clean "everything visible" state.
		try {
			if (live.size && this.viewer.showAll) this.viewer.showAll();
		} catch (err: any) {
			console.warn('[phasing] clearOverrides showAll', err?.message);
		}
		this._statusKey = null;
		this.viewer.impl.invalidate(true);
	}
}
