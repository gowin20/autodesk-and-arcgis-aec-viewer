<script lang="ts">
	import { onMount } from 'svelte';
	import type {
		ErrorEvent,
		GeoJSONSource,
		GeoJSONSourceSpecification,
		Map as MaplibreMap
	} from 'maplibre-gl';
	import { getElevationAtLocation } from '$lib/arcgis/elevation';
	import { fetchServiceArea, type ServiceAreaParameters } from '$lib/arcgis/routing';
	import { DEFAULT_BASEMAP_STYLE, selectedBasemapStyle } from '$lib/state/basemap-style';
	import { CONTEXTUAL_LAYER_OPTIONS, selectedContextualLayerIds } from '$lib/state/contextual-layers';
	import {
		elevationQueryEnabled,
		mapCenter,
		selectedSearchLocation,
		serviceAreaEnabled,
		serviceAreaTravelMode
	} from '$lib/state/location-services';
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

	// Office.rvt on the APS sample server, geo-pinned at Brownsville, PA.
	const DEFAULT_LMV_URN =
		'dXJuOmFkc2sub2JqZWN0czpvcy5vYmplY3Q6c2FtcGxlbW9kZWxzL09mZmljZS5ydnQ=';
	const MODEL_ORIGIN: [number, number] = [-79.88666527, 40.022371938];

	const getErrorMessage = (error: unknown): string =>
		error instanceof Error ? error.message : 'Map failed to load.';
	const getServiceAreaTravelModeLabel = (travelMode: ServiceAreaParameters['travelMode']): string =>
		travelMode === 'walking' ? 'Walking' : 'Driving';

	onMount(() => {
		if (!mapContainer) {
			mapError = 'Map container is unavailable.';
			return;
		}

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
					center: MODEL_ORIGIN,
					pitch: 60,
					maxPitch: 85,
					attributionControl: false,
					canvasContextAttributes: { antialias: true }
				});
				new maplibregl.Marker({ draggable: false }).setLngLat(MODEL_ORIGIN).addTo(map);

				// ── LMV (APS Viewer) bridge: render Office.rvt into this map ──
				// MapLibre owns the camera/frame loop; LMV renders into the shared
				// WebGL context via a custom layer. Failures here must never break
				// the ArcGIS app, so everything is guarded.
				let lmvModelStarted = false;
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

					const ensureLmvLayer = () => {
						if (!map) return;
						// Custom layers are dropped when the basemap style is swapped —
						// re-add on every style.load (bridge.onAdd is idempotent).
						if (!map.getLayer('lmv-model')) {
							map.addLayer(bridge.layer);
						}
						if (!lmvModelStarted) {
							lmvModelStarted = true;
							void bridge.loadModel(DEFAULT_LMV_URN).catch((error: unknown) => {
								console.error('[LMV] Model load failed', error);
								lmvStatus = 'LMV model failed to load.';
							});
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
				let activeServiceAreaTravelMode: ServiceAreaParameters['travelMode'] = 'driving';
				let isElevationQueryEnabled = false;
				let latestServiceAreaData: GeoJSONSourceSpecification['data'] | undefined;
				const contextualFeatureLayers = new Map<
					string,
					Awaited<ReturnType<typeof FeatureLayer.fromUrl>>
				>();
				const contextualLayerConfigById = new Map(
					CONTEXTUAL_LAYER_OPTIONS.map((layer) => [layer.id, layer] as const)
				);
				let activeServiceAreaPopup: InstanceType<typeof maplibregl.Popup> | undefined;
				let searchResultMarker: InstanceType<typeof maplibregl.Marker> | undefined;
				const SERVICE_AREA_SOURCE_ID = 'service-area-result';
				const SERVICE_AREA_FILL_LAYER_ID = 'service-area-fill';
				const SERVICE_AREA_OUTLINE_LAYER_ID = 'service-area-outline';

				const renderServiceArea = (data: GeoJSONSourceSpecification['data']) => {
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
						const elevationMeters = response.result.point.z;
						const elevationFeet = elevationMeters * 3.28084;
						popupContent.innerHTML = `
							<calcite-panel heading="Elevation" description="ArcGIS Elevation service">
								<calcite-block open heading="${elevationMeters.toLocaleString()} m">
									<p>${elevationFeet.toLocaleString(undefined, { maximumFractionDigits: 0 })} ft above mean sea level</p>
									<p>Longitude: ${longitude.toFixed(5)}</p>
									<p>Latitude: ${latitude.toFixed(5)}</p>
								</calcite-block>
							</calcite-panel>
						`;
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
							<p>Travel mode: ${getServiceAreaTravelModeLabel(activeServiceAreaTravelMode)}</p>
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
					const directionSelect = popupContent.querySelector('#service-area-direction') as
						| (HTMLElement & { value: ServiceAreaParameters['travelDirection'] })
						| null;
					const runButton = popupContent.querySelector('#service-area-run') as
						| (HTMLElement & { loading: boolean; disabled: boolean })
						| null;
					const status = popupContent.querySelector('#service-area-status');
					const getBreakUnitsLabel = () =>
						impedanceSelect?.value === 'distance' ? 'kilometers' : 'minutes';
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
						runButton.loading = true;
						runButton.disabled = true;
						status.textContent = `Calculating service area (${breakUnitsLabel})...`;
						void fetchServiceArea([longitude, latitude], {
							breakValue,
							impedance: impedanceSelect.value,
							travelDirection: directionSelect.value,
							travelMode: activeServiceAreaTravelMode
						})
							.then((response) => {
								const data = response.saPolygons?.geoJson as
									| GeoJSONSourceSpecification['data']
									| undefined;
								if (!data) throw new Error('The service returned no service-area polygons.');

								latestServiceAreaData = data;
								renderServiceArea(data);
								status.textContent = `${getServiceAreaTravelModeLabel(activeServiceAreaTravelMode)} service area (${breakValue} ${breakUnitsLabel}) calculated at ${longitude.toFixed(5)}, ${latitude.toFixed(5)}.`;
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

					if (latestServiceAreaData) renderServiceArea(latestServiceAreaData);

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
					if (map) map.getCanvas().style.cursor = enabled ? 'crosshair' : '';
					if (!enabled && !isElevationQueryEnabled) {
						activeServiceAreaPopup?.remove();
						activeServiceAreaPopup = undefined;
					}
				});
				const unsubscribeServiceAreaTravelMode = serviceAreaTravelMode.subscribe((travelMode) => {
					activeServiceAreaTravelMode = travelMode;
				});
				const unsubscribeElevationQueryEnabled = elevationQueryEnabled.subscribe((enabled) => {
					isElevationQueryEnabled = enabled;
					if (map) map.getCanvas().style.cursor = enabled ? 'crosshair' : '';
					if (!enabled && !isServiceAreaEnabled) {
						activeServiceAreaPopup?.remove();
						activeServiceAreaPopup = undefined;
					}
				});
				const unsubscribeSelectedSearchLocation = selectedSearchLocation.subscribe((location) => {
					if (!location || !map) return;

					searchResultMarker?.remove();
					searchResultMarker = new maplibregl.Marker({ color: '#007ac2' })
						.setLngLat([location.longitude, location.latitude])
						.setPopup(new maplibregl.Popup().setText(location.label))
						.addTo(map);
					map.flyTo({
						center: [location.longitude, location.latitude],
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
				syncContextualLayerVisibility();
				map.on('click', (event) => {
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
					unsubscribeServiceAreaTravelMode();
					unsubscribeElevationQueryEnabled();
					unsubscribeSelectedSearchLocation();
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
</style>
