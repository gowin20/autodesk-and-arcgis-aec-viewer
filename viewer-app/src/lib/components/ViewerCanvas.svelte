<script lang="ts">
	import { onMount } from 'svelte';
	import type { ErrorEvent, GeoJSONSourceSpecification, Map as MaplibreMap } from 'maplibre-gl';
	import { DEFAULT_BASEMAP_STYLE, selectedBasemapStyle } from '$lib/state/basemap-style';
	import { CONTEXTUAL_LAYER_OPTIONS, selectedContextualLayerIds } from '$lib/state/contextual-layers';
	import 'maplibre-gl/dist/maplibre-gl.css';

	const arcgisToken =
		import.meta.env.VITE_ARCGIS_ACCESS_TOKEN?.trim() ??
		import.meta.env.PUBLIC_ARCGIS_ACCESS_TOKEN?.trim() ??
		'';
	const hasArcgisToken = arcgisToken.length > 0;

	let mapContainer: HTMLDivElement | undefined;
	let map: MaplibreMap | undefined;
	let mapError = $state<string | null>(null);

	const getErrorMessage = (error: unknown): string =>
		error instanceof Error ? error.message : 'Map failed to load.';

	onMount(() => {
		if (!hasArcgisToken) {
			mapError =
				'Set VITE_ARCGIS_ACCESS_TOKEN (or PUBLIC_ARCGIS_ACCESS_TOKEN) in your environment to load the ArcGIS basemap style.';
			return;
		}

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
					zoom: 13,
					center: [-79.88676, 40.0224],
					attributionControl: false
				});
				new maplibregl.Marker({ draggable: false }).setLngLat([-79.88676, 40.0224]).addTo(map);

				const basemapStyle = BasemapStyle.applyStyle(map, {
					style: DEFAULT_BASEMAP_STYLE,
					token: arcgisToken,
					preferences: {
						language: 'en',
						worldview: 'unitedStatesOfAmerica'
					}
				});
				let activeStyleId = DEFAULT_BASEMAP_STYLE;
				let activeContextualLayerIds: string[] = [];
				const contextualFeatureLayers = new Map<
					string,
					Awaited<ReturnType<typeof FeatureLayer.fromUrl>>
				>();
				const contextualLayerConfigById = new Map(
					CONTEXTUAL_LAYER_OPTIONS.map((layer) => [layer.id, layer] as const)
				);

				const unsubscribeSelectedBasemapStyle = selectedBasemapStyle.subscribe((styleId) => {
					if (styleId === activeStyleId) {
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
				};
				const unsubscribeSelectedContextualLayerIds = selectedContextualLayerIds.subscribe((layerIds) => {
					activeContextualLayerIds = layerIds;
					syncContextualLayerVisibility();
				});

				for (const contextualLayer of CONTEXTUAL_LAYER_OPTIONS) {
					const featureLayer = await FeatureLayer.fromUrl(contextualLayer.url, {
						token: arcgisToken
					});
					contextualFeatureLayers.set(contextualLayer.id, featureLayer);
				}
				syncContextualLayerVisibility();

				basemapStyle.on('BasemapStyleError', (error) => {
					mapError = getErrorMessage(error);
				});
				basemapStyle.on('BasemapStyleLoad', () => {
					syncContextualLayerVisibility();
				});

				map.on('error', (event: ErrorEvent) => {
					mapError = getErrorMessage(event.error);
				});

				map.on('remove', () => {
					unsubscribeSelectedBasemapStyle();
					unsubscribeSelectedContextualLayerIds();
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
		color: var(--calcite-color-text-1);
		font-size: var(--calcite-font-size--1);
		box-shadow: 0 2px 8px rgb(0 0 0 / 12%);
	}
</style>
