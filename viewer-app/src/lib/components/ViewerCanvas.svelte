<script lang="ts">
	import { onMount } from 'svelte';
	import type { ErrorEvent, GeoJSONSourceSpecification, IControl, Map as MaplibreMap } from 'maplibre-gl';
	import { DEFAULT_BASEMAP_STYLE, selectedBasemapStyle } from '$lib/state/basemap-style';
	import { CONTEXTUAL_LAYER_OPTIONS, selectedContextualLayerIds } from '$lib/state/contextual-layers';
	import { elevationQueryEnabled, serviceAreaEnabled } from '$lib/state/location-services';
	import { lmvInteractionEnabled } from '$lib/state/lmv-interaction';
	import { loadSiteCatalog, loadSiteOutlines, selectedSiteId, type Site } from '$lib/state/site-catalog';
	import { createLmvBridge, createMercatorModelPlacement } from '$lib/lmv/lmv-maplibre-bridge';
	import MapboxDraw from 'maplibre-gl-draw';
	import 'maplibre-gl-draw/dist/mapbox-gl-draw.css';
	import 'maplibre-gl/dist/maplibre-gl.css';

	const arcgisToken =
		import.meta.env.VITE_ARCGIS_ACCESS_TOKEN?.trim() ??
		import.meta.env.PUBLIC_ARCGIS_ACCESS_TOKEN?.trim() ??
		'';
	const hasArcgisToken = arcgisToken.length > 0;

	let mapContainer: HTMLDivElement | undefined;
	let lmvContainer: HTMLDivElement | undefined;
	let map: MaplibreMap | undefined;
	let mapError = $state<string | null>(null);
	let lmvStatus = $state<string | null>(null);

	// MapboxDraw instance (created in onMount once the map exists).
	let drawInstance: MapboxDraw | undefined;
	let drawGeoJson = $state('');
	let drawVisible = $state(false);

	const updateDrawOutput = () => {
		if (!drawInstance) return;
		const fc = drawInstance.getAll();
		drawGeoJson = fc.features.length ? JSON.stringify(fc, null, 2) : '';
		drawVisible = fc.features.length > 0;
	};
	const copyDrawGeoJson = async () => {
		if (!drawGeoJson) return;
		try {
			await navigator.clipboard.writeText(drawGeoJson);
		} catch {
			// Clipboard API unavailable — let the user select/copy manually.
		}
	};
	const clearDraw = () => {
		drawInstance?.deleteAll();
		updateDrawOutput();
	};

	// Initial camera center (Brownsville, PA area); the map is fit to all site
	// pins on load, and models only load when a site is picked or approached.
	const MODEL_ORIGIN: [number, number] = [-79.88666527, 40.022371938];

	// Per-site pin/outline colors, same palette as the acc-folder-rvt-on-map viewer.
	const SITE_PALETTE = ['#ea580c', '#2563eb', '#16a34a', '#9333ea', '#dc2626', '#0891b2'];
	const OUTLINES_SOURCE_ID = 'site-outlines';
	const OUTLINES_LAYER_ID = 'site-outline-lines';

	const getErrorMessage = (error: unknown): string =>
		error instanceof Error ? error.message : 'Map failed to load.';

	onMount(() => {
		if (!mapContainer) {
			mapError = 'Map container is unavailable.';
			return;
		}

		void (async () => {
			try {
				// Shared site catalog (static/site_outlines.geojson) — drives the
				// header combo box → bridge.loadModel(urn) flow.
				const sites = await loadSiteCatalog();
				const sitesById = new Map<string, Site>(sites.map((site) => [site.id, site]));
				const outlinesData = await loadSiteOutlines();

				const [{ default: maplibregl }, { BasemapStyle, FeatureLayer }] = await Promise.all([
					import('maplibre-gl'),
					import('@esri/maplibre-arcgis')
				]);

				map = new maplibregl.Map({
					container: mapContainer,
					// Without an ArcGIS token, degrade to a free basemap instead of
					// blocking the whole viewer (ArcGIS basemap switching stays off).
					...(hasArcgisToken ? {} : { style: 'https://tiles.openfreemap.org/styles/bright' }),
					zoom: 18,
					center: MODEL_ORIGIN,
					pitch: 60,
					maxPitch: 85,
					attributionControl: false,
					canvasContextAttributes: { antialias: true }
				});
				// ── Site pins + outline polygons (always visible, independent of LMV) ──
				// The style may not be ready when the map is created, and custom
				// sources/layers are dropped on every basemap style swap, so use the
				// same retry pattern as maplibre-index.html's addBuildingLayers/restoreLayers.
				const addOutlineLayers = (): boolean => {
					if (!map || !map.isStyleLoaded()) return false;
					if (!map.getSource(OUTLINES_SOURCE_ID)) {
						map.addSource(OUTLINES_SOURCE_ID, { type: 'geojson', data: outlinesData });
					}
					if (!map.getLayer(OUTLINES_LAYER_ID)) {
						map.addLayer({
							id: OUTLINES_LAYER_ID,
							type: 'line',
							source: OUTLINES_SOURCE_ID,
							filter: ['==', ['get', 'kind'], 'outline'],
							paint: {
								// eslint-disable-next-line @typescript-eslint/no-explicit-any
								'line-color': [
									'match',
									['get', 'id'],
									...sites.flatMap((s, i) => [s.id, SITE_PALETTE[i % SITE_PALETTE.length]]),
									SITE_PALETTE[0]
								] as any,
								'line-width': 2.5,
								'line-opacity': 0.95
							}
						});
					}
					return true;
				};
				let outlineRetries = 0;
				const restoreOutlineLayers = (): void => {
					if (addOutlineLayers()) {
						outlineRetries = 0;
						return;
					}
					if (outlineRetries >= 30) return;
					outlineRetries += 1;
					window.setTimeout(restoreOutlineLayers, 100);
				};
				map.on('style.load', restoreOutlineLayers);
				restoreOutlineLayers();

				// One clickable pin per site (DOM markers survive style swaps).
				for (const [index, site] of sites.entries()) {
					const marker = new maplibregl.Marker({
						color: SITE_PALETTE[index % SITE_PALETTE.length]
					})
						.setLngLat([site.lon, site.lat])
						.addTo(map);
					marker.getElement().addEventListener('click', () => selectedSiteId.set(site.id));
				}

				// Show the full site list from the start.
				const siteBounds = new maplibregl.LngLatBounds();
				sites.forEach((s) => siteBounds.extend([s.lon, s.lat]));
				map.fitBounds(siteBounds, { padding: 60, duration: 0 });

				// ── Draw tool (line/polygon + GeoJSON export), like maplibre-index.html ──
				drawInstance = new MapboxDraw({
					displayControlsDefault: false,
					controls: { line_string: true, polygon: true, trash: true },
					defaultMode: 'simple_select'
				});
				map.addControl(drawInstance as unknown as IControl, 'top-left');
				map.on('draw.create', updateDrawOutput);
				map.on('draw.update', updateDrawOutput);
				map.on('draw.delete', updateDrawOutput);

				// Header combo box unsubscriber — declared at outer scope so the map
				// remove handler can unsubscribe even though the LMV bridge (and thus
				// the subscription) only exists when LMV initialized.
				let unsubscribeSelectedSiteId: (() => void) | undefined;

				// ── LMV (APS Viewer) bridge: render models into this map ──
				// MapLibre owns the camera/frame loop; LMV renders into the shared
				// WebGL context via a custom layer. Failures here must never break
				// the ArcGIS app, so everything is guarded. No model is loaded at
				// startup — sites load on pick or proximity.
				try {
					if (!lmvContainer) {
						throw new Error('LMV container is unavailable.');
					}
					const bridge = createLmvBridge({
						container: lmvContainer,
						modelPlacement: createMercatorModelPlacement({
							origin: MODEL_ORIGIN,
							altitude: 10,
							rotationDeg: 30,
							unitScale: 0.3048
						}),
						onStatus: (message) => (lmvStatus = message)
					});

					// Debug hooks (used by the browser probes).
					(window as unknown as Record<string, unknown>).__map = map;
					(window as unknown as Record<string, unknown>).__lmvBridge = bridge;

					// Shared model loader: relocate the model to the site's lat/long and
					// optionally fly the camera there (bearing = -17.6 + bearingOffset).
					// The old model is unloaded by the bridge's loadLmvModel.
					const loadSiteModel = (siteId: string, { flyTo }: { flyTo: boolean }): void => {
						const site = sitesById.get(siteId);
						if (!site?.urn) return;

						bridge.setPlacement(
							createMercatorModelPlacement({
								// Model origin may differ from the pin (per-site modelOriginLon/Lat).
								origin: [site.modelOriginLon ?? site.lon, site.modelOriginLat ?? site.lat],
								altitude: site.modelAltitude ?? 10,
								// Per-site model orientation/scale from the geojson
								// (modelRotationDeg, modelScale). Base unitScale 0.3048 = feet→meters.
								rotationDeg: site.modelRotationDeg ?? 0,
								unitScale: 0.3048 * (site.modelScale ?? 1)
							})
						);
						if (flyTo) {
							const bearing = -17.6 + (site.bearingOffset || 0);
							map?.flyTo({
								center: [site.lon, site.lat],
								zoom: 18,
								pitch: 55,
								bearing,
								duration: 11800
							});
						}

						lmvStatus = null;
						void bridge.loadModel(site.urn).catch((error: unknown) => {
							console.error('[LMV] Model load failed', error);
							lmvStatus = 'LMV model failed to load.';
						});
					};

					// User-driven selection (combo box, pin click) — always flies to the site.
					unsubscribeSelectedSiteId = selectedSiteId.subscribe((siteId) => {
						if (!siteId) return;
						lastAutoLoadedSiteId = siteId;
						loadSiteModel(siteId, { flyTo: true });
					});

					// ── Proximity auto-load ──
					// When the camera settles with any site pin in view at zoom >= 12,
					// load that site's model in place (no flyTo — the user's camera is
					// left alone). If several pins are visible, the one nearest the
					// viewport center wins. The old model is unloaded by loadLmvModel.
					let lastAutoLoadedSiteId: string | null = null;
					const onCameraSettled = (): void => {
						if (!map || map.getZoom() < 12) return;
						const bounds = map.getBounds();
						// 5% margin so pins near the viewport edge still count as “in view”.
						const marginLng = (bounds.getEast() - bounds.getWest()) * 0.05;
						const marginLat = (bounds.getNorth() - bounds.getSouth()) * 0.05;
						const relaxedBounds = new maplibregl.LngLatBounds(
							[bounds.getWest() - marginLng, bounds.getSouth() - marginLat],
							[bounds.getEast() + marginLng, bounds.getNorth() + marginLat]
						);
						const canvas = map.getCanvas();
						const cx = canvas.clientWidth / 2;
						const cy = canvas.clientHeight / 2;

						let best: { siteId: string; dist: number } | null = null;
						for (const site of sites) {
							if (!relaxedBounds.contains([site.lon, site.lat])) continue;
							const p = map.project([site.lon, site.lat]);
							const dist = Math.hypot(p.x - cx, p.y - cy);
							if (!best || dist < best.dist) best = { siteId: site.id, dist };
						}

						if (best && best.siteId !== lastAutoLoadedSiteId) {
							lastAutoLoadedSiteId = best.siteId;
							console.log(`[proximity] loading model for ${best.siteId}`);
							loadSiteModel(best.siteId, { flyTo: false });
						}
					};
					map.on('moveend', onCameraSettled);
					map.on('idle', onCameraSettled);

					// Header toggle: route pointer interaction to the LMV model.
					const unsubscribeLmvInteractionMode = lmvInteractionEnabled.subscribe((enabled) => {
						bridge.setInteractionMode(enabled ? 'lmv' : 'map');
					});
					map.on('remove', unsubscribeLmvInteractionMode);

					const ensureLmvLayer = () => {
						if (!map) return;
						// Custom layers are dropped when the basemap style is swapped —
						// re-add on every style.load (bridge.onAdd is idempotent).
						if (!map.getLayer('lmv-model')) {
							map.addLayer(bridge.layer);
						}
					};
					map.on('style.load', ensureLmvLayer);
					if (map.isStyleLoaded()) ensureLmvLayer();
				} catch (error) {
					console.error('[LMV] Initialization failed', error);
					lmvStatus = 'LMV viewer unavailable.';
				}

				const basemapStyle = hasArcgisToken
					? BasemapStyle.applyStyle(map, {
							style: DEFAULT_BASEMAP_STYLE,
							token: arcgisToken,
							preferences: {
								language: 'en',
								worldview: 'unitedStatesOfAmerica'
							}
						})
					: undefined;
				let activeStyleId = DEFAULT_BASEMAP_STYLE;
				let activeContextualLayerIds: string[] = [];
				let isServiceAreaEnabled = false;
				let isElevationQueryEnabled = false;
				let isLmvInteractionEnabled = false;
				const contextualFeatureLayers = new Map<
					string,
					Awaited<ReturnType<typeof FeatureLayer.fromUrl>>
				>();
				const contextualLayerConfigById = new Map(
					CONTEXTUAL_LAYER_OPTIONS.map((layer) => [layer.id, layer] as const)
				);
				let activeServiceAreaPopup: InstanceType<typeof maplibregl.Popup> | undefined;

				const unsubscribeSelectedBasemapStyle = selectedBasemapStyle.subscribe((styleId) => {
					if (!basemapStyle || styleId === activeStyleId) {
						return;
					}

					void basemapStyle
						.updateStyle({
							style: styleId,
							token: arcgisToken,
							preferences: {
								language: 'en',
								worldview: 'unitedStatesOfAmerica'
							}
						})
						.then(() => {
							activeStyleId = styleId;
						})
						.catch((error: unknown) => {
							mapError = getErrorMessage(error);
						});
				});
				const syncContextualLayerVisibility = () => {
					if (!map) {
						return;
					}
					if (!map.isStyleLoaded()) {
						return;
					}

					for (const [layerId, featureLayer] of contextualFeatureLayers.entries()) {
						const sourceId = featureLayer.sourceId;
						const mapLayerId = featureLayer.layer?.id;
						if (!sourceId || !mapLayerId) {
							continue;
						}

						const shouldBeVisible = activeContextualLayerIds.includes(layerId);
						const hasSource = Boolean(map.getSource(sourceId));
						const hasLayer = Boolean(map.getLayer(mapLayerId));

						if (shouldBeVisible) {
							if (!hasSource) {
								map.addSource(
									sourceId,
									featureLayer.copySource(sourceId) as GeoJSONSourceSpecification
								);
							}
							if (!hasLayer) {
								const contextualLayer = contextualLayerConfigById.get(layerId);
								if (contextualLayer?.style) {
									featureLayer.addLayerTo(map, contextualLayer.style);
								} else {
									featureLayer.addLayerTo(map);
								}
							}
							continue;
						}

						if (hasLayer) {
							map.removeLayer(mapLayerId);
						}
						if (hasSource) {
							map.removeSource(sourceId);
						}
					}

					// Contextual feature layers are appended on top — keep the LMV
					// model layer above them so the building is never buried.
					if (map.getLayer('lmv-model')) {
						map.moveLayer('lmv-model');
					}
				};
				const unsubscribeSelectedContextualLayerIds = selectedContextualLayerIds.subscribe((layerIds) => {
					activeContextualLayerIds = layerIds;
					syncContextualLayerVisibility();
				});
				const unsubscribeServiceAreaEnabled = serviceAreaEnabled.subscribe((enabled) => {
					isServiceAreaEnabled = enabled;
					if (!enabled && !isElevationQueryEnabled) {
						activeServiceAreaPopup?.remove();
						activeServiceAreaPopup = undefined;
					}
				});
				const unsubscribeElevationQueryEnabled = elevationQueryEnabled.subscribe((enabled) => {
					isElevationQueryEnabled = enabled;
					if (!enabled && !isServiceAreaEnabled) {
						activeServiceAreaPopup?.remove();
						activeServiceAreaPopup = undefined;
					}
				});
				const unsubscribeLmvInteractionGate = lmvInteractionEnabled.subscribe((enabled) => {
					isLmvInteractionEnabled = enabled;
					if (enabled) {
						activeServiceAreaPopup?.remove();
						activeServiceAreaPopup = undefined;
					}
				});

				for (const contextualLayer of CONTEXTUAL_LAYER_OPTIONS) {
					const featureLayer = await FeatureLayer.fromUrl(contextualLayer.url, {
						...(hasArcgisToken ? { token: arcgisToken } : {})
					});
					contextualFeatureLayers.set(contextualLayer.id, featureLayer);
				}
				syncContextualLayerVisibility();
				map.on('click', (event) => {
					if (isLmvInteractionEnabled || (!isServiceAreaEnabled && !isElevationQueryEnabled)) {
						return;
					}

					activeServiceAreaPopup?.remove();
					const popupContent = document.createElement('div');
					const coordinatesHtml = `
						<calcite-block open heading="Coordinates">
							<p>Longitude: ${event.lngLat.lng.toFixed(5)}</p>
							<p>Latitude: ${event.lngLat.lat.toFixed(5)}</p>
						</calcite-block>
					`;
					popupContent.innerHTML = `
						${isServiceAreaEnabled ? `<calcite-panel heading="Service area" description="Clicked location">${coordinatesHtml}</calcite-panel>` : ''}
						${isElevationQueryEnabled ? `<calcite-panel heading="Elevation query" description="Clicked location">${coordinatesHtml}</calcite-panel>` : ''}
					`;

					activeServiceAreaPopup = new maplibregl.Popup({ closeOnClick: false })
						.setLngLat(event.lngLat)
						.setDOMContent(popupContent)
						.addTo(map);
				});

				basemapStyle?.on('BasemapStyleError', (error) => {
					mapError = getErrorMessage(error);
				});
				basemapStyle?.on('BasemapStyleLoad', () => {
					syncContextualLayerVisibility();
				});
				// No-token fallback path: re-sync contextual layers when the free
				// basemap style (re)loads. Idempotent, so harmless in the token path.
				map.on('style.load', syncContextualLayerVisibility);

				map.on('error', (event: ErrorEvent) => {
					mapError = getErrorMessage(event.error);
				});

				map.on('remove', () => {
					unsubscribeSelectedBasemapStyle();
					unsubscribeSelectedContextualLayerIds();
					unsubscribeServiceAreaEnabled();
					unsubscribeElevationQueryEnabled();
					unsubscribeLmvInteractionGate();
					unsubscribeSelectedSiteId?.();
				});
			} catch (error) {
				mapError = getErrorMessage(error);
			}
		})();

		return () => {
			map?.remove();
			map = undefined;
		};
	});
</script>

<section class="viewer" aria-label="Map viewer">
	<div bind:this={mapContainer} class="map-host" data-maplibre-container></div>
	<div bind:this={lmvContainer} class="lmv-hidden"></div>
	{#if lmvStatus && !mapError}
		<div class="lmv-status" role="status">{lmvStatus}</div>
	{/if}
	{#if mapError}
		<div class="status-message" role="alert">{mapError}</div>
	{/if}
	{#if drawVisible}
		<div class="draw-output">
			<div class="draw-head">
				<span class="draw-title">Drawn GeoJSON</span>
			</div>
			<textarea readonly spellcheck="false" bind:value={drawGeoJson}></textarea>
			<div class="draw-actions">
				<button type="button" onclick={copyDrawGeoJson}>Copy GeoJSON</button>
				<button type="button" onclick={clearDraw}>Clear drawing</button>
			</div>
		</div>
	{/if}
	<!-- Construction-phasing slider bar. Pure presentation: the LMV
	     PhasingExtension (src/lib/lmv/phasing-extension) owns all interaction
	     via these element ids; styles live in app.css because the tooltip chip
	     is injected by the extension (innerHTML), outside Svelte's scoping. -->
	<div id="phasing-bar" class="hidden">
		<div class="phasing-chips" id="phasing-legend"></div>
		<div class="phasing-row">
			<span class="phasing-title">Construction Phasing</span>
			<div class="phasing-slider-wrap">
				<input type="range" id="phasing-slider" min="0" max="1000" step="1" value="0" />
			</div>
			<span class="phasing-current" id="phasing-current">—</span>
			<span class="phasing-reset" id="phasing-reset">reset</span>
		</div>
	</div>
</section>

<style>
	.viewer,
	.map-host {
		width: 100%;
		height: 100%;
	}

	.viewer {
		position: relative;
		overflow: hidden;
		background: var(--calcite-color-background);
	}

	.map-host {
		position: absolute;
		inset: 0;
	}

	.lmv-status {
		position: absolute;
		top: 1rem;
		inset-inline-start: 1rem;
		z-index: 2;
		padding: 0.35rem 0.75rem;
		border-radius: 0.5rem;
		background: var(--calcite-color-foreground-1);
		color: var(--calcite-color-text-2);
		font-size: var(--calcite-font-size--2);
		box-shadow: 0 2px 8px rgb(0 0 0 / 12%);
		pointer-events: none;
	}

	.status-message {
		position: absolute;
		inset-inline: 1rem;
		bottom: 1rem;
		z-index: 1;
		max-width: 36rem;
		padding: 0.75rem 1rem;
		border: 1px solid var(--calcite-color-border-input);
		border-radius: 0.5rem;
		background: var(--calcite-color-foreground-1);
		color: var(--calcite-color-text-1);		font-size: var(--calcite-font-size--1);
		box-shadow: 0 2px 8px rgb(0 0 0 / 12%);
	}

	.draw-output {
		position: absolute;
		bottom: 1rem;
		inset-inline-start: 1rem;
		z-index: 3;
		background: var(--calcite-color-foreground-1);
		padding: 0.625rem 0.75rem;
		border-radius: 0.5rem;
		box-shadow: 0 2px 10px rgb(0 0 0 / 18%);
		width: 21rem;
		font: 11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
	}

	.draw-output .draw-head {
		display: flex;
		justify-content: space-between;
		align-items: center;
		margin-bottom: 0.375rem;
	}

	.draw-output .draw-title {
		font: 600 12px system-ui, sans-serif;
		color: var(--calcite-color-text-1);
	}

	.draw-output textarea {
		width: 100%;
		height: 7.5rem;
		resize: vertical;
		border: 1px solid var(--calcite-color-border-input);
		border-radius: 6px;
		padding: 6px;
		font: inherit;
		color: var(--calcite-color-text-1);
		background: var(--calcite-color-foreground-2);
	}

	.draw-output .draw-actions {
		display: flex;
		gap: 6px;
		margin-top: 6px;
	}

	.draw-output button {
		flex: 1;
		background: var(--calcite-color-foreground-2);
		color: var(--calcite-color-text-1);
		border: 1px solid var(--calcite-color-border-input);
		border-radius: 5px;
		padding: 5px 8px;
		font: 600 11px system-ui, sans-serif;
		cursor: pointer;
	}

	.draw-output button:hover {
		background: var(--calcite-color-foreground-3);
	}
</style>
