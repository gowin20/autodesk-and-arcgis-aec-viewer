/**
 * First-person walking camera for MapLibre GL JS — TypeScript port of
 * wallabyway/streetwalk-gl (src/walking-cam.js), adapted for this app:
 *  - works against the runtime custom-view-matrix patch (custom-view-matrix-patch.ts)
 *    instead of a patched maplibre build; re-installs the patch if a style
 *    swap replaced the transform instance;
 *  - adds an `onDisabled` callback so toolbar state can sync when Esc exits
 *    walk mode via pointer lock;
 *  - ignores WASD key events targeted at form fields.
 *
 * The camera position/yaw/pitch are kept in geographic state; each frame the
 * view matrix is injected into MapLibre's transform, and jumpTo() keeps the
 * orbit parameters (center/zoom/pitch) consistent so tile loading, fog, and
 * the far plane behave normally.
 */

import type maplibregl from 'maplibre-gl';
import { ensureCustomViewMatrixPatch } from './custom-view-matrix-patch';

/* eslint-disable @typescript-eslint/no-explicit-any */

const DEFAULTS = {
	speed: 30, // meters per second
	runMultiplier: 4.5, // shift key speed multiplier
	sensitivity: 0.15, // degrees per pixel of mouse movement
	lookDamping: 0.12, // rotation smoothing (lerp factor per frame)
	moveDamping: 0.08, // velocity smoothing (lerp factor per frame)
	maxPitch: 120, // max look angle (90=horizon, 120=30° above)
	minPitch: 10, // min look angle
	minAltitude: 1.5, // minimum altitude (eye level)
	maxZoom: 19.5 // cap zoom for tile loading
};

export type WalkingCamOptions = Partial<typeof DEFAULTS> & {
	/** Fires when walk mode ends from the cam side (Esc / pointer-lock exit). */
	onDisabled?: () => void;
};

const DEG = Math.PI / 180;
const METERS_PER_DEG = 111320;

// Chrome returns a Promise from requestPointerLock (rejects without a user
// gesture, e.g. auto-enable paths); older engines return undefined.
function requestPointerLockSafe(canvas: HTMLCanvasElement): void {
	const result = canvas.requestPointerLock() as unknown;
	(result as Promise<void> | undefined)?.catch?.(() => {});
}

export class WalkingCam {
	private _map: maplibregl.Map;
	private _options: typeof DEFAULTS;
	private _onDisabled?: () => void;
	private _active = false;

	// Camera 3D state
	private _lng = 0;
	private _lat = 0;
	private _alt = 50;
	private _bearing = 0; // yaw in degrees
	private _pitch = 75; // tilt in degrees (0=down, 90=horizontal, >90=above horizon)
	private _targetBearing = 0;
	private _targetPitch = 75;

	// Velocity (meters/sec: east, north, up)
	private _velE = 0;
	private _velN = 0;
	private _velU = 0;

	private _keys = { forward: false, back: false, left: false, right: false, up: false, down: false, sprint: false };
	private _savedMaxPitch: number | null = null;
	private _savedHandlers: string[] = [];

	private _rafId: number | null = null;
	private _lastTime = 0;
	private _pointerLocked = false;

	constructor(map: maplibregl.Map, options: WalkingCamOptions = {}) {
		this._map = map;
		const { onDisabled, ...rest } = options;
		this._options = { ...DEFAULTS, ...rest };
		this._onDisabled = onDisabled;
	}

	get active(): boolean {
		return this._active;
	}

	enable(): void {
		if (this._active) return;
		this._active = true;
		const map = this._map;

		// A style swap can replace the transform instance and drop the patch.
		ensureCustomViewMatrixPatch(map);

		this._bearing = map.getBearing();
		this._targetBearing = this._bearing;
		this._pitch = Math.min(map.getPitch(), 85);
		this._targetPitch = this._pitch;

		// Match current camera position so there's no jump on enter
		const tr = map.transform as any;
		const camLngLat = tr.getCameraLngLat();
		this._lng = camLngLat.lng;
		this._lat = camLngLat.lat;
		this._alt = Math.max(tr.getCameraAltitude(), this._options.minAltitude);

		this._savedMaxPitch = map.getMaxPitch();
		map.setMaxPitch(85); // for tile loading pitch only

		const handlerNames = [
			'dragPan', 'dragRotate', 'keyboard', 'scrollZoom',
			'doubleClickZoom', 'touchZoomRotate', 'touchPitch', 'boxZoom'
		] as const;
		this._savedHandlers = [];
		for (const name of handlerNames) {
			const h = (map as any)[name];
			if (h?.isEnabled()) {
				this._savedHandlers.push(name);
				h.disable();
			}
		}

		document.addEventListener('keydown', this._handleKeyDown);
		document.addEventListener('keyup', this._handleKeyUp);
		document.addEventListener('mousemove', this._handleMouseMove);
		document.addEventListener('pointerlockchange', this._handlePointerLockChange);

		const canvas = map.getCanvas();
		canvas.addEventListener('click', this._handleCanvasClick);
		requestPointerLockSafe(canvas);

		this._applyCamera();
		this._lastTime = performance.now();
		this._rafId = requestAnimationFrame((t) => this._tick(t));
	}

	disable(): void {
		if (!this._active) return;
		this._active = false;

		if (this._rafId) {
			cancelAnimationFrame(this._rafId);
			this._rafId = null;
		}

		document.removeEventListener('keydown', this._handleKeyDown);
		document.removeEventListener('keyup', this._handleKeyUp);
		document.removeEventListener('mousemove', this._handleMouseMove);
		document.removeEventListener('pointerlockchange', this._handlePointerLockChange);

		const canvas = this._map.getCanvas();
		canvas.removeEventListener('click', this._handleCanvasClick);
		if (document.pointerLockElement === canvas) document.exitPointerLock();
		this._pointerLocked = false;

		// Clear custom view matrix first
		const tr = this._map.transform as any;
		tr.setCustomViewMatrix?.(null);

		// Restore orbit view at walking cam's last position.
		// In orbit model, "center" is the ground point being looked at,
		// offset from camera position by alt*tan(pitch) in the bearing direction.
		const exitPitch = Math.min(this._pitch, this._savedMaxPitch ?? 60, 85);
		const exitPitchRad = exitPitch * DEG;
		const bearingRad = this._bearing * DEG;
		const cosLat = Math.cos(this._lat * DEG);
		const horizDist = this._alt * Math.tan(exitPitchRad);
		const centerLng = this._lng + (horizDist * Math.sin(bearingRad)) / (METERS_PER_DEG * cosLat);
		const centerLat = Math.max(
			-89.9,
			Math.min(89.9, this._lat + (horizDist * Math.cos(bearingRad)) / METERS_PER_DEG)
		);

		// Zoom from altitude
		const height = tr.height;
		const fov = tr.fov * DEG;
		const pixelDist = height / 2 / Math.tan(fov / 2);
		const circumference = 40075016.686;
		const mercZPerMeter = 1 / (circumference * cosLat);
		const meterDist = this._alt / Math.cos(exitPitchRad);
		const worldSize = pixelDist / meterDist / mercZPerMeter;
		const zoom = Math.log2(worldSize / 512);

		this._map.jumpTo({
			center: [centerLng, centerLat],
			zoom,
			bearing: this._bearing,
			pitch: exitPitch
		});

		if (this._savedMaxPitch !== null) this._map.setMaxPitch(this._savedMaxPitch);

		for (const name of this._savedHandlers) {
			const h = (this._map as any)[name];
			h?.enable();
		}

		this._keys = { forward: false, back: false, left: false, right: false, up: false, down: false, sprint: false };
		this._velE = 0;
		this._velN = 0;
		this._velU = 0;
	}

	toggle(): void {
		if (this._active) this.disable();
		else this.enable();
	}

	// --- Private ---

	private _applyCamera(): void {
		const map = this._map;
		const tr = map.transform as any;
		const cosLat = Math.cos(this._lat * DEG);
		const height = tr.height;
		const fov = tr.fov * DEG;
		const pixelDist = height / 2 / Math.tan(fov / 2);
		const circumference = 40075016.686;
		const mercZPerMeter = 1 / (circumference * cosLat);

		// Zoom: match the orbit camera's formula (altitude + pitch) so tiles,
		// POIs, and far plane are identical to normal mode at the same view.
		const effectivePitch = Math.min(this._pitch, 85) * DEG;
		const styleWorldSize = ((pixelDist * Math.cos(effectivePitch)) / this._alt) / mercZPerMeter;
		const zoom = Math.max(0, Math.min(Math.log2(styleWorldSize / 512) || 0, this._options.maxZoom));

		// Derive world-pixel coords from the zoom we're about to set
		const worldSize = 512 * Math.pow(2, zoom);
		const pixelPerMeter = worldSize * mercZPerMeter;

		// Camera position in world pixels
		const mercX = (this._lng + 180) / 360;
		const latRad = this._lat * DEG;
		const mercY = (1 - Math.log(Math.tan(Math.PI / 4 + latRad / 2)) / Math.PI) / 2;
		const camX = mercX * worldSize;
		const camY = mercY * worldSize;
		const camZ = this._alt * pixelPerMeter; // elevation=0 for now

		// Build view matrix: V = Rx(pitch) * Rz(-yaw) * T(-cam)
		const yaw = this._bearing * DEG;
		const pitch = this._pitch * DEG;
		const cp = Math.cos(pitch);
		const sp = Math.sin(pitch);
		const cy = Math.cos(yaw);
		const sy = Math.sin(yaw);

		// Column-major 4x4
		const vm = new Float64Array(16);
		vm[0] = cy;         vm[4] = sy;         vm[8] = 0;    vm[12] = -cy * camX - sy * camY;
		vm[1] = -cp * sy;   vm[5] = cp * cy;    vm[9] = -sp;  vm[13] = cp * sy * camX - cp * cy * camY + sp * camZ;
		vm[2] = -sp * sy;   vm[6] = sp * cy;    vm[10] = cp;  vm[14] = sp * sy * camX - sp * cy * camY - cp * camZ;
		vm[3] = 0;          vm[7] = 0;          vm[11] = 0;   vm[15] = 1;

		tr.setCustomViewMatrix(vm);

		// jumpTo must match the orbit camera's parameters exactly so that
		// internal calculations (near/far, horizon, tile coverage) are identical
		// to normal mode. In orbit mode, "center" is the ground point being
		// looked at — offset from camera by alt*tan(pitch) in the bearing direction.
		// Cap at 80° to keep farZ bounded (85° pushes horizon too far at low alt).
		const orbitPitch = Math.min(this._pitch, 80);
		const horizDist = this._alt * Math.tan(orbitPitch * DEG);
		const bearingRad = this._bearing * DEG;
		const centerLng = this._lng + (horizDist * Math.sin(bearingRad)) / (METERS_PER_DEG * cosLat);
		const centerLat = Math.max(
			-89.9,
			Math.min(89.9, this._lat + (horizDist * Math.cos(bearingRad)) / METERS_PER_DEG)
		);

		map.jumpTo({
			center: [centerLng, centerLat],
			zoom,
			bearing: this._bearing,
			pitch: orbitPitch
		});
	}

	private _tick(now: number): void {
		if (!this._active) return;
		const dt = Math.min((now - this._lastTime) / 1000, 0.1);
		this._lastTime = now;
		const opts = this._options;

		// Smooth look
		this._bearing += (this._targetBearing - this._bearing) * opts.lookDamping;
		this._pitch += (this._targetPitch - this._pitch) * opts.lookDamping;

		// Target velocity from WASD -- scale speed with altitude for consistent feel
		const altScale = Math.max(1, 1 + (this._alt - 50) / 200);
		const speed = opts.speed * altScale * (this._keys.sprint ? opts.runMultiplier : 1);
		let tE = 0;
		let tN = 0;
		let tU = 0;
		const bRad = this._bearing * DEG;
		const fE = Math.sin(bRad);
		const fN = Math.cos(bRad);
		const rE = fN;
		const rN = -fE;

		if (this._keys.forward) { tE += fE * speed; tN += fN * speed; }
		if (this._keys.back) { tE -= fE * speed; tN -= fN * speed; }
		if (this._keys.right) { tE += rE * speed; tN += rN * speed; }
		if (this._keys.left) { tE -= rE * speed; tN -= rN * speed; }
		if (this._keys.up) { tU += speed; }
		if (this._keys.down) { tU -= speed; }

		// Smooth velocity
		const d = opts.moveDamping;
		this._velE += (tE - this._velE) * d;
		this._velN += (tN - this._velN) * d;
		this._velU += (tU - this._velU) * d;

		// Integrate camera position
		const cosLat = Math.cos(this._lat * DEG);
		this._lng += (this._velE * dt) / (METERS_PER_DEG * Math.max(cosLat, 0.01));
		this._lat = Math.max(-85, Math.min(85, this._lat + (this._velN * dt) / METERS_PER_DEG));
		this._alt += this._velU * dt;
		this._alt = Math.max(opts.minAltitude, this._alt);

		this._applyCamera();

		this._rafId = requestAnimationFrame((t) => this._tick(t));
	}

	private _handleMouseMove = (e: MouseEvent): void => {
		if (!this._pointerLocked) return;
		const s = this._options.sensitivity;
		this._targetBearing += e.movementX * s;
		this._targetPitch = Math.max(
			this._options.minPitch,
			Math.min(this._options.maxPitch, this._targetPitch - e.movementY * s)
		);
	};

	private _handleKeyDown = (e: KeyboardEvent): void => {
		this._setKey(e, true);
	};

	private _handleKeyUp = (e: KeyboardEvent): void => {
		this._setKey(e, false);
	};

	private _setKey(e: KeyboardEvent, pressed: boolean): void {
		// Don't steal keystrokes from form fields (site picker, search, ...).
		const tag = (e.target as HTMLElement | null)?.tagName;
		if (tag && /^(INPUT|TEXTAREA|SELECT)$/.test(tag)) return;
		switch (e.code) {
			case 'KeyW': this._keys.forward = pressed; break;
			case 'KeyS': this._keys.back = pressed; break;
			case 'KeyA': this._keys.left = pressed; break;
			case 'KeyD': this._keys.right = pressed; break;
			case 'KeyQ': this._keys.up = pressed; break;
			case 'KeyE': this._keys.down = pressed; break;
			case 'ShiftLeft':
			case 'ShiftRight': this._keys.sprint = pressed; break;
		}
	}

	private _handleCanvasClick = (): void => {
		if (!this._active) return;
		requestPointerLockSafe(this._map.getCanvas());
	};

	private _handlePointerLockChange = (): void => {
		const canvas = this._map.getCanvas();
		this._pointerLocked = document.pointerLockElement === canvas;
		// ESC exits pointer lock -> disable walking mode
		if (!this._pointerLocked && this._active) {
			this.disable();
			this._onDisabled?.();
		}
	};
}
