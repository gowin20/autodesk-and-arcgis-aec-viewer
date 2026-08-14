/**
 * Viewing.Tool.Translate — TypeScript port of Philippe Leefsma's 2016
 * Forge translate tool (library-javascript-viewer-extensions).
 *
 * Depends on THREE.TransformControls installed by ./transform-gizmos.
 *
 * Integration changes vs the original (MapLibre bridge):
 *  - getHitPoint() uses impl.hitTest with canvas-relative coordinates from
 *    the bridge-patched impl.getCanvasBoundingClientRect() (the original
 *    went through navigation.getScreenViewport() + viewer.utilities, which
 *    is meaningless while the LMV canvas is display:none).
 *  - The TransformControls gets a `getRect` so its screen-size math also
 *    uses the visible MapLibre canvas rect.
 */

import { EventEmitter } from './event-emitter';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyViewer = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySelection = any;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const THREE = (): any => (window as any).THREE;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Autodesk = (): any => (window as any).Autodesk;

export class TranslateTool extends EventEmitter {
	active = false;
	fullTransform = false;

	private _viewer: AnyViewer;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	private _hitPoint: any = null;
	private _isDragging = false;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	private _transformMesh: any = null;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	private _transformControlTx: any = null;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	private _selectedFragProxyMap: Record<string, any> = {};
	private _selection: AnySelection = null;

	constructor(viewer: AnyViewer) {
		super();
		this._viewer = viewer;

		this.onTxChange = this.onTxChange.bind(this);
		this.onAggregateSelectionChanged = this.onAggregateSelectionChanged.bind(this);
		this.onCameraChanged = this.onCameraChanged.bind(this);
	}

	getNames(): string[] {
		return ['Viewing.Transform.Tool'];
	}

	getName(): string {
		return 'Viewing.Transform.Tool';
	}

	///////////////////////////////////////////////////////////////////////////
	// Creates a dummy mesh to attach control to
	//
	///////////////////////////////////////////////////////////////////////////
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	private createTransformMesh(): any {
		const T = THREE();

		const material = new T.MeshPhongMaterial({ color: 0xff0000 });

		this._viewer.impl.matman().addMaterial('transform-tool-material', material, true);

		const sphere = new T.Mesh(new T.SphereGeometry(0.0001, 5), material);

		sphere.position.set(0, 0, 0);

		return sphere;
	}

	///////////////////////////////////////////////////////////////////////////
	// on translation change
	//
	///////////////////////////////////////////////////////////////////////////
	private onTxChange(): void {
		const T = THREE();

		if (this._isDragging && this._transformControlTx.visible) {
			const translation = new T.Vector3(
				this._transformMesh.position.x - this._selection.model.offset.x,
				this._transformMesh.position.y - this._selection.model.offset.y,
				this._transformMesh.position.z - this._selection.model.offset.z
			);

			for (const fragId in this._selectedFragProxyMap) {
				const fragProxy = this._selectedFragProxyMap[fragId];

				const position = new T.Vector3(
					this._transformMesh.position.x - fragProxy.offset.x,
					this._transformMesh.position.y - fragProxy.offset.y,
					this._transformMesh.position.z - fragProxy.offset.z
				);

				fragProxy.position = position;

				fragProxy.updateAnimTransform();
			}

			this.emit('transform.translate', {
				model: this._selection.model,
				translation: translation
			});
		}

		this._viewer.impl.sceneUpdated(true);
	}

	///////////////////////////////////////////////////////////////////////////
	// on camera changed
	//
	///////////////////////////////////////////////////////////////////////////
	private onCameraChanged(): void {
		if (this._transformControlTx) {
			this._transformControlTx.update();
		}
	}

	///////////////////////////////////////////////////////////////////////////
	// item selected callback
	//
	///////////////////////////////////////////////////////////////////////////
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	private onAggregateSelectionChanged(event: any): void {
		if (event.selections && event.selections.length) {
			this._selection = event.selections[0];

			if (this.fullTransform) {
				this._selection.fragIdsArray = [];

				const fragCount = this._selection.model.getFragmentList().fragments.fragId2dbId.length;

				for (let fragId = 0; fragId < fragCount; ++fragId) {
					this._selection.fragIdsArray.push(fragId);
				}

				this._selection.dbIdArray = [];

				const instanceTree = this._selection.model.getData().instanceTree;

				const rootId = instanceTree.getRootId();

				this._selection.dbIdArray.push(rootId);
			}

			this.emit('transform.modelSelected', this._selection);

			this.initializeSelection(this._hitPoint);
		} else {
			this.clearSelection();
		}
	}

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	private initializeSelection(hitPoint: any): void {
		if (!hitPoint) {
			// The selection happened without a hit-testable pointer down
			// (e.g. programmatic select) — there is no anchor for the gizmo.
			console.warn('[Transform] selection ignored: no hit point');
			return;
		}

		this._selectedFragProxyMap = {};

		const modelTransform = this._selection.model.transform || { translation: { x: 0, y: 0, z: 0 } };

		this._selection.model.offset = {
			x: hitPoint.x - modelTransform.translation.x,
			y: hitPoint.y - modelTransform.translation.y,
			z: hitPoint.z - modelTransform.translation.z
		};

		this._transformControlTx.visible = true;

		this._transformControlTx.setPosition(hitPoint);

		this._transformControlTx.addEventListener('change', this.onTxChange);

		this._viewer.addEventListener(Autodesk().Viewing.CAMERA_CHANGE_EVENT, this.onCameraChanged);

		this._selection.fragIdsArray.forEach((fragId: number) => {
			const fragProxy = this._viewer.impl.getFragmentProxy(this._selection.model, fragId);

			fragProxy.getAnimTransform();

			fragProxy.offset = {
				x: hitPoint.x - fragProxy.position.x,
				y: hitPoint.y - fragProxy.position.y,
				z: hitPoint.z - fragProxy.position.z
			};

			this._selectedFragProxyMap[fragId] = fragProxy;
		});

		this._viewer.impl.sceneUpdated(true);
	}

	private clearSelection(): void {
		if (this.active) {
			this._selection = null;

			this._selectedFragProxyMap = {};

			this._transformControlTx.visible = false;

			this._transformControlTx.removeEventListener('change', this.onTxChange);

			this._viewer.removeEventListener(Autodesk().Viewing.CAMERA_CHANGE_EVENT, this.onCameraChanged);

			this._viewer.impl.sceneUpdated(true);
		}
	}

	///////////////////////////////////////////////////////////////////////////
	// get 3d hit point on mesh — MapLibre bridge version: hit-test the
	// visible map canvas via the bridge-patched canvas rect.
	//
	///////////////////////////////////////////////////////////////////////////
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	private getHitPoint(event: { clientX: number; clientY: number }): any {
		const rect = this._viewer.impl.getCanvasBoundingClientRect();

		const hit = this._viewer.impl.hitTest(
			event.clientX - rect.left,
			event.clientY - rect.top,
			false
		);

		return hit ? hit.point : null;
	}

	///////////////////////////////////////////////////////////////////
	//
	//
	///////////////////////////////////////////////////////////////////
	activate(): void {
		if (!this.active) {
			this.active = true;

			this._viewer.select([]);

			const bbox = this._viewer.model.getBoundingBox();

			this._viewer.impl.createOverlayScene('TransformToolOverlay');

			this._transformControlTx = new (THREE().TransformControls)(
				this._viewer.impl.camera,
				this._viewer.impl.canvas,
				'translate',
				// MapLibre bridge: the LMV canvas is display:none — size the
				// gizmo against the visible map canvas rect.
				() => this._viewer.impl.getCanvasBoundingClientRect()
			);

			// r71 Box3 has no getBoundingSphere — approximate from the diagonal.
			const bboxSize = bbox.max.clone().sub(bbox.min).length() / 2;
			this._transformControlTx.setSize(bboxSize * 5);

			this._transformControlTx.visible = false;

			this._viewer.impl.addOverlay('TransformToolOverlay', this._transformControlTx);

			this._transformMesh = this.createTransformMesh();

			this._transformControlTx.attach(this._transformMesh);

			this._viewer.addEventListener(
				Autodesk().Viewing.AGGREGATE_SELECTION_CHANGED_EVENT,
				this.onAggregateSelectionChanged
			);
		}
	}

	///////////////////////////////////////////////////////////////////////////
	// deactivate tool
	//
	///////////////////////////////////////////////////////////////////////////
	deactivate(): void {
		if (this.active) {
			this.active = false;

			this._viewer.impl.removeOverlay('TransformToolOverlay', this._transformControlTx);

			this._transformControlTx.removeEventListener('change', this.onTxChange);

			this._viewer.impl.removeOverlayScene('TransformToolOverlay');

			this._viewer.removeEventListener(Autodesk().Viewing.CAMERA_CHANGE_EVENT, this.onCameraChanged);

			this._viewer.removeEventListener(
				Autodesk().Viewing.AGGREGATE_SELECTION_CHANGED_EVENT,
				this.onAggregateSelectionChanged
			);
		}
	}

	///////////////////////////////////////////////////////////////////////////
	//
	//
	///////////////////////////////////////////////////////////////////////////
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	handleButtonDown(event: any, _button: number): boolean {
		this._hitPoint = this.getHitPoint(event);

		this._isDragging = true;

		if (this._transformControlTx.onPointerDown(event)) return true;

		return false;
	}

	///////////////////////////////////////////////////////////////////////////
	//
	//
	///////////////////////////////////////////////////////////////////////////
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	handleButtonUp(event: any, _button: number): boolean {
		this._isDragging = false;

		if (this._transformControlTx.onPointerUp(event)) return true;

		return false;
	}

	///////////////////////////////////////////////////////////////////////////
	//
	//
	///////////////////////////////////////////////////////////////////////////
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	handleMouseMove(event: any): boolean {
		if (this._isDragging) {
			if (this._transformControlTx.onPointerMove(event)) {
				return true;
			}

			return false;
		}

		if (this._transformControlTx.onPointerHover(event)) return true;

		return false;
	}
}
