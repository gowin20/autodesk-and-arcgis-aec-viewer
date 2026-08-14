import { geocode, reverseGeocode, suggest, type IGeocodeResponse, type IReverseGeocodeResponse, type ISuggestResponse } from '@esri/arcgis-rest-geocoding';
import type { ILocation, IPoint } from '@esri/arcgis-rest-request';
import { arcgisAuthentication } from './authentication';

export type GeocodeSuggestion = ISuggestResponse['suggestions'][number];
export type AddressCandidate = IGeocodeResponse['candidates'][number];
type ReverseGeocodeLocation = IPoint | ILocation | [number, number];

const getRequestOptions = (location?: string) => ({
	...(arcgisAuthentication ? { authentication: arcgisAuthentication } : {}),
	...(location ? { params: { location } } : {})
});

// Autosuggest geocoding results
export const findSuggestions = async (
	query: string | null | undefined,
	center: { lng: number; lat: number } | null | undefined
): Promise<GeocodeSuggestion[] | undefined> => {
	if (!query || !center) return undefined;

	const response = await suggest(query, getRequestOptions(`${center.lng},${center.lat}`));
	return response.suggestions;
};

// Perform a forward geocode
export const getAddressCandidate = async (
	text: string | null | undefined,
	key: string | null | undefined
): Promise<AddressCandidate | null | undefined> => {
	if (!text && !key) return undefined;

	console.log('Geocode request:', text);

	const response = await geocode({
		singleLine: text ?? undefined,
		magicKey: key ?? undefined,
		...(arcgisAuthentication ? { authentication: arcgisAuthentication } : {})
	});

	if (response.candidates.length > 0) return response.candidates[0];
	return null;
};

// Perform a reverse geocode
export const getReverseGeocode = async (
	location: ReverseGeocodeLocation | null | undefined
): Promise<IReverseGeocodeResponse | null | undefined> => {
	if (!location) return undefined;

	console.log('Reverse geocode request: ', location);

	const response = await reverseGeocode(location, getRequestOptions());
	if (!response.address) return null;

	return response;
};
