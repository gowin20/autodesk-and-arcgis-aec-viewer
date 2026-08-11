import {
	serviceArea,
	solveRoute,
	type IServiceAreaResponse,
	type ISolveRouteResponse
} from '@esri/arcgis-rest-routing';
import type { IFeatureSet, ILocation, IPoint } from '@esri/arcgis-rest-request';
import { arcgisAuthentication } from './authentication';

type RouteStop = IPoint | ILocation | [number, number] | [number, number, number];
type RouteStops = [RouteStop, RouteStop, ...RouteStop[]] | IFeatureSet;

export const fetchRoute = async (
	startCoords: RouteStop,
	endCoords: RouteStop
): Promise<ISolveRouteResponse> => {
	const stops: RouteStops = [startCoords, endCoords];

	return solveRoute({
		stops,
		...(arcgisAuthentication ? { authentication: arcgisAuthentication } : {})
	});
};

export type ServiceAreaImpedance = 'time' | 'distance';
export type ServiceAreaTravelMode = 'driving' | 'walking';

const SERVICE_AREA_TRAVEL_MODE_NAMES: Record<ServiceAreaTravelMode, string> = {
	driving: 'Driving Time',
	walking: 'Walking Time'
};

export interface ServiceAreaParameters {
	breakValue: number;
	impedance: ServiceAreaImpedance;
	travelDirection: 'facilitiesToIncidents' | 'incidentsToFacilities';
	travelMode: ServiceAreaTravelMode;
}

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

	const travelModeName = SERVICE_AREA_TRAVEL_MODE_NAMES[parameters.travelMode];
	if (!travelModeName) {
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
			travelMode: travelModeName,
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
