/**
 * LMV (APS Viewer) bootstrap helpers — TypeScript port of
 * wallabyway/viewer-plus-maplibre @ c9f6bad (lmv-loader.mjs).
 *
 * Vendor boundary: Autodesk/THREE globals come from the viewer3D CDN script
 * loaded in app.html, so everything is accessed lazily (SSR-safe) and typed
 * as `any`.
 */

const API_BASE = import.meta.env.DEV
	? '/api'
	: 'https://d1rfabreh9lcnl.cloudfront.net/api';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const autodesk = (): any => (window as any).Autodesk;

type TokenResponse = { access_token: string; expires_in: number };

const fetchAccessToken = (): Promise<TokenResponse> =>
	fetch(`${API_BASE}/auth/token`).then((r) => r.json());

export const fetchModelCatalog = (): Promise<Array<{ name: string; urn: string }>> =>
	fetch(`${API_BASE}/models/buckets?id=samplemodels`)
		.then((r) => r.json())
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		.then((items) => items.map((m: any) => ({ name: m.text, urn: m.id })));

export async function initializeLmvSdk(): Promise<void> {
	const token = await fetchAccessToken();
	const Autodesk = autodesk();

	// LMV >= 7.119 enables "Large Model Experience" (HLOD / out-of-core tile
	// manager) by default. Its geometry streaming stalls when the viewer is
	// driven manually like we do here (impl.stop() + external tick()), so
	// geometry never loads and GEOMETRY_LOADED_EVENT never fires.
	if (Autodesk.Viewing.FeatureFlags?._setInitializationData) {
		Autodesk.Viewing.FeatureFlags._setInitializationData('LARGE_MODEL_EXPERIENCE', {
			overridePreferenceValue: false
		});
	}

	return new Promise((resolve) => {
		Autodesk.Viewing.Initializer(
			{
				env: 'AutodeskProduction2',
				api: 'streamingV2',
				getAccessToken: (cb: (token: string, expires: number) => void) =>
					cb(token.access_token, token.expires_in)
			},
			resolve
		);
	});
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function resolveLmvRendererClass(): any {
	const Autodesk = autodesk();
	const div = document.createElement('div');
	div.style.cssText =
		'position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden';
	document.body.appendChild(div);

	const temp = new Autodesk.Viewing.Viewer3D(div);
	temp.start();
	const RendererClass = temp.impl.glrenderer().constructor;
	temp.finish();
	document.body.removeChild(div);

	return RendererClass;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createSharedLmvRenderer(RendererClass: any, canvas: HTMLCanvasElement): any {
	const renderer = new RendererClass({ canvas });
	renderer.autoClear = false;
	renderer.sortObjects = false;
	renderer.refCount = 0;

	// MapLibre clamps the canvas backing store to its maxCanvasSize (4096 by
	// default) by lowering the *applied* pixel ratio once clientWidth×DPR
	// exceeds it. So device px ≠ CSS px × devicePixelRatio past that clamp.
	// Force LMV's pixel ratio to the ratio MapLibre actually applied
	// (canvas.width / clientWidth), or LMV and MapLibre end up rendering
	// into different pixel spaces and camera sync breaks. Note: LMV's
	// setViewport/setSize take CSS px and apply the pixel ratio internally.
	const deviceRatio = () => (canvas.clientWidth ? canvas.width / canvas.clientWidth : 1) || 1;

	const origSetPixelRatio = renderer.setPixelRatio.bind(renderer);
	renderer.setPixelRatio = function () {
		origSetPixelRatio(deviceRatio());
	};

	renderer.setSize = function () {
		renderer.setViewport(0, 0, canvas.clientWidth, canvas.clientHeight);
	};

	return renderer;
}

/**
 * Make LMV's background transparent and enable alpha blending on the
 * final blit (presentBuffer) so MapLibre's map shows through.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function configureTransparentLmvRendering(viewer: any): void {
	const THREE = (window as any).THREE;
	const rc = viewer.impl.renderer();
	const glr = viewer.impl.glrenderer();
	const gl = glr.getContext();

	rc.setClearColors(new THREE.Color(0, 0, 0));
	rc.setClearAlpha(0);
	viewer.impl.toggleEnvMapBackground(false);
	rc.setAOEnabled(false);

	let forceBlend = false;
	const origDisable = gl.disable.bind(gl);
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	(gl as any).disable = function (cap: number) {
		if (forceBlend && cap === gl.BLEND) return;
		origDisable(cap);
	};

	const canvasMultisampled = !!gl.getContextAttributes().antialias;
	if (canvasMultisampled) {
		console.warn(
			'[LMV] Canvas has antialias enabled (multisampled default framebuffer). ' +
				'Depth blit from LMV FBOs is disabled to avoid GL_INVALID_OPERATION.'
		);
	}

	const origPresent = rc.presentBuffer.bind(rc);
	rc.presentBuffer = function (userFinalPass: boolean) {
		gl.enable(gl.BLEND);
		gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
		forceBlend = true;
		origPresent(userFinalPass);
		forceBlend = false;

		if (canvasMultisampled) return;

		const colorTarget = rc.getColorTarget();
		if (colorTarget) {
			glr.setRenderTarget(colorTarget);
			glr.setRenderTarget(null);

			const fbo = colorTarget.__webglFramebuffer;
			if (fbo) {
				const w = colorTarget.width;
				const h = colorTarget.height;
				gl.bindFramebuffer(gl.READ_FRAMEBUFFER, fbo);
				gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
				gl.blitFramebuffer(0, 0, w, h, 0, 0, w, h, gl.DEPTH_BUFFER_BIT, gl.NEAREST);
			}
		}
	};
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createStoppedLmvViewer(
	container: HTMLElement,
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	glrenderer: any,
	mapCanvas: HTMLCanvasElement
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
): any {
	const Autodesk = autodesk();
	const viewer = new Autodesk.Viewing.GuiViewer3D(container);
	viewer.start(null, null, null, null, { glrenderer });

	viewer.impl.stop();
	viewer.impl.skipCameraUpdate = true;

	const w = mapCanvas.clientWidth;
	const h = mapCanvas.clientHeight;
	viewer.impl.resize(w, h, true);

	configureTransparentLmvRendering(viewer);

	return viewer;
}

/**
 * Unload every model currently in the viewer (the phased Snowdon load puts
 * five models in; `viewer.model` alone would leave the other four behind).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function unloadAllLmvModels(viewer: any): void {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const models: any[] =
		viewer.impl?.modelQueue?.()?.getModels?.() ?? (viewer.model ? [viewer.model] : []);
	for (const model of models) {
		try {
			viewer.unloadModel(model);
		} catch {
			// Model may still be mid-load — loadDocumentNode will replace it.
		}
	}
}

/**
 * unloadModel tears down asynchronously; models still in the queue when the
 * next load starts survive it and render as untracked duplicates. Wait until
 * the model queue is actually empty (bounded — a wedged model must not block
 * the load; the keepCurrentModels:false path below is the backstop).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function waitForModelQueueEmpty(viewer: any, timeoutMs = 8000): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		const count = viewer.impl?.modelQueue?.()?.getModels?.()?.length ?? 0;
		if (count === 0) return;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function loadLmvModel(viewer: any, urn: string): Promise<any> {
	const Autodesk = autodesk();
	return new Promise((resolve) => {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		Autodesk.Viewing.Document.load(`urn:${urn}`, async (doc: any) => {
			const viewable = doc.getRoot().getDefaultGeometry();

			// Attach BEFORE loadDocumentNode: MODEL_ADDED_EVENT can fire
			// synchronously during the call. Note: GEOMETRY_LOADED_EVENT no
			// longer fires reliably on LMV >= 7.124 when the viewer is driven
			// manually (impl.stop + external tick), so MODEL_ADDED is our signal.
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			viewer.addEventListener(Autodesk.Viewing.MODEL_ADDED_EVENT, function onAdded(model: any) {
				viewer.removeEventListener(Autodesk.Viewing.MODEL_ADDED_EVENT, onAdded);
				resolve(model);
			});

			// Replace previously loaded models so the viewer only holds the
			// active site's model. Explicit unload (belt) plus
			// keepCurrentModels:false (suspenders) so repeated site switches
			// never accumulate models.
			unloadAllLmvModels(viewer);
			await waitForModelQueueEmpty(viewer);

			viewer.loadDocumentNode(doc, viewable, { keepCurrentModels: false });
		});
	});
}

/* ── Construction-phasing model (Snowdon Towers) ──────────────
 * The Snowdon model was translated into five coordinated 3D views, one per
 * Revit category (no combined view exists). The phasing extension needs each
 * category loaded as its own model instance, tagged with its category. */

export const SNOWDON_MODEL_URN =
	'dXJuOmFkc2sub2JqZWN0czpvcy5vYmplY3Q6c2FtcGxlbW9kZWxzL1Nub3dkb24lMjBUb3dlcnMlMjBTYW1wbGUlMjBBcmNoaXRlY3R1cmFsLnJ2dA==';

/** Viewable name -> phasing category (from wallabyway/phase-lmv-extension). */
export const SNOWDON_VIEWABLES: Record<string, string> = {
	'Coord - Arch Floors': 'Floors',
	'Coord - Arch Stairs': 'Stairs',
	'Coord - Arch Walls': 'Walls',
	'Coord - Arch Lighting': 'Lighting Fixtures',
	'Coord - Arch Roofs': 'Roofs'
};

/**
 * Load every coordinated category viewable of the Snowdon model into the
 * viewer at once. Resolves with [{model, category}] once all viewables are
 * added. No fitToView — MapLibre owns the camera.
 */
export function loadLmvPhasedModels(
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	viewer: any,
	urn: string,
	viewables: Record<string, string>
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<Array<{ model: any; category: string }>> {
	const Autodesk = autodesk();
	return new Promise((resolve, reject) => {
		Autodesk.Viewing.Document.load(
			`urn:${urn}`,
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			async (doc: any) => {
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				const nameOf = (v: any): string => (typeof v.name === 'function' ? v.name() : v.name);
				const wanted = doc
					.getRoot()
					.search({ role: '3d' })
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					.filter((v: any) => v.data && v.data.type === 'geometry' && viewables[nameOf(v)]);
				if (!wanted.length) {
					reject(new Error('[phasing] no coordinated category viewables found'));
					return;
				}

				unloadAllLmvModels(viewer);
				await waitForModelQueueEmpty(viewer);

				// First viewable goes through LMV's own full teardown
				// (keepCurrentModels:false) as a backstop for anything the
				// manual unload missed; the rest are added alongside it.
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				const toEntry = (model: any, viewable: any) => ({
					model,
					category: viewables[nameOf(viewable)]
				});
				const first = await viewer.loadDocumentNode(doc, wanted[0], {
					keepCurrentModels: false
				});
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				const rest = await Promise.all(
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					wanted.slice(1).map((viewable: any) =>
						viewer.loadDocumentNode(doc, viewable, { keepCurrentModels: true })
					)
				);
				resolve([
					toEntry(first, wanted[0]),
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					...rest.map((model: any, i: number) => toEntry(model, wanted[i + 1]))
				]);
			},
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			(code: any, message: any) => reject(new Error(`[phasing] document load failed: ${code} ${message}`))
		);
	});
}
