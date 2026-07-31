import { geocode, reverseGeocode, suggest, type IGeocodeResponse, type IReverseGeocodeResponse, type ISuggestResponse } from '@esri/arcgis-rest-geocoding';
import { ArcGISIdentityManager, type ILocation, type IPoint } from '@esri/arcgis-rest-request';

const arcgisAccessToken =
	import.meta.env.VITE_ARCGIS_ACCESS_TOKEN?.trim() ??
	import.meta.env.PUBLIC_ARCGIS_ACCESS_TOKEN?.trim() ??
	'';

const authentication = arcgisAccessToken
	? ArcGISIdentityManager.fromToken({
			token: arcgisAccessToken
		})
	: undefined;

type Suggestion = ISuggestResponse['suggestions'][number];
type AddressCandidate = IGeocodeResponse['candidates'][number];
type ReverseGeocodeLocation = IPoint | ILocation | [number, number];

const getRequestOptions = (location?: string) => ({
	...(authentication ? { authentication } : {}),
	...(location ? { params: { location } } : {})
});

// Autosuggest geocoding results
export const findSuggestions = async (
	query: string | null | undefined,
	center: { lng: number; lat: number } | null | undefined
): Promise<Suggestion[] | undefined> => {
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
		...(authentication ? { authentication } : {})
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
	if (!response.address || !response.location) return null;

	return response;
};
