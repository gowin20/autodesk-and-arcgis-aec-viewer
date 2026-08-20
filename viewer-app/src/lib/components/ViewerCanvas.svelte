<script lang="ts">
	import { onMount } from 'svelte';
	import { get } from 'svelte/store';
	import type {
		ErrorEvent,
		GeoJSONSource,
		GeoJSONSourceSpecification,
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
		resetViewerLayersForSite,
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
	import { currentSite, type SiteDefinition } from '$lib/state/sites';
	import { autodeskModelEnabled } from '$lib/state/autodesk-model';
	import { createLmvBridge, createMercatorModelPlacement } from '$lib/lmv/lmv-maplibre-bridge';
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
	let isSatelliteBasemapActive = $state(false);

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
		const initialSite = get(currentSite);
		let activeSite = initialSite;

		void (async () => {
			try {
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
					center: initialSite.coordinates,
					pitch: 60,
					maxPitch: 85,
					attributionControl: false,
					canvasContextAttributes: { antialias: true }
				});

				// ── LMV (APS Viewer) bridge: render Office.rvt into this map ──
				// MapLibre owns the camera/frame loop; LMV renders into the shared
				// WebGL context via a custom layer. Failures here must never break
				// the ArcGIS app, so everything is guarded.
				let unsubscribeAutodeskModelEnabled = () => {};
				let syncLmvSiteModel = (_site: SiteDefinition) => {};
				try {
					if (!lmvContainer) {
						throw new Error('LMV container is unavailable.');
					}
					const bridge = createLmvBridge({
						container: lmvContainer,
						modelPlacement: createMercatorModelPlacement({
							origin: initialSite.coordinates,
							altitude: 10,
							rotationDeg: 30,
							unitScale: 0.3048
						}),
						onStatus: (message) => (lmvStatus = message)
					});

					// Debug hooks (used by the browser probes).
					(window as unknown as Record<string, unknown>).__map = map;
					(window as unknown as Record<string, unknown>).__lmvBridge = bridge;
					let lmvLayerAttached = false;
					let pendingModelSync = false;
					let lmvModelSyncQueue: Promise<void> = Promise.resolve();
					let currentModelEnabled = get(autodeskModelEnabled);
					let currentSiteForModel = activeSite;
					let activeLoadedSiteId: string | null = null;

					const syncLmvModelVisibility = () => {
						lmvModelSyncQueue = lmvModelSyncQueue
							.then(async () => {
								if (!currentModelEnabled) {
									await bridge.unloadModel();
									activeLoadedSiteId = null;
									return;
								}

								if (activeLoadedSiteId !== currentSiteForModel.id) {
									await bridge.unloadModel();
									bridge.setModelPlacement(
										createMercatorModelPlacement({
											origin: currentSiteForModel.coordinates,
											altitude: 10,
											rotationDeg: 30,
											unitScale: 0.3048
										})
									);
									await bridge.loadModel(currentSiteForModel.modelUrn);
									activeLoadedSiteId = currentSiteForModel.id;
									return;
								}

								await bridge.loadModel(currentSiteForModel.modelUrn);
							})
							.catch((error: unknown) => {
								console.error('[LMV] Model visibility sync failed', error);
								lmvStatus =
									error instanceof Error ? error.message : 'LMV model visibility update failed.';
							});
					};
					const requestLmvModelVisibility = () => {
						if (!lmvLayerAttached) {
							pendingModelSync = true;
							return;
						}
						syncLmvModelVisibility();
					};

					const ensureLmvLayer = () => {
						if (!map) return;
						// Custom layers are dropped when the basemap style is swapped —
						// re-add on every style.load (bridge.onAdd is idempotent).
						if (!map.getLayer('lmv-model')) {
							map.addLayer(bridge.layer);
						}
						lmvLayerAttached = true;
						if (pendingModelSync) {
							pendingModelSync = false;
							syncLmvModelVisibility();
						}
					};
					map.on('style.load', ensureLmvLayer);
					if (map.isStyleLoaded()) ensureLmvLayer();
					syncLmvSiteModel = (site: SiteDefinition) => {
						currentSiteForModel = site;
						requestLmvModelVisibility();
					};
					unsubscribeAutodeskModelEnabled = autodeskModelEnabled.subscribe((enabled) => {
						currentModelEnabled = enabled;
						requestLmvModelVisibility();
					});
				} catch (error) {
					console.error('[LMV] Initialization failed', error);
					lmvStatus = 'LMV viewer unavailable.';
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
						essential: true,
						maxDuration: 1000
					});
				});
				const unsubscribeRoutePlannerLocations = routePlannerLocations.subscribe((locations) => {
					activeRoutePlannerLocations = locations;
					syncRoutePlannerRender();
				});
				const unsubscribeCurrentSite = currentSite.subscribe((site) => {
					activeSite = site;
					resetViewerLayersForSite(site.coordinates);
					syncLmvSiteModel(site);
					if (!map) return;
					map.flyTo({
						center: site.coordinates,
						zoom: Math.max(map.getZoom(), 16),
						essential: true
					});
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
					unsubscribeSelectedSearchLocation();
					unsubscribeRoutePlannerLocations();
					unsubscribeCurrentSite();
					unsubscribeRoutePlannerMapPickTargetId();
					unsubscribeAutodeskModelEnabled();
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
				style={`background-image: url('${isSatelliteBasemapActive ? '/thumbnail_imagery.png' : '/thumbnail_basemap.png'}');`}
			></span>
		</button>
	{/if}
	{#if lmvStatus && !mapError}
		<div class="lmv-status" role="status">{lmvStatus}</div>
	{/if}
	{#if mapError}
		<div class="status-message" role="alert">{mapError}</div>
	{/if}
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
