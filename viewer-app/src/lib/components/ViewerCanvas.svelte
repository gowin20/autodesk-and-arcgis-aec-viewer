<script lang="ts">
	import { onMount } from 'svelte';
	import { get } from 'svelte/store';
	import { base } from '$app/paths';
	import type {
		ErrorEvent,
		GeoJSONSource,
		GeoJSONSourceSpecification,
		IControl,
		Map as MaplibreMap
	} from 'maplibre-gl';
	import { getElevationAtLocation } from '$lib/arcgis/elevation';
	import { fetchServiceArea, type ServiceAreaParameters } from '$lib/arcgis/routing';
	import {
		activeBasemapStyle,
		satelliteBasemapEnabled,
		toggleSatelliteBasemap
	} from '$lib/state/basemap-style';
	import { CONTEXTUAL_LAYER_OPTIONS } from '$lib/state/contextual-layers';
	import {
		addElevationResultViewerLayer,
		projectLayersVisible,
		type ElevationResultViewerLayer,
		type GeocodeResultViewerLayer,
		type RoutingResultViewerLayer,
		type SiteLocationViewerLayer,
		upsertGeocodeResultViewerLayer,
		upsertServiceAreaViewerLayer,
		viewerLayers,
		type ServiceAreaViewerLayer,
		type ViewerLayer
	} from '$lib/state/layers';
	import {
		enabledTravelModes,
		elevationQueryEnabled,
		mapCenter,
		selectedSearchLocation,
		serviceAreaEnabled
	} from '$lib/state/location-services';
	import {
		routePlannerLocations,
		routePlannerMapPickedPoint,
		routePlannerMapPickTargetId
	} from '$lib/state/routing-stops';
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
	let isSatelliteBasemapActive = $state(false);

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
	const toggleBasemapOverlay = () => {
		if (!hasArcgisToken) {
			return;
		}
		toggleSatelliteBasemap();
	};

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
						onStatus: (message) => {
							// Test/debug hook (the probes poll this instead of DOM chrome).
							(window as unknown as Record<string, unknown>).__lmvStatus = message;
						},
						// Keep the interaction store in sync when the bridge
						// auto-switches (measure/section/explode tools).
						onInteractionMode: (mode) => lmvInteractionEnabled.set(mode === 'lmv')
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

						void bridge.loadModel(site.urn).catch((error: unknown) => {
							console.error('[LMV] Model load failed', error);
							(window as unknown as Record<string, unknown>).__lmvStatus =
								'LMV model failed to load.';
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
					(window as unknown as Record<string, unknown>).__lmvStatus = 'LMV viewer unavailable.';
				}

				const basemapStyle = hasArcgisToken
					? BasemapStyle.applyStyle(map, {
							style: get(activeBasemapStyle),
							token: arcgisToken,
							preferences: {
								language: 'en',
								worldview: 'unitedStatesOfAmerica'
							}
						})
					: undefined;
				let activeStyleId = get(activeBasemapStyle);
				let activeViewerLayers: ViewerLayer[] = [];
				let isProjectLayersVisible = true;
				let isServiceAreaEnabled = false;
				let activeEnabledTravelModes = {
					driving: undefined,
					walking: undefined
				} as {
					driving?: ServiceAreaParameters['travelMode'];
					walking?: ServiceAreaParameters['travelMode'];
				};
				let isElevationQueryEnabled = false;
				let isLmvInteractionEnabled = false;
				let activeRoutePlannerMapPickTargetId: string | null = null;
				const contextualFeatureLayers = new Map<
					string,
					Awaited<ReturnType<typeof FeatureLayer.fromUrl>>
				>();
				const contextualLayerConfigById = new Map(
					CONTEXTUAL_LAYER_OPTIONS.map((layer) => [layer.id, layer] as const)
				);
				let activeServiceAreaPopup: InstanceType<typeof maplibregl.Popup> | undefined;
				const markerLayers = new Map<string, InstanceType<typeof maplibregl.Marker>>();
				const routePlannerMarkers = new Map<string, InstanceType<typeof maplibregl.Marker>>();
				const SERVICE_AREA_SOURCE_ID = 'service-area-result';
				const SERVICE_AREA_FILL_LAYER_ID = 'service-area-fill';
				const SERVICE_AREA_OUTLINE_LAYER_ID = 'service-area-outline';
				const ROUTE_PLANNER_SOURCE_ID = 'route-planner-result';
				const ROUTE_PLANNER_LINE_LAYER_ID = 'route-planner-line';
				const ELEVATION_COLOR_MIN_FEET = 741;
				const ELEVATION_COLOR_MID_FEET = 780;
				const ELEVATION_COLOR_MAX_FEET = 1500;
				const isServiceAreaLayer = (layer: ViewerLayer): layer is ServiceAreaViewerLayer =>
					layer.kind === 'service-area';
				const isSiteLocationLayer = (layer: ViewerLayer): layer is SiteLocationViewerLayer =>
					layer.kind === 'site-location';
				const isGeocodeResultLayer = (layer: ViewerLayer): layer is GeocodeResultViewerLayer =>
					layer.kind === 'geocode-result';
				const isElevationResultLayer = (layer: ViewerLayer): layer is ElevationResultViewerLayer =>
					layer.kind === 'elevation-result';
				const isRoutingResultLayer = (layer: ViewerLayer): layer is RoutingResultViewerLayer =>
					layer.kind === 'routing-result';
				const getContextualLayerEntry = (layerId: string) =>
					activeViewerLayers.find(
						(layer) => layer.kind === 'contextual' && layer.contextualLayerId === layerId
					);
				let activeRoutePlannerLocations: Array<{
					id: string;
					order: number;
					longitude: number;
					latitude: number;
					label: string;
				}> = [];
				const clamp = (value: number, min: number, max: number) =>
					Math.min(Math.max(value, min), max);
				const getElevationColorRatio = (elevationFeet: number): number => {
					if (!Number.isFinite(elevationFeet)) {
						return 0;
					}
					const range = ELEVATION_COLOR_MAX_FEET - ELEVATION_COLOR_MIN_FEET;
					return clamp((elevationFeet - ELEVATION_COLOR_MIN_FEET) / range, 0, 1);
				};
				const interpolate = (start: number, end: number, ratio: number): number =>
					Math.round(start + (end - start) * ratio);
				const getElevationMarkerColor = (elevationFeet: number): string => {
					if (!Number.isFinite(elevationFeet)) {
						return 'rgb(0, 180, 170)';
					}
					// 3-stop gradient: cyan (741) -> green (780) -> red (1500)
					if (elevationFeet <= ELEVATION_COLOR_MID_FEET) {
						const lowerRange = ELEVATION_COLOR_MID_FEET - ELEVATION_COLOR_MIN_FEET;
						const lowerRatio =
							lowerRange > 0
								? clamp((elevationFeet - ELEVATION_COLOR_MIN_FEET) / lowerRange, 0, 1)
								: 1;
						const red = interpolate(0, 46, lowerRatio);
						const green = interpolate(180, 160, lowerRatio);
						const blue = interpolate(170, 67, lowerRatio);
						return `rgb(${red}, ${green}, ${blue})`;
					}

					const upperRange = ELEVATION_COLOR_MAX_FEET - ELEVATION_COLOR_MID_FEET;
					const upperRatio =
						upperRange > 0
							? clamp((elevationFeet - ELEVATION_COLOR_MID_FEET) / upperRange, 0, 1)
							: 1;
					const red = interpolate(46, 220, upperRatio);
					const green = interpolate(160, 38, upperRatio);
					const blue = interpolate(67, 38, upperRatio);
					return `rgb(${red}, ${green}, ${blue})`;
				};

				const renderServiceArea = (
					data: GeoJSONSourceSpecification['data'],
					visible: boolean
				) => {
					if (!map?.isStyleLoaded()) return;

					const existingSource = map.getSource(SERVICE_AREA_SOURCE_ID) as GeoJSONSource | undefined;
					if (existingSource) {
						existingSource.setData(data);
					} else {
						map.addSource(SERVICE_AREA_SOURCE_ID, { type: 'geojson', data });
					}
					if (!map.getLayer(SERVICE_AREA_FILL_LAYER_ID)) {
						map.addLayer({
							id: SERVICE_AREA_FILL_LAYER_ID,
							type: 'fill',
							source: SERVICE_AREA_SOURCE_ID,
							paint: {
								'fill-color': '#007ac2',
								'fill-opacity': 0.22
							}
						});
					}
					if (!map.getLayer(SERVICE_AREA_OUTLINE_LAYER_ID)) {
						map.addLayer({
							id: SERVICE_AREA_OUTLINE_LAYER_ID,
							type: 'line',
							source: SERVICE_AREA_SOURCE_ID,
							paint: {
								'line-color': '#00619b',
								'line-width': 2
							}
						});
					}
					map.setLayoutProperty(
						SERVICE_AREA_FILL_LAYER_ID,
						'visibility',
						visible ? 'visible' : 'none'
					);
					map.setLayoutProperty(
						SERVICE_AREA_OUTLINE_LAYER_ID,
						'visibility',
						visible ? 'visible' : 'none'
					);
				};

				const removeServiceAreaRender = () => {
					if (!map?.isStyleLoaded()) return;
					if (map.getLayer(SERVICE_AREA_FILL_LAYER_ID)) {
						map.removeLayer(SERVICE_AREA_FILL_LAYER_ID);
					}
					if (map.getLayer(SERVICE_AREA_OUTLINE_LAYER_ID)) {
						map.removeLayer(SERVICE_AREA_OUTLINE_LAYER_ID);
					}
					if (map.getSource(SERVICE_AREA_SOURCE_ID)) {
						map.removeSource(SERVICE_AREA_SOURCE_ID);
					}
				};
				const renderRoutePlannerLine = (data: GeoJSONSourceSpecification['data']) => {
					if (!map?.isStyleLoaded()) return;
					const existingSource = map.getSource(ROUTE_PLANNER_SOURCE_ID) as GeoJSONSource | undefined;
					if (existingSource) {
						existingSource.setData(data);
					} else {
						map.addSource(ROUTE_PLANNER_SOURCE_ID, { type: 'geojson', data });
					}

					if (!map.getLayer(ROUTE_PLANNER_LINE_LAYER_ID)) {
						map.addLayer({
							id: ROUTE_PLANNER_LINE_LAYER_ID,
							type: 'line',
							source: ROUTE_PLANNER_SOURCE_ID,
							paint: {
								'line-color': '#f97316',
								'line-width': 4
							}
						});
					}
				};
				const removeRoutePlannerLine = () => {
					if (!map?.isStyleLoaded()) return;
					if (map.getLayer(ROUTE_PLANNER_LINE_LAYER_ID)) {
						map.removeLayer(ROUTE_PLANNER_LINE_LAYER_ID);
					}
					if (map.getSource(ROUTE_PLANNER_SOURCE_ID)) {
						map.removeSource(ROUTE_PLANNER_SOURCE_ID);
					}
				};
				const syncMapCursor = () => {
					if (!map) return;
					map.getCanvas().style.cursor =
						isServiceAreaEnabled || isElevationQueryEnabled || Boolean(activeRoutePlannerMapPickTargetId)
							? 'crosshair'
							: '';
				};
				const syncRoutePlannerRender = () => {
					if (!map) return;
					const activeIds = new Set(activeRoutePlannerLocations.map((location) => location.id));
					for (const [locationId, marker] of routePlannerMarkers.entries()) {
						if (!activeIds.has(locationId)) {
							marker.remove();
							routePlannerMarkers.delete(locationId);
						}
					}

					for (const location of activeRoutePlannerLocations) {
						let marker = routePlannerMarkers.get(location.id);
						if (!marker) {
							const markerElement = document.createElement('div');
							markerElement.className = 'route-stop-marker';
							markerElement.style.display = 'grid';
							markerElement.style.placeItems = 'center';
							markerElement.style.width = '1.1rem';
							markerElement.style.height = '1.1rem';
							markerElement.style.border = '2px solid #ffffff';
							markerElement.style.borderRadius = '9999px';
							markerElement.style.background = '#0ea5e9';
							markerElement.style.color = '#ffffff';
							markerElement.style.fontSize = '0.65rem';
							markerElement.style.fontWeight = '700';
							markerElement.style.boxShadow = '0 1px 4px rgb(0 0 0 / 35%)';
							markerElement.textContent = String(location.order);
							marker = new maplibregl.Marker({
								element: markerElement,
								anchor: 'center'
							})
								.setLngLat([location.longitude, location.latitude])
								.setPopup(new maplibregl.Popup().setText(location.label))
								.addTo(map);
							routePlannerMarkers.set(location.id, marker);
						} else {
							marker.setLngLat([location.longitude, location.latitude]);
							marker.setPopup(new maplibregl.Popup().setText(location.label));
						}
						const element = marker.getElement();
						element.textContent = String(location.order);
					}

				};
				const syncMarkerViewerLayers = () => {
					if (!map) return;

					const markerLayerEntries = activeViewerLayers.filter(
						(layer) =>
							layer.kind === 'site-location' ||
							layer.kind === 'geocode-result' ||
							layer.kind === 'elevation-result'
					);
					const activeMarkerLayerIds = new Set(markerLayerEntries.map((layer) => layer.id));

					for (const [layerId, marker] of markerLayers.entries()) {
						if (!activeMarkerLayerIds.has(layerId)) {
							marker.remove();
							markerLayers.delete(layerId);
						}
					}

					for (const layer of markerLayerEntries) {
						const isVisible = isProjectLayersVisible && layer.visible;
						let marker = markerLayers.get(layer.id);

						if (!marker) {
							if (isSiteLocationLayer(layer)) {
								marker = new maplibregl.Marker({ draggable: false })
									.setLngLat([layer.longitude, layer.latitude])
									.setPopup(new maplibregl.Popup().setText('Site location'))
									.addTo(map);
							} else if (isGeocodeResultLayer(layer)) {
								marker = new maplibregl.Marker({ color: '#007ac2' })
									.setLngLat([layer.longitude, layer.latitude])
									.setPopup(new maplibregl.Popup().setText(layer.locationLabel))
									.addTo(map);
							} else if (isElevationResultLayer(layer)) {
								const elevationColor = getElevationMarkerColor(layer.elevationFeet);
								const elevationColorRatio = getElevationColorRatio(layer.elevationFeet);
								console.log('[Elevation marker] Creating marker', {
									layerId: layer.id,
									elevationMeters: layer.elevationMeters,
									elevationFeet: layer.elevationFeet,
									normalizedRatio: elevationColorRatio,
									derivedColor: elevationColor
								});
								marker = new maplibregl.Marker({
									color: elevationColor
								})
									.setLngLat([layer.longitude, layer.latitude])
									.setPopup(
										new maplibregl.Popup().setHTML(
											`<strong>${layer.label}</strong><br/>${layer.elevationMeters.toLocaleString(undefined, {
												maximumFractionDigits: 1
											})} m (${layer.elevationFeet.toLocaleString(undefined, {
												maximumFractionDigits: 0
											})} ft)<br/>Longitude: ${layer.longitude.toFixed(5)}<br/>Latitude: ${layer.latitude.toFixed(5)}`
										)
									)
									.addTo(map);
							}
							if (marker) {
								markerLayers.set(layer.id, marker);
							}
						} else {
							marker.setLngLat([layer.longitude, layer.latitude]);
							if (isGeocodeResultLayer(layer)) {
								marker.setPopup(new maplibregl.Popup().setText(layer.locationLabel));
							}
						}

						const markerElement = marker?.getElement();
						if (markerElement) {
							markerElement.style.display = isVisible ? '' : 'none';
						}
					}
				};

				const openElevationResult = async (longitude: number, latitude: number) => {
					const popupContent = document.createElement('div');
					popupContent.innerHTML = `
						<calcite-panel heading="Elevation" description="ArcGIS Elevation service">
							<calcite-notice open kind="info" icon>
								<div slot="message">Querying elevation...</div>
							</calcite-notice>
						</calcite-panel>
					`;
					activeServiceAreaPopup = new maplibregl.Popup({ closeOnClick: false })
						.setLngLat([longitude, latitude])
						.setDOMContent(popupContent)
						.addTo(map!);

					try {
						const response = await getElevationAtLocation(longitude, latitude);
						const elevationMeters = Number(response.result.point.z);
						if (!Number.isFinite(elevationMeters)) {
							throw new Error('Elevation service returned an invalid elevation value.');
						}
						const elevationFeet = elevationMeters * 3.28084;
						popupContent.innerHTML = `
							<calcite-panel heading="Elevation" description="ArcGIS Elevation service">
								<calcite-block open heading="${elevationMeters.toLocaleString()} m">
									<p>${elevationFeet.toLocaleString(undefined, { maximumFractionDigits: 0 })} ft above mean sea level</p>
									<p>Longitude: ${longitude.toFixed(5)}</p>
									<p>Latitude: ${latitude.toFixed(5)}</p>
									<calcite-button id="elevation-add-layer" width="full">Add layer</calcite-button>
									<p id="elevation-add-layer-status" role="status"></p>
								</calcite-block>
							</calcite-panel>
						`;
						const addLayerButton = popupContent.querySelector('#elevation-add-layer') as
							| (HTMLElement & { disabled: boolean })
							| null;
						const addLayerStatus = popupContent.querySelector('#elevation-add-layer-status');
						addLayerButton?.addEventListener('click', () => {
							addElevationResultViewerLayer({
								longitude,
								latitude,
								elevationMeters,
								elevationFeet
							});
							if (addLayerStatus) {
								addLayerStatus.textContent = 'Elevation layer added.';
							}
							if (addLayerButton) {
								addLayerButton.disabled = true;
							}
						});
					} catch (error: unknown) {
						const message = getErrorMessage(error);
						popupContent.innerHTML = `
							<calcite-panel heading="Elevation">
								<calcite-notice open kind="danger" icon>
									<div slot="message"></div>
								</calcite-notice>
							</calcite-panel>
						`;
						const messageElement = popupContent.querySelector('[slot="message"]');
						if (messageElement) messageElement.textContent = message;
					}
				};

				const openServiceAreaForm = (longitude: number, latitude: number) => {
					const popupContent = document.createElement('div');
					popupContent.className = 'service-area-popup';
					popupContent.innerHTML = `
						<calcite-panel heading="Service area" description="Configure network analysis">
							<calcite-label>
								Break value <span id="service-area-break-units">(minutes)</span>
								<calcite-input id="service-area-break" type="number" min="1" step="1" value="5"></calcite-input>
							</calcite-label>
							<calcite-label>
								Measure
								<calcite-select id="service-area-impedance">
									<calcite-option value="time" selected>Travel time (minutes)</calcite-option>
									<calcite-option value="distance">Travel distance (kilometers)</calcite-option>
								</calcite-select>
							</calcite-label>
							<calcite-label>
								Travel mode
								<calcite-segmented-control id="service-area-travel-mode" width="full">
									<calcite-segmented-control-item value="driving" ${
										activeEnabledTravelModes.driving ? 'checked' : 'disabled'
									}>
										Driving
									</calcite-segmented-control-item>
									<calcite-segmented-control-item value="walking" ${
										activeEnabledTravelModes.walking && !activeEnabledTravelModes.driving
											? 'checked'
											: activeEnabledTravelModes.walking
												? ''
												: 'disabled'
									}>
										Walking
									</calcite-segmented-control-item>
								</calcite-segmented-control>
							</calcite-label>
							<calcite-label>
								Travel direction
								<calcite-select id="service-area-direction">
									<calcite-option value="facilitiesToIncidents" selected>Away from facility</calcite-option>
									<calcite-option value="incidentsToFacilities">Toward facility</calcite-option>
								</calcite-select>
							</calcite-label>
							<calcite-button id="service-area-run" width="full">Calculate service area</calcite-button>
							<p id="service-area-status" role="status"></p>
						</calcite-panel>
					`;

					activeServiceAreaPopup = new maplibregl.Popup({
						closeOnClick: false,
						maxWidth: '320px'
					})
						.setLngLat([longitude, latitude])
						.setDOMContent(popupContent)
						.addTo(map!);

					const breakInput = popupContent.querySelector('#service-area-break') as
						| (HTMLElement & { value: string })
						| null;
					const breakUnits = popupContent.querySelector('#service-area-break-units');
					const impedanceSelect = popupContent.querySelector('#service-area-impedance') as
						| (HTMLElement & { value: ServiceAreaParameters['impedance'] })
						| null;
					const travelModeControl = popupContent.querySelector('#service-area-travel-mode') as
						| (HTMLElement & { value: 'driving' | 'walking' })
						| null;
					const directionSelect = popupContent.querySelector('#service-area-direction') as
						| (HTMLElement & { value: ServiceAreaParameters['travelDirection'] })
						| null;
					const runButton = popupContent.querySelector('#service-area-run') as
						| (HTMLElement & { loading: boolean; disabled: boolean })
						| null;
					const status = popupContent.querySelector('#service-area-status');
					const getBreakUnitsLabel = () =>
						impedanceSelect?.value === 'distance' ? 'kilometers' : 'minutes';
					const getSelectedTravelMode = (): ServiceAreaParameters['travelMode'] | undefined => {
						const selectedTravelModeKey =
							travelModeControl?.value === 'walking' ? 'walking' : 'driving';
						return activeEnabledTravelModes[selectedTravelModeKey];
					};
					const syncBreakUnitsLabel = () => {
						if (!breakUnits) return;
						breakUnits.textContent = `(${getBreakUnitsLabel()})`;
					};
					impedanceSelect?.addEventListener('calciteSelectChange', syncBreakUnitsLabel);
					syncBreakUnitsLabel();

					runButton?.addEventListener('click', () => {
						if (!breakInput || !impedanceSelect || !directionSelect || !runButton || !status) return;

						const breakValue = Number(breakInput.value);
						const breakUnitsLabel = getBreakUnitsLabel();
						const selectedTravelMode = getSelectedTravelMode();
						if (!selectedTravelMode) {
							status.textContent =
								'The selected travel mode is unavailable. Check enabled travel modes.';
							return;
						}
						const selectedTravelModeLabel =
							typeof selectedTravelMode.name === 'string'
								? selectedTravelMode.name
								: 'Selected travel mode';
						runButton.loading = true;
						runButton.disabled = true;
						status.textContent = `Calculating service area (${breakUnitsLabel})...`;
						void fetchServiceArea([longitude, latitude], {
							breakValue,
							impedance: impedanceSelect.value,
							travelDirection: directionSelect.value,
							travelMode: selectedTravelMode
						})
							.then((response) => {
								const data = response.saPolygons?.geoJson as
									| GeoJSONSourceSpecification['data']
									| undefined;
								if (!data) throw new Error('The service returned no service-area polygons.');

								upsertServiceAreaViewerLayer(data);
								status.textContent = `${selectedTravelModeLabel} service area (${breakValue} ${breakUnitsLabel}) calculated at ${longitude.toFixed(5)}, ${latitude.toFixed(5)}.`;
							})
							.catch((error: unknown) => {
								status.textContent = getErrorMessage(error);
							})
							.finally(() => {
								runButton.loading = false;
								runButton.disabled = false;
							});
					});
				};

				const unsubscribeSatelliteBasemapEnabled = satelliteBasemapEnabled.subscribe((enabled) => {
					isSatelliteBasemapActive = enabled;
				});
				const unsubscribeActiveBasemapStyle = activeBasemapStyle.subscribe((styleId) => {
					if (!basemapStyle || styleId === activeStyleId) {
						return;
					}

					void basemapStyle
						.updateStyle({
							style: styleId,
							token: arcgisToken,
							preferences: {
								language: 'en'
							}
						})
						.then(() => {
							activeStyleId = styleId;
						})
						.catch((error: unknown) => {
							mapError = getErrorMessage(error);
						});
				});
				const syncViewerLayers = () => {
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

						const contextualLayerEntry = getContextualLayerEntry(layerId);
						const shouldExist = Boolean(contextualLayerEntry);
						const hasSource = Boolean(map.getSource(sourceId));
						const hasLayer = Boolean(map.getLayer(mapLayerId));

						if (shouldExist) {
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
							map.setLayoutProperty(
								mapLayerId,
								'visibility',
								isProjectLayersVisible && contextualLayerEntry?.visible ? 'visible' : 'none'
							);
							continue;
						}

						if (hasLayer) {
							map.removeLayer(mapLayerId);
						}
						if (hasSource) {
							map.removeSource(sourceId);
						}
					}

					const serviceAreaLayer = activeViewerLayers.find(isServiceAreaLayer);
					if (serviceAreaLayer && isProjectLayersVisible && serviceAreaLayer.visible) {
						renderServiceArea(
							serviceAreaLayer.data,
							true
						);
					} else {
						removeServiceAreaRender();
					}
					const routingResultLayer = activeViewerLayers.find(isRoutingResultLayer);
					if (routingResultLayer && isProjectLayersVisible && routingResultLayer.visible) {
						renderRoutePlannerLine(routingResultLayer.data);
					} else {
						removeRoutePlannerLine();
					}
					syncMarkerViewerLayers();
					syncRoutePlannerRender();

					// Contextual feature layers are appended on top — keep the LMV
					// model layer above them so the building is never buried.
					if (map.getLayer('lmv-model')) {
						map.moveLayer('lmv-model');
					}
				};
				const unsubscribeViewerLayers = viewerLayers.subscribe((layers) => {
					activeViewerLayers = layers;
					syncViewerLayers();
				});
				const unsubscribeProjectLayersVisible = projectLayersVisible.subscribe((visible) => {
					isProjectLayersVisible = visible;
					syncViewerLayers();
				});
				const unsubscribeServiceAreaEnabled = serviceAreaEnabled.subscribe((enabled) => {
					isServiceAreaEnabled = enabled;
					syncMapCursor();
					if (!enabled && !isElevationQueryEnabled) {
						activeServiceAreaPopup?.remove();
						activeServiceAreaPopup = undefined;
					}
				});
				const unsubscribeEnabledTravelModes = enabledTravelModes.subscribe((modes) => {
					activeEnabledTravelModes = {
						driving: modes?.driving,
						walking: modes?.walking
					};
				});
				const unsubscribeElevationQueryEnabled = elevationQueryEnabled.subscribe((enabled) => {
					isElevationQueryEnabled = enabled;
					syncMapCursor();
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
				const unsubscribeRoutePlannerMapPickTargetId = routePlannerMapPickTargetId.subscribe((targetId) => {
					activeRoutePlannerMapPickTargetId = targetId;
					syncMapCursor();
				});
				const unsubscribeSelectedSearchLocation = selectedSearchLocation.subscribe((location) => {
					if (!location || !map) return;
					upsertGeocodeResultViewerLayer({
						longitude: location.longitude,
						latitude: location.latitude,
						label: location.label
					});
					map.flyTo({
						center: [location.longitude, location.latitude],
						zoom: Math.max(map.getZoom(), 16),
						essential: true
					});
				});
				const unsubscribeRoutePlannerLocations = routePlannerLocations.subscribe((locations) => {
					activeRoutePlannerLocations = locations;
					syncRoutePlannerRender();
				});
				const updateMapCenter = () => {
					if (!map) return;
					const center = map.getCenter();
					mapCenter.set({ lng: center.lng, lat: center.lat });
				};
				map.on('moveend', updateMapCenter);
				updateMapCenter();

				for (const contextualLayer of CONTEXTUAL_LAYER_OPTIONS) {
					const featureLayer = await FeatureLayer.fromUrl(contextualLayer.url, {
						...(hasArcgisToken ? { token: arcgisToken } : {})
					});
					contextualFeatureLayers.set(contextualLayer.id, featureLayer);
				}
				syncViewerLayers();
				map.on('click', (event) => {
					if (isLmvInteractionEnabled) {
						return;
					}
					if (activeRoutePlannerMapPickTargetId) {
						routePlannerMapPickedPoint.set({
							targetId: activeRoutePlannerMapPickTargetId,
							longitude: event.lngLat.lng,
							latitude: event.lngLat.lat
						});
						routePlannerMapPickTargetId.set(null);
						return;
					}
					if (!isServiceAreaEnabled && !isElevationQueryEnabled) {
						return;
					}

					activeServiceAreaPopup?.remove();
					if (isServiceAreaEnabled) {
						openServiceAreaForm(event.lngLat.lng, event.lngLat.lat);
					} else if (isElevationQueryEnabled) {
						void openElevationResult(event.lngLat.lng, event.lngLat.lat);
					}
				});

				basemapStyle?.on('BasemapStyleError', (error) => {
					mapError = getErrorMessage(error);
				});
				basemapStyle?.on('BasemapStyleLoad', () => {
					syncViewerLayers();
				});
				// No-token fallback path: re-sync contextual layers when the free
				// basemap style (re)loads. Idempotent, so harmless in the token path.
				map.on('style.load', syncViewerLayers);

				map.on('error', (event: ErrorEvent) => {
					mapError = getErrorMessage(event.error);
				});

				map.on('remove', () => {
					for (const marker of markerLayers.values()) {
						marker.remove();
					}
					markerLayers.clear();
					for (const marker of routePlannerMarkers.values()) {
						marker.remove();
					}
					routePlannerMarkers.clear();
					unsubscribeActiveBasemapStyle();
					unsubscribeSatelliteBasemapEnabled();
					unsubscribeViewerLayers();
					unsubscribeProjectLayersVisible();
					unsubscribeServiceAreaEnabled();
					unsubscribeEnabledTravelModes();
					unsubscribeElevationQueryEnabled();
					unsubscribeLmvInteractionGate();
					unsubscribeSelectedSiteId?.();
					unsubscribeSelectedSearchLocation();
					unsubscribeRoutePlannerLocations();
					unsubscribeRoutePlannerMapPickTargetId();
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
	{#if hasArcgisToken}
		<button
			class="basemap-toggle-overlay"
			type="button"
			aria-pressed={isSatelliteBasemapActive}
			aria-label="Toggle satellite basemap"
			title={isSatelliteBasemapActive
				? 'Switch to selected basemap style'
				: 'Switch to satellite basemap'}
			onclick={toggleBasemapOverlay}
		>
			<span
				class="basemap-toggle-thumbnail"
				aria-hidden="true"
				style={`background-image: url('${base}${isSatelliteBasemapActive ? '/thumbnail_imagery.png' : '/thumbnail_basemap.png'}');`}
			></span>
		</button>
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

	.basemap-toggle-overlay {
		position: absolute;
		inset-inline-start: 1rem;
		bottom: 1rem;
		z-index: 3;
		display: grid;
		place-items: center;
		width: 4rem;
		height: 4rem;
		padding: 0.25rem;
		border: 2px solid rgb(255 255 255 / 90%);
		border-radius: 0.5rem;
		background: var(--calcite-color-surface-2);
		cursor: pointer;
		box-shadow: 0 2px 8px rgb(0 0 0 / 28%);
	}

	.basemap-toggle-overlay:focus-visible {
		outline: 2px solid var(--calcite-color-brand);
		outline-offset: 2px;
	}

	.basemap-toggle-thumbnail {
		display: block;
		width: 100%;
		height: 100%;
		border: 1px solid var(--calcite-color-border-2);
		border-radius: 0.35rem;
		background-color: rgb(0 0 0 / 10%);
		background-position: center;
		background-repeat: no-repeat;
		background-size: cover;
	}

	.map-host {
		position: absolute;
		inset: 0;
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

	:global(.route-stop-marker) {
		display: grid;
		place-items: center;
		width: 1.1rem;
		height: 1.1rem;
		border: 2px solid #ffffff;
		border-radius: 9999px;
		background: #0ea5e9;
		color: #ffffff;
		font-size: 0.65rem;
		font-weight: 700;
		box-shadow: 0 1px 4px rgb(0 0 0 / 35%);
	}
</style>
