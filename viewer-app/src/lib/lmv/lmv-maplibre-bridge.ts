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
	loadLmvModel
} from './lmv-loader';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyViewer = any;

export type ModelPlacement = ReturnType<typeof createMercatorModelPlacement>;

export type LmvBridge = {
	layer: maplibregl.CustomLayerInterface;
	loadModel: (urn: string) => Promise<void>;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	getViewer: () => any;
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
	onStatus = () => {}
}: {
	container: HTMLElement;
	modelPlacement: ModelPlacement;
	onStatus?: (message: string) => void;
}): LmvBridge {
	let map: maplibregl.Map | null = null;
	let mapCanvas: HTMLCanvasElement;
	let viewer: AnyViewer = null;
	let ready = false;
	let viewerReady: Promise<void> | null = null; // set in onAdd; awaited by loadModel
	let combinedMatrix64: Float64Array | null = null;

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
			const combinedMatrix = computeCombinedModelProjectionMatrix({
				map: map as maplibregl.Map,
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				mainMatrix: (args as any).defaultProjectionData.mainMatrix,
				placement: modelPlacement
			});

			applyMapLibreCameraTransform(combinedMatrix);

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
	}

	function configureViewerForMapLibre(): void {
		bindLmvRepaintEvents();
		patchLmvCanvasBounds();
		patchLmvViewportToRay();
		bindMapPointerForwarding();
		viewer.impl.setRightBtnSelection(true);

		viewer.setGhosting(false);
		viewer.setGroundShadow(false);
		viewer.setLightPreset(1);
		viewer.setTheme('light-theme');
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

	async function loadModel(urn: string): Promise<void> {
		await viewerReady;

		ready = false;
		onStatus('Loading model...');
		await loadLmvModel(viewer, urn);
		await ensureVisualClustersExtension();
		await ensureTransformExtension();
		ready = true;

		onStatus('Model loaded');
		map?.triggerRepaint();
	}

	// Loaded once, after the first model is in. Adds the "Visual Clusters"
	// toggle to the LMV toolbar; activation stays with the user.
	let visualClustersRequested = false;
	async function ensureVisualClustersExtension(): Promise<void> {
		if (visualClustersRequested) return;
		visualClustersRequested = true;
		try {
			const extension = await viewer.loadExtension('Autodesk.VisualClusters');
			hookClusterAnimation(extension);
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

	// Loaded once, after the first model is in. Adds the "Transform Tools"
	// (translate/rotate gizmos) to the LMV toolbar; activation stays with
	// the user. Failures are logged, never fatal to model load.
	let transformRequested = false;
	async function ensureTransformExtension(): Promise<void> {
		if (transformRequested) return;
		transformRequested = true;
		try {
			const { registerTransformExtension, TRANSFORM_EXTENSION_ID } = await import(
				'./transform-extension/transform-extension'
			);
			registerTransformExtension();
			const extension = await viewer.loadExtension(TRANSFORM_EXTENSION_ID);
			bindTransformToolForwarding(extension);
		} catch (error) {
			console.warn('[LMV] Transform extension failed to load', error);
		}
	}

	// ── Left-button pointer forwarding while a transform tool is active ──
	// MapLibre owns the left button (dragPan); the translate/rotate gizmos
	// need left-button drags on viewer.canvas. While one of these tools is
	// active, map panning is suspended and left-button mouse events on the
	// map canvas container are re-dispatched to the (hidden) LMV canvas
	// with coordinates preserved, each followed by a repaint.
	let transformForwardingActive = false;
	const TRANSFORM_FORWARDED_EVENTS = ['mousedown', 'mousemove', 'mouseup', 'click'] as const;

	function forwardTransformPointerEvent(event: MouseEvent): void {
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

	function setTransformForwarding(enabled: boolean): void {
		if (enabled === transformForwardingActive || !map) return;
		transformForwardingActive = enabled;

		const eventSource = map.getCanvasContainer();

		if (enabled) {
			map.dragPan.disable();
			map.doubleClickZoom.disable();
			for (const type of TRANSFORM_FORWARDED_EVENTS) {
				eventSource.addEventListener(type, forwardTransformPointerEvent);
			}
		} else {
			for (const type of TRANSFORM_FORWARDED_EVENTS) {
				eventSource.removeEventListener(type, forwardTransformPointerEvent);
			}
			map.dragPan.enable();
			map.doubleClickZoom.enable();
		}
	}

	// LMV 7's toolController emits no activation events, so wrap
	// activateTool/deactivateTool and read the tools' `active` flags after
	// each call (activation is synchronous in LMV; the microtask is cheap
	// insurance in case that ever changes).
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	function bindTransformToolForwarding(extension: any): void {
		const toolController = viewer?.toolController;
		if (!toolController || toolController.__transformForwardingBound) return;
		toolController.__transformForwardingBound = true;

		const update = () =>
			setTransformForwarding(
				!!(extension?.translateTool?.active || extension?.rotateTool?.active)
			);

		for (const fn of ['activateTool', 'deactivateTool'] as const) {
			const original = toolController[fn];
			if (typeof original !== 'function') continue;
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			toolController[fn] = function (this: any, ...args: unknown[]) {
				const result = original.apply(this, args);
				update();
				void Promise.resolve().then(update);
				return result;
			};
		}
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
	}

	return { layer, loadModel, getViewer: () => viewer };
}
