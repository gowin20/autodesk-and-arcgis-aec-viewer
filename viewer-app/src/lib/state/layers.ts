import type { GeoJSONSourceSpecification } from 'maplibre-gl';
import { writable } from 'svelte/store';
import { CONTEXTUAL_LAYER_OPTIONS } from '$lib/state/contextual-layers';

const DEFAULT_SITE_LOCATION_COORDINATES: [number, number] = [-79.88666527, 40.022371938];
const SERVICE_AREA_VIEWER_LAYER_ID = 'service-area-layer';
const SITE_LOCATION_VIEWER_LAYER_ID = 'site-location-layer';
const GEOCODE_RESULT_VIEWER_LAYER_ID = 'geocode-result-layer';

export interface ContextualViewerLayer {
	id: string;
	label: string;
	kind: 'contextual';
	visible: boolean;
	contextualLayerId: string;
}

export interface ServiceAreaViewerLayer {
	id: string;
	label: string;
	kind: 'service-area';
	visible: boolean;
	data: GeoJSONSourceSpecification['data'];
}

export interface SiteLocationViewerLayer {
	id: string;
	label: string;
	kind: 'site-location';
	visible: boolean;
	longitude: number;
	latitude: number;
}

export interface GeocodeResultViewerLayer {
	id: string;
	label: string;
	kind: 'geocode-result';
	visible: boolean;
	longitude: number;
	latitude: number;
	locationLabel: string;
}

export interface ElevationResultViewerLayer {
	id: string;
	label: string;
	kind: 'elevation-result';
	visible: boolean;
	longitude: number;
	latitude: number;
	elevationMeters: number;
	elevationFeet: number;
}

export type ViewerLayer =
	| ContextualViewerLayer
	| ServiceAreaViewerLayer
	| SiteLocationViewerLayer
	| GeocodeResultViewerLayer
	| ElevationResultViewerLayer;

const createDefaultSiteLocationLayer = (): SiteLocationViewerLayer => ({
	id: SITE_LOCATION_VIEWER_LAYER_ID,
	label: 'Site location',
	kind: 'site-location',
	visible: true,
	longitude: DEFAULT_SITE_LOCATION_COORDINATES[0],
	latitude: DEFAULT_SITE_LOCATION_COORDINATES[1]
});

export const viewerLayers = writable<ViewerLayer[]>([createDefaultSiteLocationLayer()]);
export const projectLayersVisible = writable(true);

export const addContextualViewerLayer = (contextualLayerId: string) => {
	const contextualLayer = CONTEXTUAL_LAYER_OPTIONS.find((layer) => layer.id === contextualLayerId);
	if (!contextualLayer) return;

	viewerLayers.update((layers) => {
		if (layers.some((layer) => layer.kind === 'contextual' && layer.contextualLayerId === contextualLayerId)) {
			return layers;
		}
		return [
			...layers,
			{
				id: `contextual-${contextualLayer.id}`,
				label: contextualLayer.label,
				kind: 'contextual',
				visible: true,
				contextualLayerId: contextualLayer.id
			}
		];
	});
};

export const toggleViewerLayerVisibility = (layerId: string) => {
	viewerLayers.update((layers) =>
		layers.map((layer) => (layer.id === layerId ? { ...layer, visible: !layer.visible } : layer))
	);
};

export const removeViewerLayer = (layerId: string) => {
	viewerLayers.update((layers) => layers.filter((layer) => layer.id !== layerId));
};

export const upsertServiceAreaViewerLayer = (data: GeoJSONSourceSpecification['data']) => {
	viewerLayers.update((layers) => {
		const nextLayer: ServiceAreaViewerLayer = {
			id: SERVICE_AREA_VIEWER_LAYER_ID,
			label: 'Service area result',
			kind: 'service-area',
			visible: true,
			data
		};
		const existingLayerIndex = layers.findIndex((layer) => layer.id === SERVICE_AREA_VIEWER_LAYER_ID);
		if (existingLayerIndex === -1) {
			return [...layers, nextLayer];
		}

		const nextLayers = [...layers];
		nextLayers[existingLayerIndex] = nextLayer;
		return nextLayers;
	});
};

export const upsertGeocodeResultViewerLayer = (location: {
	longitude: number;
	latitude: number;
	label: string;
}) => {
	viewerLayers.update((layers) => {
		const nextLayer: GeocodeResultViewerLayer = {
			id: GEOCODE_RESULT_VIEWER_LAYER_ID,
			label: 'Geocoding result',
			kind: 'geocode-result',
			visible: true,
			longitude: location.longitude,
			latitude: location.latitude,
			locationLabel: location.label
		};
		const existingLayerIndex = layers.findIndex((layer) => layer.id === GEOCODE_RESULT_VIEWER_LAYER_ID);
		if (existingLayerIndex === -1) {
			return [...layers, nextLayer];
		}

		const nextLayers = [...layers];
		nextLayers[existingLayerIndex] = nextLayer;
		return nextLayers;
	});
};

export const addElevationResultViewerLayer = (result: {
	longitude: number;
	latitude: number;
	elevationMeters: number;
	elevationFeet: number;
}) => {
	viewerLayers.update((layers) => {
		const existingElevationLayerCount = layers.filter((layer) => layer.kind === 'elevation-result').length;
		const elevationLayerNumber = existingElevationLayerCount + 1;
		return [
			...layers,
			{
				id: `elevation-result-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
				label: `Elevation result ${elevationLayerNumber}`,
				kind: 'elevation-result',
				visible: true,
				longitude: result.longitude,
				latitude: result.latitude,
				elevationMeters: result.elevationMeters,
				elevationFeet: result.elevationFeet
			}
		];
	});
};

export const resetViewerLayers = () => {
	viewerLayers.set([createDefaultSiteLocationLayer()]);
	projectLayersVisible.set(true);
};
