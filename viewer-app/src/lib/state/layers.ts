import type { GeoJSONSourceSpecification } from 'maplibre-gl';
import { get, writable } from 'svelte/store';
import type { PlaceDetails } from '$lib/arcgis/places';
import { CONTEXTUAL_LAYER_OPTIONS } from '$lib/state/contextual-layers';
import { selectedSiteId, siteCatalog, type Site } from '$lib/state/site-catalog';

const SERVICE_AREA_VIEWER_LAYER_ID = 'service-area-layer';
const SITE_LOCATION_VIEWER_LAYER_ID_PREFIX = 'site-location-';
const SITE_OUTLINE_VIEWER_LAYER_ID_PREFIX = 'site-outline-';
const PLACE_RESULT_VIEWER_LAYER_ID_PREFIX = 'place-result-';
const GEOCODE_RESULT_VIEWER_LAYER_ID = 'geocode-result-layer';
const ROUTING_RESULT_VIEWER_LAYER_ID = 'routing-results-layer';

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
	siteId: string;
	longitude: number;
	latitude: number;
	color: string;
}

export interface SiteOutlineViewerLayer {
	id: string;
	label: string;
	kind: 'site-outline';
	visible: boolean;
	siteId: string;
	color: string;
}

export interface PlaceResultViewerLayer {
	id: string;
	label: string;
	kind: 'place-result';
	visible: boolean;
	placeId: string;
	longitude: number;
	latitude: number;
	iconUrl?: string;
	details: PlaceDetails;
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

export interface RoutingResultViewerLayer {
	id: string;
	label: string;
	kind: 'routing-result';
	visible: boolean;
	data: GeoJSONSourceSpecification['data'];
}

export type ViewerLayer =
	| ContextualViewerLayer
	| ServiceAreaViewerLayer
	| SiteLocationViewerLayer
	| SiteOutlineViewerLayer
	| PlaceResultViewerLayer
	| GeocodeResultViewerLayer
	| ElevationResultViewerLayer
	| RoutingResultViewerLayer;

const getSiteLocationLayerId = (siteId: string): string => `${SITE_LOCATION_VIEWER_LAYER_ID_PREFIX}${siteId}`;
const getSiteOutlineLayerId = (siteId: string): string => `${SITE_OUTLINE_VIEWER_LAYER_ID_PREFIX}${siteId}`;
const getPlaceResultLayerId = (placeId: string): string => `${PLACE_RESULT_VIEWER_LAYER_ID_PREFIX}${placeId}`;

const getSiteColor = (site: Pick<Site, 'lon' | 'lat'>): string => {
	const coordinateKey = `${site.lon.toFixed(8)},${site.lat.toFixed(8)}`;
	let hash = 2166136261;
	for (const character of coordinateKey) {
		hash ^= character.charCodeAt(0);
		hash = Math.imul(hash, 16777619);
	}

	const unsignedHash = hash >>> 0;
	const hue = unsignedHash % 360;
	const saturation = 68 + ((unsignedHash >>> 9) % 18);
	const lightness = 40 + ((unsignedHash >>> 17) % 12);
	return `hsl(${hue}, ${saturation}%, ${lightness}%)`;
};

const createSiteLocationLayer = (
	site: Pick<Site, 'id' | 'name' | 'lon' | 'lat'>
): SiteLocationViewerLayer => ({
	id: getSiteLocationLayerId(site.id),
	label: site.name,
	kind: 'site-location',
	visible: true,
	siteId: site.id,
	longitude: site.lon,
	latitude: site.lat,
	color: getSiteColor(site)
});

const createSiteOutlineLayer = (
	site: Pick<Site, 'id' | 'name' | 'lon' | 'lat'>
): SiteOutlineViewerLayer => ({
	id: getSiteOutlineLayerId(site.id),
	label: `${site.name} boundary`,
	kind: 'site-outline',
	visible: true,
	siteId: site.id,
	color: getSiteColor(site)
});

export const viewerLayers = writable<ViewerLayer[]>([]);
export const projectLayersVisible = writable(true);

let hasSelectedSite = false;

const syncSelectedSiteLocationLayer = () => {
	const sites = get(siteCatalog);
	const selectedSiteIdValue = get(selectedSiteId);
	if (selectedSiteIdValue) {
		hasSelectedSite = true;
	}
	const selectedSite = sites.find((site) => site.id === selectedSiteIdValue);
	viewerLayers.set(
		selectedSite
			? [createSiteLocationLayer(selectedSite), createSiteOutlineLayer(selectedSite)]
			: hasSelectedSite
				? []
				: sites.map((site) => createSiteLocationLayer(site))
	);
};

selectedSiteId.subscribe(syncSelectedSiteLocationLayer);
siteCatalog.subscribe(syncSelectedSiteLocationLayer);

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

export const addPlaceResultViewerLayer = (place: {
	placeId: string;
	label: string;
	longitude: number;
	latitude: number;
	details: PlaceDetails;
}) => {
	viewerLayers.update((layers) => {
		const nextLayer: PlaceResultViewerLayer = {
			id: getPlaceResultLayerId(place.placeId),
			label: place.details.name ?? place.label,
			kind: 'place-result',
			visible: true,
			placeId: place.placeId,
			longitude: place.longitude,
			latitude: place.latitude,
			iconUrl: place.details.icon?.url,
			details: place.details
		};
		const existingLayerIndex = layers.findIndex((layer) => layer.id === nextLayer.id);
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

export const upsertRoutingResultViewerLayer = (data: GeoJSONSourceSpecification['data']) => {
	viewerLayers.update((layers) => {
		const nextLayer: RoutingResultViewerLayer = {
			id: ROUTING_RESULT_VIEWER_LAYER_ID,
			label: 'Routing results layer',
			kind: 'routing-result',
			visible: true,
			data
		};
		const existingLayerIndex = layers.findIndex((layer) => layer.id === ROUTING_RESULT_VIEWER_LAYER_ID);
		if (existingLayerIndex === -1) {
			return [...layers, nextLayer];
		}

		const nextLayers = [...layers];
		nextLayers[existingLayerIndex] = nextLayer;
		return nextLayers;
	});
};

export const removeRoutingResultViewerLayer = () => {
	viewerLayers.update((layers) => {
		const hasRoutingResultLayer = layers.some((layer) => layer.id === ROUTING_RESULT_VIEWER_LAYER_ID);
		if (!hasRoutingResultLayer) {
			return layers;
		}
		return layers.filter((layer) => layer.id !== ROUTING_RESULT_VIEWER_LAYER_ID);
	});
};

export const clearViewerLayers = () => {
	viewerLayers.set([]);
};
