/**
 * LMV ↔ MapLibre bridge — TypeScript port of
 * wallabyway/viewer-plus-maplibre @ c9f6bad (lmv-maplibre-bridge.mjs).
 *
 * Wires one LMV viewer into one MapLibre map via a shared WebGL context.
 * MapLibre owns the camera and the frame loop; LMV renders into MapLibre's
 * canvas using the projection matrix supplied by the custom layer.
 *
 * SSR-safe: window.THREE / window.Autodesk are only read inside functions
 * that run at mount time, never at module scope.
 */

import maplibregl from 'maplibre-gl';
import {
	initializeLmvSdk,
	resolveLmvRendererClass,
	createSharedLmvRenderer,
	createStoppedLmvViewer,
	loadLmvModel,
	SNOWDON_MODEL_URN
} from './lmv-loader';
import { APP_COLOR_MODE, getLmvTheme } from '$lib/config/theme';
import { ensureCustomViewMatrixPatch } from '$lib/walk/custom-view-matrix-patch';
import { WalkingCam } from '$lib/walk/walking-cam';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyViewer = any;

export type ModelPlacement = ReturnType<typeof createMercatorModelPlacement>;

export type LmvInteractionMode = 'map' | 'lmv';

export type LmvBridge = {
	layer: maplibregl.CustomLayerInterface;
	loadModel: (urn: string) => Promise<void>;
	setPlacement: (placement: ModelPlacement) => void;
	getPlacement: () => ModelPlacement;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	getViewer: () => any;
	// 'lmv' = pointer events forward to the model (selection, measure, section
	// tools); 'map' = MapLibre owns all input. The camera stays MapLibre-owned
	// in both modes.
	setInteractionMode: (mode: LmvInteractionMode) => void;
	// Streetwalk walking camera (WASD + mouse-look) — a MapLibre camera mode.
	setWalkMode: (enabled: boolean) => void;
	isWalkModeActive: () => boolean;
};

// ── Matrix helpers ────────────────────────────────────────────

/** Multiply two column-major 4×4 matrices using Float64 arithmetic. */
function multiplyMatrix4Float64(a: ArrayLike<number>, b: ArrayLike<number>): Float64Array {
	const result = new Float64Array(16);

	for (let column = 0; column < 4; column++) {
		for (let row = 0; row < 4; row++) {
			result[row + column * 4] =
				a[row] * b[column * 4] +
				a[row + 4] * b[column * 4 + 1] +
				a[row + 8] * b[column * 4 + 2] +
				a[row + 12] * b[column * 4 + 3];
		}
	}

	return result;
}

/**
 * Create the geographic/model placement constants used by the bridge.
 * The model coordinates are in feet, while MapLibre's Mercator coordinates
 * are expressed in meters-at-the-model-location.
 */
export function createMercatorModelPlacement({
	origin,
	altitude,
	rotationDeg,
	unitScale
}: {
	origin: [number, number];
	altitude: number;
	rotationDeg: number;
	unitScale: number;
}) {
	const modelMercator = maplibregl.MercatorCoordinate.fromLngLat(origin, altitude);
	const rotationRad = (rotationDeg * Math.PI) / 180;

	return {
		origin,
		modelMercator,
		rotationCos: Math.cos(rotationRad),
		rotationSin: Math.sin(rotationRad),
		mercatorScale: modelMercator.meterInMercatorCoordinateUnits() * unitScale
	};
}

/**
 * Build the combined MapLibre view-projection/model matrix consumed by LMV.
 * The camera center is subtracted before the model transform to preserve
 * precision when MapLibre is rendering at large viewport sizes.
 */
function computeCombinedModelProjectionMatrix({
	map,
	mainMatrix,
	placement
}: {
	map: maplibregl.Map;
	mainMatrix: ArrayLike<number>;
	placement: ModelPlacement;
}): Float64Array {
	const cameraCenter = map.getCenter();
	const cameraMercator = maplibregl.MercatorCoordinate.fromLngLat(cameraCenter, 0);

	const dx = placement.modelMercator.x - cameraMercator.x;
	const dy = placement.modelMercator.y - cameraMercator.y;
	const dz = placement.modelMercator.z - (cameraMercator.z || 0);

	// Re-center the MapLibre view-projection matrix at the current map camera.
	const cameraTranslation = new Float64Array([
		1, 0, 0, 0,
		0, 1, 0, 0,
		0, 0, 1, 0,
		cameraMercator.x, cameraMercator.y, cameraMercator.z || 0, 1
	]);
	const centeredViewProjection = multiplyMatrix4Float64(mainMatrix, cameraTranslation);

	const scale = placement.mercatorScale;
	const modelMatrix = new Float64Array([
		 scale * placement.rotationCos, -scale * placement.rotationSin, 0, 0,
		-scale * placement.rotationSin, -scale * placement.rotationCos, 0, 0,
		 0,                            0,                             scale, 0,
		 dx,                           dy,                            dz,    1
	]);

	return multiplyMatrix4Float64(centeredViewProjection, modelMatrix);
}

/**
 * The map camera's eye position expressed in LMV model coordinates (the
 * inverse of the modelMatrix above: world mercator = modelMercator +
 * s·R·model). Tools read camera.position directly (e.g. gizmos use it for
 * their drag plane), so the bridge keeps it honest even though the render
 * path never uses it (matrixWorld stays pinned to identity).
 */
function computeModelSpaceEyePosition(
	map: maplibregl.Map,
	placement: ModelPlacement
): [number, number, number] | null {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const eyeMerc = (map as any).getFreeCameraOptions?.()?.position;
	if (!eyeMerc) return null;

	const ex = eyeMerc.x - placement.modelMercator.x;
	const ey = eyeMerc.y - placement.modelMercator.y;
	const ez = (eyeMerc.z || 0) - placement.modelMercator.z;
	const s = placement.mercatorScale;

	return [
		(ex * placement.rotationCos - ey * placement.rotationSin) / s,
		(-ex * placement.rotationSin - ey * placement.rotationCos) / s,
		ez / s
	];
}

/**
 * Remap the near plane of the combined view-projection matrix.
 *
 * The combined matrix inherits MapLibre's near/far (nearZ ≈ canvas height/50
 * world-pixels — several meters at site zooms), so LMV geometry vanishes in
 * AABB-sized chunks whenever the camera gets close to the building. MapLibre
 * needs that large near plane for tile depth precision, but LMV renders into
 * its own FBO and presents with alpha blending (no shared depth with the
 * basemap on a multisampled canvas), so the model can safely use a much
 * tighter near plane.
 *
 * For two perspective matrices that differ only in near/far, P′·P⁻¹ collapses
 * to a depth-scale D with D[10]=α, D[14]=β — exact, no inversion needed.
 * Returns the input matrix unchanged if the source near/far look wrong.
 */
const LMV_NEAR_Z_PX = 1; // world-pixels ≈ 0.1–0.5 m at typical site zooms

function remapNearPlane(
	matrix: Float64Array,
	nearZ: number,
	farZ: number
): Float64Array {
	if (!(nearZ > 0) || !(farZ > nearZ)) return matrix;
	const near = Math.min(LMV_NEAR_Z_PX, nearZ);
	const far = farZ;
	if (Math.abs(near - nearZ) < 1e-6) return matrix;

	const A = (farZ + nearZ) / (nearZ - farZ);
	const B = (2 * farZ * nearZ) / (nearZ - farZ);
	const A2 = (far + near) / (near - far);
	const B2 = (2 * far * near) / (near - far);
	const alpha = B2 / B;
	const beta = alpha * A - A2;

	const depthScale = new Float64Array([
		1, 0, 0, 0,
		0, 1, 0, 0,
		0, 0, alpha, 0,
		0, 0, beta, 1
	]);
	return multiplyMatrix4Float64(depthScale, matrix);
}

/** Clean up WebGL state that LMV's R71 resetGLState does not touch. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function restoreSharedWebGLState(
	gl: WebGL2RenderingContext,
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	renderer: any
): void {
	renderer.resetGLState();
	gl.bindVertexArray(null);
	gl.bindBuffer(gl.ARRAY_BUFFER, null);
	gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);
	gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
	gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, null);
	gl.bindFramebuffer(gl.FRAMEBUFFER, null);
	gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
	gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
	gl.activeTexture(gl.TEXTURE0);
	gl.bindTexture(gl.TEXTURE_2D, null);
	gl.bindTexture(gl.TEXTURE_CUBE_MAP, null);
	gl.useProgram(null);
}

// ── Bridge ────────────────────────────────────────────────────

/**
 * Wires one LMV viewer into one MapLibre map. MapLibre remains the camera
 * owner; LMV renders into MapLibre's shared WebGL context using the
 * projection matrix supplied by the custom layer.
 *
 * Returns { layer, loadModel }: add `layer` to the map, call `loadModel(urn)`
 * once the layer has been added (it waits for viewer init internally).
 */
export function createLmvBridge({
	container,
	modelPlacement,
	onStatus = () => {},
	onInteractionMode = () => {}
}: {
	container: HTMLElement;
	modelPlacement: ModelPlacement;
	onStatus?: (message: string) => void;
	// Fires whenever the interaction mode flips — including auto-switch from
	// the measure/section/explode tools — so the app store stays in sync.
	onInteractionMode?: (mode: LmvInteractionMode) => void;
}): LmvBridge {
	let map: maplibregl.Map | null = null;
	let mapCanvas: HTMLCanvasElement;
	let viewer: AnyViewer = null;
	let ready = false;
	let viewerReady: Promise<void> | null = null; // set in onAdd; awaited by loadModel
	let combinedMatrix64: Float64Array | null = null;
	// Swappable placement — setPlacement() lets the app relocate the model to a
	// different lat/long (e.g. when a different site is picked from the combo box).
	let currentPlacement: ModelPlacement = modelPlacement;

	// THREE is only available after the viewer3D CDN script has run — capture
	// lazily at bridge-creation time (called from onMount), never at import.
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const THREE: any = (window as any).THREE;

	const combinedInverse = new THREE.Matrix4();
	const nearPoint = new THREE.Vector3();
	const farPoint = new THREE.Vector3();

	const layer: maplibregl.CustomLayerInterface = {
		id: 'lmv-model',
		type: 'custom',
		renderingMode: '3d',

		onAdd(mapInstance) {
			if (viewerReady) return;
			map = mapInstance;
			mapCanvas = mapInstance.getCanvas();

			// Streetwalk camera: patch this map's transform so the walking cam
			// can inject a first-person view matrix (stock maplibre-gl has no
			// setCustomViewMatrix — the patch adds it, ported from
			// wallabyway/streetwalk-gl's patched build).
			ensureCustomViewMatrixPatch(mapInstance);
			walkingCam = new WalkingCam(mapInstance, {
				onDisabled: () => {
					if (!walkModeActive) return;
					walkModeActive = false;
					cameraControlsExtension?.setActiveMode?.('map');
				}
			});

			viewerReady = initializeViewer();
		},

		render(gl, args) {
			if (!viewer) return;

			resizeLmvToMapCanvas();

			if (!ready) {
				viewer.impl.tick(performance.now());
				restoreSharedWebGLState(gl as WebGL2RenderingContext, viewer.impl.glrenderer());
				map?.triggerRepaint();
				return;
			}

			const renderer = viewer.impl.glrenderer();

			// MapLibre always owns the camera — pin LMV's render to the combined
			// MapLibre view-projection. This holds in walk mode too: the walking
			// camera injects its view matrix into MapLibre's transform itself
			// (custom-view-matrix patch), so mainMatrix already tracks it.
			const combinedMatrix = computeCombinedModelProjectionMatrix({
				map: map as maplibregl.Map,
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				mainMatrix: (args as any).defaultProjectionData.mainMatrix,
				placement: currentPlacement
			});
			// Loosen the near plane for LMV only — see remapNearPlane().
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const renderArgs = args as any;
			applyMapLibreCameraTransform(
				remapNearPlane(combinedMatrix, renderArgs.nearZ, renderArgs.farZ)
			);

			renderer.resetGLState();
			renderer.setViewport(0, 0, mapCanvas.clientWidth, mapCanvas.clientHeight);

			viewer.impl.invalidate(true, true, true);
			viewer.impl.tick(performance.now());

			restoreSharedWebGLState(gl as WebGL2RenderingContext, renderer);
		}
	};

	async function initializeViewer(): Promise<void> {
		onStatus('Initializing LMV...');
		await initializeLmvSdk();

		onStatus('Bootstrapping renderer...');
		const rendererClass = resolveLmvRendererClass();
		const sharedRenderer = createSharedLmvRenderer(rendererClass, mapCanvas);
		viewer = createStoppedLmvViewer(container, sharedRenderer, mapCanvas);

		// Keep the existing debug hook useful without making application code
		// depend on it.
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		(window as any).__lmvViewer = viewer;

		configureViewerForMapLibre();
		await ensureCameraControlsExtension();
	}

	function configureViewerForMapLibre(): void {
		bindLmvRepaintEvents();
		patchLmvCanvasBounds();
		patchLmvViewportToRay();
		patchTransformControlsPicking();
		bindMapPointerForwarding();
		bindInteractionAutoSwitch();
		viewer.impl.setRightBtnSelection(true);

		viewer.setGhosting(false);
		viewer.setGroundShadow(false);
		viewer.setLightPreset(1);
		viewer.setTheme(getLmvTheme(APP_COLOR_MODE));
		viewer.impl.renderer().setAOEnabled(false);
	}

	function bindLmvRepaintEvents(): void {
		const Autodesk = (window as any).Autodesk;

		// LMV's own render loop is stopped — MapLibre owns frames. Subscribe to
		// every event LMV exposes (the names already live on Autodesk.Viewing),
		// so any GUI-driven state change (selection, visibility, isolate, panels,
		// resize...) schedules a MapLibre repaint without us maintaining a list.
		// Excluded: events fired BY rendering itself (they'd feed back into
		// triggerRepaint → tick → event forever) and PROGRESS_UPDATE, which
		// fires continuously while streaming.
		const EXCLUDED_EVENTS = new Set([
			'PROGRESS_UPDATE_EVENT',
			'RENDERING_TICKED_EVENT',
			'RENDER_PRESENTED_EVENT'
		]);
		const eventTypes: string[] = [
			...new Set<string>(
				Object.keys(Autodesk.Viewing)
					.filter((name) => name.endsWith('_EVENT') && !EXCLUDED_EVENTS.has(name))
					.map((name) => Autodesk.Viewing[name])
					.filter((value) => typeof value === 'string')
			)
		];

		// Model-browser actions such as isolate/fit-to-view can update LMV's
		// own camera after the visibility event has fired. On these events the
		// bridge must also cancel LMV's camera transition so impl.tick() can't
		// overwrite MapLibre's projection before the shared canvas is presented.
		const cameraEvents = new Set<string>(
			[
				Autodesk.Viewing.FIT_TO_VIEW_EVENT,
				Autodesk.Viewing.AGGREGATE_FIT_TO_VIEW_EVENT,
				Autodesk.Viewing.CAMERA_CHANGE_EVENT
			].filter(Boolean)
		);

		for (const eventType of eventTypes) {
			viewer.addEventListener(eventType, () => {
				if (ready && cameraEvents.has(eventType)) {
					cancelLmvCameraTransition();
				}
				map?.triggerRepaint();
			});
		}
	}

	function cancelLmvCameraTransition(): void {
		const navigation = viewer?.navigation;
		navigation?.setRequestTransition?.(false);
		navigation?.setRequestFitToView?.(false);
		navigation?.setRequestHomeView?.(false);
		if (navigation?.getTransitionActive?.()) {
			navigation.setTransitionActive(false);
		}

		// Autocam schedules the fit animation independently with requestAnimationFrame.
		// Stop that callback as well, otherwise impl.tick() can overwrite the map
		// projection again after the bridge has applied it.
		const autocam = viewer?.autocam;
		if (autocam?.afAnimateTransition !== undefined && autocam?.afAnimateTransition !== null) {
			cancelAnimationFrame(autocam.afAnimateTransition);
			autocam.afAnimateTransition = null;
		}
		if (autocam) autocam.currentlyAnimating = false;
	}

	function patchLmvCanvasBounds(): void {
		// The LMV canvas is display:none. Use the visible MapLibre canvas for
		// clientToViewport and context-menu coordinate conversion.
		viewer.impl.getCanvasBoundingClientRect = () => mapCanvas.getBoundingClientRect();
	}

	// ── Repaint bursts for time-based LMV animations ────────────
	// LMV's render loop is stopped; extensions that animate over time (e.g.
	// the VisualClusters layout, ~5s on toggle) only advance when impl.tick()
	// runs, which here only happens during a MapLibre frame. Feed repaints
	// for the animation duration so the motion plays out.
	let repaintBurstUntil = 0;
	let repaintBurstScheduled = false;

	function requestRepaintBurst(durationMs: number): void {
		repaintBurstUntil = performance.now() + durationMs;
		if (repaintBurstScheduled) return;
		repaintBurstScheduled = true;
		const step = () => {
			if (performance.now() < repaintBurstUntil && map) {
				map.triggerRepaint();
				requestAnimationFrame(step);
			} else {
				repaintBurstScheduled = false;
			}
		};
		requestAnimationFrame(step);
	}

	function patchLmvViewportToRay(): void {
		// LMV's stock implementation uses camera.position and matrixWorld. This
		// integration pins both to identity and puts the complete MapLibre view
		// in projectionMatrix, so unproject through that combined matrix instead.
		const camera = viewer.impl.camera;
		const stockViewportToRay = camera.viewportToRay.bind(camera);

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		camera.viewportToRay = (viewport: { x: number; y: number }, ray?: any) => {
			if (!combinedMatrix64) return stockViewportToRay(viewport, ray);

			ray ||= new THREE.Ray();
			combinedInverse.fromArray(combinedMatrix64).invert();

			// LMV uses legacy R71 Vector3 semantics: applyMatrix4 assumes an
			// affine matrix and does not perform the homogeneous divide.
			nearPoint.set(viewport.x, viewport.y, -1).applyProjection(combinedInverse);
			farPoint.set(viewport.x, viewport.y, 1).applyProjection(combinedInverse);

			ray.origin.copy(nearPoint);
			ray.direction.copy(farPoint).sub(nearPoint).normalize();
			return ray;
		};

		// Same pinning problem, different victim: the section tool's gizmo
		// picker builds its pick ray as (per-pixel unprojected origin, camera
		// getWorldDirection()). With matrixWorld pinned to identity the stock
		// getWorldDirection always returns (0,0,-1), so every pick ray shoots
		// down the model's Z axis and hover/drag never engages. Return the
		// true forward of the combined view instead. Before the first pinned
		// frame (combinedMatrix64 still null), defer to the stock version.
		const stockGetWorldDirection = camera.getWorldDirection.bind(camera);
		const worldForward = new THREE.Vector3();
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		camera.getWorldDirection = (target?: any) => {
			if (!combinedMatrix64) return stockGetWorldDirection(target);
			target ||= new THREE.Vector3();

			combinedInverse.fromArray(combinedMatrix64).invert();
			nearPoint.set(0, 0, -1).applyProjection(combinedInverse);
			farPoint.set(0, 0, 1).applyProjection(combinedInverse);
			worldForward.copy(farPoint).sub(nearPoint).normalize();
			return target.copy(worldForward);
		};
	}

	// LMV's internal gizmo picking (used by the section tool and other stock
	// gizmos) lives in Autodesk.Viewing.Private.TransformControls.
	// intersectObjects(canvasX, canvasY, objects, camera). Its perspective
	// branch reads camera.position (pinned to origin) and its ortho branch
	// reads camera.matrixWorld (pinned to identity), so both produce wrong
	// rays here. Route it through the patched camera.viewportToRay, which
	// unprojects through the combined MapLibre matrix correctly.
	function patchTransformControlsPicking(): void {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const tc = (window as any).Autodesk?.Viewing?.Private?.TransformControls;
		if (!tc?.intersectObjects || tc.__maplibreBridgePatched) return;
		tc.__maplibreBridgePatched = true;

		const stock = tc.intersectObjects.bind(tc);
		const patchedRaycaster = new THREE.Raycaster();

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		tc.intersectObjects = function (canvasX: number, canvasY: number, objects: any, camera: any, flag: any) {
			if (camera !== viewer?.impl?.camera || !combinedMatrix64) {
				return stock(canvasX, canvasY, objects, camera, flag);
			}
			const ray = camera.viewportToRay({
				x: (canvasX / camera.clientWidth) * 2 - 1,
				y: -(canvasY / camera.clientHeight) * 2 + 1
			});
			patchedRaycaster.ray.origin.copy(ray.origin);
			patchedRaycaster.ray.direction.copy(ray.direction);
			const hits = patchedRaycaster.intersectObjects(objects, flag);
			return hits.length ? hits[0] : null;
		};
	}

	function bindMapPointerForwarding(): void {
		// Listen on the canvas CONTAINER, not the canvas: overlay elements that
		// sit above the canvas (the location marker, future MapLibre controls)
		// swallow events targeted at them, and those events never reach a
		// canvas-only listener. The container sees them as they bubble.
		const eventSource = map?.getCanvasContainer() ?? mapCanvas;
		eventSource.addEventListener('contextmenu', (event) => event.preventDefault());

		for (const type of ['mousedown', 'mouseup'] as const) {
			eventSource.addEventListener(type, (event) => {
				if (event.button !== 2 || !viewer?.canvas) return;

				viewer.canvas.dispatchEvent(
					new MouseEvent(type, {
						bubbles: true,
						cancelable: true,
						button: 2,
						buttons: event.buttons,
						clientX: event.clientX,
						clientY: event.clientY,
						screenX: event.screenX,
						screenY: event.screenY
					})
				);
			});
		}
	}

	/**
	 * Relocate the model to a new geographic placement. Safe to call at any
	 * time — the next rendered frame picks the new matrix up immediately.
	 */
	function setPlacement(placement: ModelPlacement): void {
		currentPlacement = placement;
		map?.triggerRepaint();
	}

	function getPlacement(): ModelPlacement {
		return currentPlacement;
	}

	// Model loads must never overlap: two concurrent loads interleave
	// "unload all" with "add viewable" and leave untracked duplicate models
	// behind. Chain every call onto the previous one, and skip the work
	// entirely when the requested model is already in the viewer (the combo
	// box and the proximity loader often ask for the same site together).
	let loadChain: Promise<void> = Promise.resolve();
	let loadedUrn: string | null = null;

	function loadModel(urn: string): Promise<void> {
		const run = loadChain.then(async () => {
			await viewerReady;
			if (urn === loadedUrn && viewer.impl?.modelQueue?.()?.getModels?.()?.length) {
				return;
			}

			ready = false;
			onStatus('Loading model...');
			try {
				const model = await loadLmvModel(viewer, urn);
				if (urn === SNOWDON_MODEL_URN) {
					// Construction-phasing model (Snowdon Towers Complete): single
					// combined {3D} view; the engine buckets elements by their
					// per-element 'Category' property.
					const extension = await ensurePhasingExtension();
					if (extension) {
						extension.resetForNewModel();
						extension.addModel(model);
					}
				} else {
					// A non-phasing site replaced the model — drop stale engine state.
					phasingExtension?.resetForNewModel();
				}
				loadedUrn = urn;
			} catch (error) {
				loadedUrn = null; // allow retry
				throw error;
			}

			await ensureVisualClustersExtension();
			await ensureCameraControlsExtension(); // survives LMV's model-load teardown
			ready = true;

			onStatus('Model loaded');
			map?.triggerRepaint();
		});
		loadChain = run.catch(() => {});
		return run;
	}

	// Loaded once, the first time the Snowdon (phasing) model loads. Adds the
	// "Construction Phasing" button to the LMV toolbar; the slider bar markup
	// lives in ViewerCanvas.svelte. Failures are logged, never fatal.
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	let phasingExtension: any = null;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	async function ensurePhasingExtension(): Promise<any> {
		// LMV's GuiViewer3D tears down ALL extensions when a model is loaded
		// with keepCurrentModels:false over existing models — re-load if the
		// cached instance fell out of the registry.
		if (phasingExtension && viewer.getExtension('PhasingExtension')) return phasingExtension;
		phasingExtension = null;
		try {
			const { registerPhasingExtension, PHASING_EXTENSION_ID } = await import(
				'./phasing-extension/phasing-extension'
			);
			registerPhasingExtension();
			phasingExtension = await viewer.loadExtension(PHASING_EXTENSION_ID);

			// LMV's render loop is stopped — MapLibre owns frames. Slider input
			// and bar toggles funnel into update(), so one wrapper repaints for
			// every hide/theming/drop change the engine makes.
			const originalUpdate = phasingExtension.update.bind(phasingExtension);
			phasingExtension.update = (...args: unknown[]) => {
				originalUpdate(...args);
				map?.triggerRepaint();
			};
		} catch (error) {
			console.warn('[LMV] Phasing extension failed to load', error);
			phasingExtension = null;
		}
		return phasingExtension;
	}

	// Loaded once, after the first model is in. Adds the "Visual Clusters"
	// toggle to the LMV toolbar; activation stays with the user.
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	let visualClustersExtension: any = null;
	async function ensureVisualClustersExtension(): Promise<void> {
		// Same teardown note as the phasing extension above.
		if (visualClustersExtension && viewer.getExtension('Autodesk.VisualClusters')) return;
		visualClustersExtension = null;
		try {
			visualClustersExtension = await viewer.loadExtension('Autodesk.VisualClusters');
			hookClusterAnimation(visualClustersExtension);
		} catch (error) {
			console.warn('[LMV] VisualClusters extension failed to load', error);
		}
	}

	// The cluster layout animates over ~5s when toggled on/off. Wrap the
	// extension's transition/activation entry points so each one feeds a
	// repaint burst for the full animation. Clicks on the toolbar toggle
	// funnel into setActive, so no DOM listener is needed.
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	function hookClusterAnimation(extension: any): void {
		for (const fn of ['onTransitionStarted', 'setActive', 'setLayoutActive', 'applyLayout']) {
			const original = extension[fn];
			if (typeof original !== 'function') continue;
			extension[fn] = function (...args: unknown[]) {
				requestRepaintBurst(6000);
				return original.apply(this, args);
			};
		}
	}

	// Loaded once at viewer init. Adds the "Map camera / Walk camera" toggle
	// pair to the LMV toolbar; selection drives setWalkMode/setInteractionMode.
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	let cameraControlsExtension: any = null;
	async function ensureCameraControlsExtension(): Promise<void> {
		// LMV's GuiViewer3D tears down ALL extensions when a model is loaded
		// with keepCurrentModels:false over existing models — re-load if the
		// cached instance fell out of the registry.
		if (cameraControlsExtension && viewer.getExtension('CameraControlsExtension')) return;
		cameraControlsExtension = null;
		try {
			const { registerCameraControlsExtension, CAMERA_CONTROLS_EXTENSION_ID } = await import(
				'./camera-controls-extension'
			);
			registerCameraControlsExtension();
			cameraControlsExtension = await viewer.loadExtension(CAMERA_CONTROLS_EXTENSION_ID, {
				onSelect: (mode: 'map' | 'walk') => selectCameraMode(mode)
			});
			cameraControlsExtension.setActiveMode(walkModeActive ? 'walk' : 'map');
		} catch (error) {
			console.warn('[LMV] Camera-controls extension failed to load', error);
		}
		// No model loads at startup, so the toolbar may not have existed when
		// the extension loaded and onToolbarCreated never ran. Once the toolbar
		// is there (first model load), create the buttons ourselves.
		if (
			cameraControlsExtension &&
			viewer.toolbar &&
			!document.getElementById('camera-controls-map-button')
		) {
			try {
				cameraControlsExtension.onToolbarCreated();
			} catch (error) {
				console.warn('[LMV] Camera-controls toolbar wiring failed', error);
			}
		}
	}

	// ── Streetwalk walking camera (a MapLibre camera mode) ──────
	// The walking cam drives MapLibre's own camera via the custom-view-matrix
	// patch; the LMV render stays pinned to MapLibre's matrices as usual, so
	// the model follows the walk with no LMV-side camera work at all.
	let walkingCam: WalkingCam | null = null;
	let walkModeActive = false;

	function setWalkMode(enabled: boolean): void {
		if (enabled === walkModeActive) return;
		walkModeActive = enabled;
		if (enabled) {
			setInteractionMode('map'); // walking owns the pointer (mouse-look)
			walkingCam?.enable();
		} else {
			walkingCam?.disable();
		}
		cameraControlsExtension?.setActiveMode?.(enabled ? 'walk' : 'map');
	}

	function isWalkModeActive(): boolean {
		return walkModeActive;
	}

	// Toolbar camera pair: 'walk' engages the streetwalk camera; 'map' returns
	// to the standard MapLibre camera AND ends LMV interaction mode.
	function selectCameraMode(mode: 'map' | 'walk'): void {
		if (mode === 'walk') {
			setWalkMode(true);
		} else {
			setWalkMode(false);
			setInteractionMode('map');
		}
	}

	// ── Pointer forwarding to the LMV canvas ──
	// MapLibre owns the canvas by default. LMV interaction mode re-dispatches
	// mouse events on the map canvas container to the (hidden) LMV canvas —
	// all buttons, moves, clicks; everything except wheel, since the camera
	// stays MapLibre-owned. While forwarding is on, map pan/rotate/double-
	// click-zoom are suspended. Touch is not forwarded (pinch stays with
	// MapLibre; this demo is desktop-focused).
	let lmvModeActive = false;
	let forwardingActive = false;
	const FORWARDED_EVENTS = ['mousedown', 'mousemove', 'mouseup', 'click', 'dblclick'] as const;

	function forwardPointerEvent(event: MouseEvent): void {
		if (!viewer?.canvas) return;
		// mousemove carries button 0 when idle; other types only for left button.
		if (event.type !== 'mousemove' && event.button !== 0) return;

		viewer.canvas.dispatchEvent(
			new MouseEvent(event.type, {
				bubbles: true,
				cancelable: true,
				button: event.button,
				buttons: event.buttons,
				clientX: event.clientX,
				clientY: event.clientY,
				screenX: event.screenX,
				screenY: event.screenY
			})
		);
		map?.triggerRepaint();
	}

	function syncPointerForwarding(): void {
		const shouldForward = lmvModeActive;
		if (shouldForward === forwardingActive || !map) return;
		forwardingActive = shouldForward;

		const eventSource = map.getCanvasContainer();

		if (shouldForward) {
			map.dragPan.disable();
			map.dragRotate.disable();
			map.doubleClickZoom.disable();
			for (const type of FORWARDED_EVENTS) {
				eventSource.addEventListener(type, forwardPointerEvent);
			}
		} else {
			for (const type of FORWARDED_EVENTS) {
				eventSource.removeEventListener(type, forwardPointerEvent);
			}
			map.dragPan.enable();
			map.dragRotate.enable();
			map.doubleClickZoom.enable();
		}
	}

	// LMV interaction mode: route mouse interaction to the model. LMV
	// navigation is locked so left-drag becomes rubber-band selection instead
	// of orbiting a camera the bridge pins every frame anyway.
	function setInteractionMode(mode: LmvInteractionMode): void {
		const enabled = mode === 'lmv';
		if (enabled === lmvModeActive) return;
		lmvModeActive = enabled;
		if (enabled) setWalkMode(false); // model interaction owns the pointer
		viewer?.navigation?.setIsLocked?.(enabled);
		if (map) map.getCanvas().style.cursor = enabled ? 'default' : '';
		syncPointerForwarding();
		onInteractionMode(mode);
	}

	// Measure, section, and explode all need LMV-side picking, so engaging any
	// of them flips the bridge into LMV interaction mode. LMV 7's
	// toolController emits no activation events, so wrap
	// activateTool/deactivateTool; explode is itself a tool in LMV 7.
	function bindInteractionAutoSwitch(): void {
		const toolController = viewer?.toolController;
		if (!toolController || toolController.__interactionAutoSwitchBound) return;
		toolController.__interactionAutoSwitchBound = true;

		const LMV_MODE_TOOLS = new Set(['measure', 'section', 'explode']);
		const original = toolController.activateTool;
		if (typeof original !== 'function') return;
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		toolController.activateTool = function (this: any, ...args: unknown[]) {
			const result = original.apply(this, args);
			if (LMV_MODE_TOOLS.has(args[0] as string)) {
				setInteractionMode('lmv');
			}
			return result;
		};
	}

	function resizeLmvToMapCanvas(): void {
		// Keep LMV sized to MapLibre's *actual* backing store. Past the
		// maxCanvasSize clamp MapLibre lowers its applied pixel ratio; LMV's
		// own resize handling uses raw devicePixelRatio and must be corrected.
		const appliedPixelRatio = mapCanvas.clientWidth
			? mapCanvas.width / mapCanvas.clientWidth
			: 1;
		const renderer = viewer.impl.glrenderer();
		const currentPixelRatio = renderer.getPixelRatio?.() || 1;

		if (appliedPixelRatio > 0 && Math.abs(currentPixelRatio - appliedPixelRatio) > 1e-3) {
			// LMV's own resize would skip setPixelRatio when it matches raw
			// devicePixelRatio, so set it ourselves BEFORE the FBO realloc.
			renderer.setPixelRatio(appliedPixelRatio);
			viewer.impl.resize(mapCanvas.clientWidth, mapCanvas.clientHeight, true);
		}
	}

	function applyMapLibreCameraTransform(combinedMatrix: Float64Array): void {
		const camera = viewer.impl.camera;
		camera.projectionMatrix.elements.set(new Float32Array(combinedMatrix));
		combinedMatrix64 = combinedMatrix;

		camera.position.set(0, 0, 0);
		if (camera.quaternion) camera.quaternion.set(0, 0, 0, 1);
		if (camera.rotation) camera.rotation.set(0, 0, 0);
		camera.scale.set(1, 1, 1);
		camera.matrixWorld.identity();
		camera.matrixWorldInverse.identity();

		// The camera stays in LMV's ortho mode (flipping isPerspective makes
		// impl.tick rebuild the projection and corrupts the shared render).
	}

	return {
		layer,
		loadModel,
		setPlacement,
		getPlacement,
		getViewer: () => viewer,
		setInteractionMode,
		setWalkMode,
		isWalkModeActive
	};
}
