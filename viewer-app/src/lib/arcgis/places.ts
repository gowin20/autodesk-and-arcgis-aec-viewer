import {
	IconOptions,
	findPlacesNearPoint,
	findPlacesWithinExtent,
	getPlaceDetails,
	type IFindPlacesNearPointResponse,
	type IFindPlacesWithinExtentResponse
} from '@esri/arcgis-rest-places';
import { ApiKeyManager } from '@esri/arcgis-rest-request';
import type { Map as MaplibreMap } from 'maplibre-gl';

const arcgisAccessToken =
	import.meta.env.VITE_ARCGIS_ACCESS_TOKEN?.trim() ??
	import.meta.env.PUBLIC_ARCGIS_ACCESS_TOKEN?.trim() ??
	'';

const authentication = arcgisAccessToken
	? ApiKeyManager.fromKey(arcgisAccessToken)
	: undefined;

type PlaceQueryObject = {
	searchText?: string;
	placeType?: {
		categoryIds?: string[];
	};
};

export type PlaceSearchQuery = string | string[] | PlaceQueryObject;
export type PlaceResult = IFindPlacesWithinExtentResponse['results'][number];
export type NearbyPlaceResult = IFindPlacesNearPointResponse['results'][number];
export type PlaceDetails = Awaited<ReturnType<typeof getPlaceDetails>>['placeDetails'];

const getSearchCriteria = (
	query: PlaceSearchQuery
): {
	searchText?: string;
	categoryIds?: string[];
} => {
	if (typeof query === 'string') {
		return { searchText: query };
	}

	if (Array.isArray(query)) {
		return { categoryIds: query };
	}

	return {
		searchText: query.searchText,
		categoryIds: query.placeType?.categoryIds
	};
};

const getExtent = (map: MaplibreMap) => {
	const bounds = map.getBounds();
	const topRight = bounds.getNorthEast();
	const bottomLeft = bounds.getSouthWest();

	return {
		xmin: bottomLeft.lng,
		ymin: bottomLeft.lat,
		xmax: topRight.lng,
		ymax: topRight.lat
	};
};

// Get places in a bounding box
// This function is not currently being used as ArcGIS REST JS has yet to add support for the `icon` param added last week
// Once it does, you can simply add the `icon:\'png\'` to the param list and replace `fetchPlacesRaw` with this function for identical behavior.
export const fetchPlaces = async (
	query: PlaceSearchQuery | null | undefined,
	map: MaplibreMap
): Promise<PlaceResult[] | undefined> => {
	if (!query) return undefined;

	console.log('findPlacesWithinExtent request:' + query);

	const extent = getExtent(map);
	const criteria = getSearchCriteria(query);
	const response = await findPlacesWithinExtent({
		...extent,
		...criteria,
		pageSize: 20,
		icon: IconOptions.PNG,
		...(authentication ? { authentication } : {})
	});
	return response.results;
};

export const fetchPlacesNearby = async (
	query: PlaceSearchQuery | null | undefined,
	center: { lng: number; lat: number },
	radius = 750
): Promise<NearbyPlaceResult[] | undefined> => {
	if (!query) return undefined;

	console.log('findPlacesNearPoint request:', query);
	const criteria = getSearchCriteria(query);
	const response = await findPlacesNearPoint({
		x: center.lng,
		y: center.lat,
		...criteria,
		radius,
		pageSize: 20,
		icon: IconOptions.PNG,
		...(authentication ? { authentication } : {})
	});
	return response.results;
};

// A version of the request that uses `fetch()` instead of ArcGIS REST JS
export const fetchPlacesRaw = async (
	query: PlaceSearchQuery | null | undefined,
	map: MaplibreMap
): Promise<PlaceResult[] | null | undefined> => {
	if (!query) return undefined;
	if (!arcgisAccessToken) {
		throw new Error(
			'Set VITE_ARCGIS_ACCESS_TOKEN (or PUBLIC_ARCGIS_ACCESS_TOKEN) to call the ArcGIS Places API.'
		);
	}

	console.log('findPlacesWithinExtent request (using fetch):' + query);

	const extent = getExtent(map);
	const criteria = getSearchCriteria(query);

	const endpoint = new URL(
		'https://places-api.arcgis.com/arcgis/rest/services/places-service/v1/places/within-extent'
	);
	endpoint.searchParams.set('token', arcgisAccessToken);
	endpoint.searchParams.set('xmin', `${extent.xmin}`);
	endpoint.searchParams.set('ymin', `${extent.ymin}`);
	endpoint.searchParams.set('xmax', `${extent.xmax}`);
	endpoint.searchParams.set('ymax', `${extent.ymax}`);
	endpoint.searchParams.set('pageSize', '20');
	endpoint.searchParams.set('icon', 'png');

	if (criteria.searchText) {
		endpoint.searchParams.set('searchText', criteria.searchText);
	}
	if (criteria.categoryIds && criteria.categoryIds.length > 0) {
		endpoint.searchParams.set('categoryIds', criteria.categoryIds.join(','));
	}

	const fetchResponse = await fetch(endpoint.toString());
	if (!fetchResponse.ok) {
		throw new Error(`ArcGIS Places request failed with status ${fetchResponse.status}.`);
	}
	const response = (await fetchResponse.json()) as IFindPlacesWithinExtentResponse;

	if (response.results.length === 0) return null;
	return response.results;
};

// Fetch details about a place
export const fetchPlaceDetails = async (placeId: string): Promise<PlaceDetails> => {
	console.log('placeDetails request:', placeId);

	const result = await getPlaceDetails({
		placeId,
		requestedFields: ['contactInfo:website', 'hours:opening', 'address:streetAddress', 'name'],
		icon: IconOptions.PNG,
		...(authentication ? { authentication } : {})
	});
	return result.placeDetails;
};
