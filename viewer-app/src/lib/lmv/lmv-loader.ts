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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function loadLmvModel(viewer: any, urn: string): Promise<any> {
	const Autodesk = autodesk();
	return new Promise((resolve) => {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		Autodesk.Viewing.Document.load(`urn:${urn}`, (doc: any) => {
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

			// Replace the previously loaded model so the viewer only holds the
			// active site's model. Explicit unload of viewer.model (belt) plus
			// keepCurrentModels:false (suspenders) so repeated site switches never
			// accumulate models.
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const previousModel: any = viewer.model;
			if (previousModel) {
				try {
					viewer.unloadModel(previousModel);
				} catch {
					// Model may still be mid-load — loadDocumentNode will replace it.
				}
			}

			viewer.loadDocumentNode(doc, viewable, { keepCurrentModels: false });
		});
	});
}
