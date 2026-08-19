/**
 * Runtime port of wallabyway/streetwalk-gl's patched-maplibre extension point:
 * `transform.setCustomViewMatrix()`. Stock maplibre-gl has no such API — the
 * streetwalk demo ships a patched build (maplibre-gl v5.22.0). This module
 * applies the same patch at runtime to ONE map instance (v5.24.0), so the app
 * keeps using its stock npm package.
 *
 * What the patch does (isolated by diffing the patched build against stock):
 *  1. TransformHelper gains `_customViewMatrix` (default null) + a setter.
 *  2. MercatorTransform._calcMatrices(): when a custom view matrix is set,
 *     the view half of the projection chain (translate/rotateZ/rotateX) is
 *     replaced by a straight multiply with the custom matrix.
 *  3. Near/far planes are tightened while a custom view is active
 *     (nearZ = height/200, farZ ≤ cameraToCenterDistance × 30) to keep depth
 *     precision reasonable at walking altitude.
 *
 * Everything else (tile loading, fog, custom layers) flows through the same
 * matrices as before, so `defaultProjectionData.mainMatrix` — which the LMV
 * bridge consumes — already includes the injected view.
 *
 * The ported `_calcMatrices` is copied from maplibre-gl 5.24.0's
 * MercatorTransform (dist/maplibre-gl-dev.js) with the customVM branch
 * inserted; the mat4 helpers below are column-major Float64 ports of the
 * gl-matrix ops the function uses.
 */

import type maplibregl from 'maplibre-gl';

/* eslint-disable @typescript-eslint/no-explicit-any */

// ── Minimal column-major mat4 helpers (gl-matrix semantics) ────

function mat4Perspective(out: Float64Array, fovy: number, aspect: number, near: number, far: number): void {
	const f = 1.0 / Math.tan(fovy / 2);
	out.fill(0);
	out[0] = f / aspect;
	out[5] = f;
	out[11] = -1;
	if (far != null && far !== Infinity) {
		const nf = 1 / (near - far);
		out[10] = (far + near) * nf;
		out[14] = 2 * far * near * nf;
	} else {
		out[10] = -1;
		out[14] = -2 * near;
	}
}

function mat4Clone(a: ArrayLike<number>): Float64Array {
	return new Float64Array(a);
}

function mat4Scale(out: Float64Array, a: ArrayLike<number>, v: [number, number, number]): Float64Array {
	const [x, y, z] = v;
	// gl-matrix scale: column 0 × x, column 1 × y, column 2 × z, column 3 kept.
	for (let r = 0; r < 4; r++) {
		out[r] = a[r] * x;
		out[4 + r] = a[4 + r] * y;
		out[8 + r] = a[8 + r] * z;
		out[12 + r] = a[12 + r];
	}
	return out;
}

function mat4Translate(out: Float64Array, a: ArrayLike<number>, v: [number, number, number]): Float64Array {
	const [x, y, z] = v;
	if (out !== (a as unknown)) {
		for (let i = 0; i < 12; i++) out[i] = a[i];
	}
	out[12] = a[0] * x + a[4] * y + a[8] * z + a[12];
	out[13] = a[1] * x + a[5] * y + a[9] * z + a[13];
	out[14] = a[2] * x + a[6] * y + a[10] * z + a[14];
	out[15] = a[3] * x + a[7] * y + a[11] * z + a[15];
	return out;
}

function mat4RotateX(out: Float64Array, a: ArrayLike<number>, rad: number): Float64Array {
	const s = Math.sin(rad);
	const c = Math.cos(rad);
	const a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
	const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
	if (out !== (a as unknown)) {
		out[0] = a[0]; out[1] = a[1]; out[2] = a[2]; out[3] = a[3];
		out[12] = a[12]; out[13] = a[13]; out[14] = a[14]; out[15] = a[15];
	}
	out[4] = a10 * c + a20 * s;
	out[5] = a11 * c + a21 * s;
	out[6] = a12 * c + a22 * s;
	out[7] = a13 * c + a23 * s;
	out[8] = a20 * c - a10 * s;
	out[9] = a21 * c - a11 * s;
	out[10] = a22 * c - a12 * s;
	out[11] = a23 * c - a13 * s;
	return out;
}

function mat4RotateZ(out: Float64Array, a: ArrayLike<number>, rad: number): Float64Array {
	const s = Math.sin(rad);
	const c = Math.cos(rad);
	const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
	const a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
	if (out !== (a as unknown)) {
		out[8] = a[8]; out[9] = a[9]; out[10] = a[10]; out[11] = a[11];
		out[12] = a[12]; out[13] = a[13]; out[14] = a[14]; out[15] = a[15];
	}
	out[0] = a00 * c + a10 * s;
	out[1] = a01 * c + a11 * s;
	out[2] = a02 * c + a12 * s;
	out[3] = a03 * c + a13 * s;
	out[4] = a10 * c - a00 * s;
	out[5] = a11 * c - a01 * s;
	out[6] = a12 * c - a02 * s;
	out[7] = a13 * c - a03 * s;
	return out;
}

function mat4Multiply(out: Float64Array, a: ArrayLike<number>, b: ArrayLike<number>): Float64Array {
	const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
	const a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
	const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
	const a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];
	for (let c = 0; c < 4; c++) {
		const b0 = b[c * 4], b1 = b[c * 4 + 1], b2 = b[c * 4 + 2], b3 = b[c * 4 + 3];
		out[c * 4] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
		out[c * 4 + 1] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
		out[c * 4 + 2] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
		out[c * 4 + 3] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;
	}
	return out;
}

function mat4Invert(out: Float64Array, a: ArrayLike<number>): Float64Array | null {
	const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
	const a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
	const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
	const a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];

	const b00 = a00 * a11 - a01 * a10;
	const b01 = a00 * a12 - a02 * a10;
	const b02 = a00 * a13 - a03 * a10;
	const b03 = a01 * a12 - a02 * a11;
	const b04 = a01 * a13 - a03 * a11;
	const b05 = a02 * a13 - a03 * a12;
	const b06 = a20 * a31 - a21 * a30;
	const b07 = a20 * a32 - a22 * a30;
	const b08 = a20 * a33 - a23 * a30;
	const b09 = a21 * a32 - a22 * a31;
	const b10 = a21 * a33 - a23 * a31;
	const b11 = a22 * a33 - a23 * a32;

	let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
	if (!det) return null;
	det = 1.0 / det;

	out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det;
	out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
	out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det;
	out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
	out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det;
	out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
	out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det;
	out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
	out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det;
	out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
	out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det;
	out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
	out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det;
	out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
	out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det;
	out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
	return out;
}

function mat4TransformVec4(out: number[], a: ArrayLike<number>, m: ArrayLike<number>): number[] {
	const x = a[0];
	const y = a[1];
	const z = a[2];
	const w = a[3];
	out[0] = m[0] * x + m[4] * y + m[8] * z + m[12] * w;
	out[1] = m[1] * x + m[5] * y + m[9] * z + m[13] * w;
	out[2] = m[2] * x + m[6] * y + m[10] * z + m[14] * w;
	out[3] = m[3] * x + m[7] * y + m[11] * z + m[15] * w;
	return out;
}

// ── maplibre-internal constants/helpers (copied from the bundle) ──

const MAX_MERCATOR_HORIZON_ANGLE = 89.25;
const MAX_VALID_LATITUDE = 85.051129;
const EARTH_CIRCUMFERENCE = 40075016.68557849;

function degreesToRadians(deg: number): number {
	return (deg * Math.PI) / 180;
}

function clamp(v: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, v));
}

function mercatorXfromLng(lng: number): number {
	return (180 + lng) / 360;
}

function mercatorYfromLat(lat: number): number {
	return (180 - (180 / Math.PI) * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))) / 360;
}

function mercatorZfromAltitude(altitude: number, lat: number): number {
	return altitude / (EARTH_CIRCUMFERENCE * Math.cos(degreesToRadians(lat)));
}

function projectToWorldCoordinates(worldSize: number, lnglat: { lng: number; lat: number }): { x: number; y: number } {
	const lat = clamp(lnglat.lat, -MAX_VALID_LATITUDE, MAX_VALID_LATITUDE);
	return { x: mercatorXfromLng(lnglat.lng) * worldSize, y: mercatorYfromLat(lat) * worldSize };
}

function getMercatorHorizon(tr: any): number {
	return (
		tr.cameraToCenterDistance *
		Math.min(
			Math.tan(degreesToRadians(90 - tr.pitch)) * 0.85,
			Math.tan(degreesToRadians(MAX_MERCATOR_HORIZON_ANGLE - tr.pitch))
		)
	);
}

/**
 * Ported MercatorTransform._calcMatrices (maplibre-gl 5.24.0) with the
 * streetwalk customViewMatrix branch inserted. `this` is the map's transform
 * instance; all `this.*` reads resolve to the live internals.
 */
function patchedCalcMatrices(this: any): void {
	if (!this._helper._height) return;
	const offset = this.centerOffset;
	const point = projectToWorldCoordinates(this.worldSize, this.center);
	const x = point.x;
	const y = point.y;
	this._helper._pixelPerMeter = mercatorZfromAltitude(1, this.center.lat) * this.worldSize;
	// Calculate the camera to sea-level distance in pixel in respect of terrain
	const limitedPitchRadians = degreesToRadians(Math.min(this.pitch, MAX_MERCATOR_HORIZON_ANGLE));
	const cameraToSeaLevelDistance = Math.max(
		this._helper.cameraToCenterDistance / 2,
		this._helper.cameraToCenterDistance +
			(this._helper._elevation * this._helper._pixelPerMeter) / Math.cos(limitedPitchRadians)
	);
	this._calculateNearFarZIfNeeded(cameraToSeaLevelDistance, limitedPitchRadians, offset);

	// ── streetwalk patch: tighten near/far while a custom view is active ──
	if (this._helper._customViewMatrix !== null && this._helper.autoCalculateNearFarZ) {
		const maxFarZ = this._helper.cameraToCenterDistance * 30;
		this._helper._farZ = Math.min(this._helper._farZ, maxFarZ);
		this._helper._nearZ = this._helper._height / 200;
	}

	// matrix for conversion from location to clip space(-1 .. 1)
	const m = new Float64Array(16);
	mat4Perspective(m, this.fovInRadians, this._helper._width / this._helper._height, this._helper._nearZ, this._helper._farZ);
	this._invProjMatrix = new Float64Array(16);
	mat4Invert(this._invProjMatrix, m);
	// Apply center of perspective offset
	m[8] = (-offset.x * 2) / this._helper._width;
	m[9] = (offset.y * 2) / this._helper._height;
	this._projectionMatrix = mat4Clone(m);
	mat4Scale(m, m, [1, -1, 1]);

	// ── streetwalk patch: plugin-provided view matrix replaces the orbit view ──
	const customVM = this._helper._customViewMatrix;
	if (customVM) {
		mat4Multiply(m, m, customVM);
	} else {
		mat4Translate(m, m, [0, 0, -this._helper.cameraToCenterDistance]);
		mat4RotateZ(m, m, -this.rollInRadians);
		mat4RotateX(m, m, this.pitchInRadians);
		mat4RotateZ(m, m, -this.bearingInRadians);
		mat4Translate(m, m, [-x, -y, 0]);
	}

	// The mercatorMatrix can be used to transform points from mercator coordinates
	// ([0, 0] nw, [1, 1] se) to clip space.
	this._mercatorMatrix = mat4Scale(new Float64Array(16), m, [this.worldSize, this.worldSize, this.worldSize]);
	// scale vertically to meters per pixel (inverse of ground resolution):
	mat4Scale(m, m, [1, 1, this._helper._pixelPerMeter]);
	// matrix for conversion from world space to screen coordinates in 2D
	this._pixelMatrix = mat4Multiply(new Float64Array(16), this.clipSpaceToPixelsMatrix, m);
	// matrix for conversion from world space to clip space (-1 .. 1)
	mat4Translate(m, m, [0, 0, -this.elevation]); // elevate camera over terrain
	this._viewProjMatrix = m;
	this._invViewProjMatrix = mat4Invert(new Float64Array(16), m) ?? undefined;
	if (this._invViewProjMatrix) {
		const cameraPos = mat4TransformVec4([0, 0, 0, 0], [0, 0, -1, 1], this._invViewProjMatrix);
		this._cameraPosition = [cameraPos[0] / cameraPos[3], cameraPos[1] / cameraPos[3], cameraPos[2] / cameraPos[3]];
	}

	// fog matrix: unchanged from stock — always uses the orbit view (matches
	// the patched streetwalk build, which also leaves the fog path alone).
	this._fogMatrix = new Float64Array(16);
	mat4Perspective(this._fogMatrix, this.fovInRadians, this.width / this.height, cameraToSeaLevelDistance, this._helper._farZ);
	this._fogMatrix[8] = (-offset.x * 2) / this.width;
	this._fogMatrix[9] = (offset.y * 2) / this.height;
	mat4Scale(this._fogMatrix, this._fogMatrix, [1, -1, 1]);
	mat4Translate(this._fogMatrix, this._fogMatrix, [0, 0, -this.cameraToCenterDistance]);
	mat4RotateZ(this._fogMatrix, this._fogMatrix, -this.rollInRadians);
	mat4RotateX(this._fogMatrix, this._fogMatrix, this.pitchInRadians);
	mat4RotateZ(this._fogMatrix, this._fogMatrix, -this.bearingInRadians);
	mat4Translate(this._fogMatrix, this._fogMatrix, [-x, -y, 0]);
	mat4Scale(this._fogMatrix, this._fogMatrix, [1, 1, this._helper._pixelPerMeter]);
	mat4Translate(this._fogMatrix, this._fogMatrix, [0, 0, -this.elevation]); // elevate camera over terrain
	// matrix for conversion from world space to screen coordinates in 3D
	this._pixelMatrix3D = mat4Multiply(new Float64Array(16), this.clipSpaceToPixelsMatrix, m);
	// Pixel-grid-aligned matrix for raster tiles (unchanged from stock).
	const xShift = (this._helper._width % 2) / 2;
	const yShift = (this._helper._height % 2) / 2;
	const angleCos = Math.cos(this.bearingInRadians);
	const angleSin = Math.sin(-this.bearingInRadians);
	const dx = x - Math.round(x) + angleCos * xShift + angleSin * yShift;
	const dy = y - Math.round(y) + angleCos * yShift + angleSin * xShift;
	const alignedM = new Float64Array(m);
	mat4Translate(alignedM, alignedM, [dx > 0.5 ? dx - 1 : dx, dy > 0.5 ? dy - 1 : dy, 0]);
	this._alignedProjMatrix = alignedM;
	// inverse matrix for conversion from screen coordinates to location
	const inv = mat4Invert(new Float64Array(16), this._pixelMatrix);
	if (!inv) throw new Error('failed to invert matrix');
	this._pixelMatrixInverse = inv;
	this._clearMatrixCaches();
}

/**
 * Install the custom-view-matrix extension point on one map instance.
 * Idempotent; re-install after any migrateProjection (style change can swap
 * the transform instance, dropping instance-level patches).
 */
export function ensureCustomViewMatrixPatch(map: maplibregl.Map): void {
	const tr = map.transform as any;
	if (!tr?._helper || tr.__customViewMatrixPatched) return;
	tr.__customViewMatrixPatched = true;

	const helper = tr._helper;
	if (helper._customViewMatrix === undefined) helper._customViewMatrix = null;

	// Public entry point used by the walking camera: set a Float64Array(16)
	// view matrix (world-pixels → view space) or null to return to the orbit
	// camera, then nudge the transform so the matrices recompute.
	tr.setCustomViewMatrix = (m: Float64Array | null) => {
		helper._customViewMatrix = m;
		tr._calcMatrices();
	};

	tr._calcMatrices = patchedCalcMatrices;
}
