import {
	serviceArea,
	solveRoute,
	type IServiceAreaResponse,
	type ISolveRouteResponse
} from '@esri/arcgis-rest-routing';
import { request, type IFeatureSet, type ILocation, type IPoint } from '@esri/arcgis-rest-request';
import { arcgisAuthentication } from './authentication';

type RouteStop = IPoint | ILocation | [number, number] | [number, number, number];
type RouteStops = [RouteStop, RouteStop, ...RouteStop[]] | IFeatureSet;

export interface RouteSolveOptions {
	travelMode?: ServiceAreaTravelModeObject;
	findBestSequence?: boolean;
	returnStops?: boolean;
}

export const fetchRoute = async (
	stops: RouteStops,
	options: RouteSolveOptions = {}
): Promise<ISolveRouteResponse> => {
	if (!arcgisAuthentication) {
		throw new Error('An ArcGIS access token is required to calculate route directions.');
	}

	return solveRoute({
		stops,
		authentication: arcgisAuthentication,
		params: {
			returnRoutes: true,
			returnDirections: true,
			directionsOutputType: 'esriDOTComplete',
			outputLines: 'esriNAOutputLineTrueShape',
			...(typeof options.findBestSequence === 'boolean'
				? { findBestSequence: options.findBestSequence }
				: {}),
			...(typeof options.returnStops === 'boolean' ? { returnStops: options.returnStops } : {}),
			...(options.travelMode ? { travelMode: JSON.stringify(options.travelMode) } : {})
		}
	});
};

export type ServiceAreaImpedance = 'time' | 'distance';
export type ServiceAreaTravelModeKey = 'driving' | 'walking';
export type ServiceAreaTravelModeObject = Record<string, unknown> & { name?: string };

export interface EnabledTravelModes {
	driving?: ServiceAreaTravelModeObject;
	walking?: ServiceAreaTravelModeObject;
	supportedTravelModes: ServiceAreaTravelModeObject[];
}

type RetrieveTravelModesResponse = {
	supportedTravelModes?: ServiceAreaTravelModeObject[];
};

const SERVICE_AREA_RETRIEVE_TRAVEL_MODES_ENDPOINT =
	'https://route.arcgis.com/arcgis/rest/services/World/ServiceAreas/NAServer/ServiceArea_World/retrieveTravelModes';

export interface ServiceAreaParameters {
	breakValue: number;
	impedance: ServiceAreaImpedance;
	travelDirection: 'facilitiesToIncidents' | 'incidentsToFacilities';
	travelMode: ServiceAreaTravelModeObject;
}

export const fetchEnabledTravelModes = async (): Promise<EnabledTravelModes> => {
	if (!arcgisAuthentication) {
		throw new Error('An ArcGIS access token is required to retrieve travel modes.');
	}

	const response = (await request(SERVICE_AREA_RETRIEVE_TRAVEL_MODES_ENDPOINT, {
		authentication: arcgisAuthentication,
		params: { f: 'json' }
	})) as RetrieveTravelModesResponse;
	const supportedTravelModes = response.supportedTravelModes ?? [];
	const driving = supportedTravelModes.find((mode) => mode.name === 'Driving Time');
	const walking = supportedTravelModes.find((mode) => mode.name === 'Walking Time');

	return {
		driving,
		walking,
		supportedTravelModes
	};
};

export const fetchServiceArea = async (
	location: [number, number],
	parameters: ServiceAreaParameters
): Promise<IServiceAreaResponse> => {
	if (!arcgisAuthentication) {
		throw new Error('An ArcGIS access token is required to calculate a service area.');
	}

	if (!Number.isFinite(parameters.breakValue) || parameters.breakValue <= 0) {
		throw new Error('The service-area break must be greater than zero.');
	}

	if (!parameters.travelMode || typeof parameters.travelMode !== 'object') {
		throw new Error('The service-area travel mode is invalid.');
	}

	return serviceArea({
		facilities: [location],
		travelDirection: parameters.travelDirection,
		authentication: arcgisAuthentication,
		params: {
			defaultBreaks: String(parameters.breakValue),
			impedanceAttributeName:
				parameters.impedance === 'time' ? 'TravelTime' : 'Kilometers',
			travelMode: JSON.stringify(parameters.travelMode),
			outputSpatialReference: 4326,
			polygonType: 'esriNAServiceAreaPolygonDetailed',
			mergeSimilarPolygonRanges: true,
			returnFacilities: false,
			returnBarriers: false,
			returnPolylineBarriers: false,
			returnPolygonBarriers: false
		}
	});
};
