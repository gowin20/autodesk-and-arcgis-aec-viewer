import { solveRoute, type ISolveRouteResponse } from '@esri/arcgis-rest-routing';
import { ArcGISIdentityManager, type IFeatureSet, type ILocation, type IPoint } from '@esri/arcgis-rest-request';

const arcgisAccessToken =
	import.meta.env.VITE_ARCGIS_ACCESS_TOKEN?.trim() ??
	import.meta.env.PUBLIC_ARCGIS_ACCESS_TOKEN?.trim() ??
	'';

const authentication = arcgisAccessToken
	? ArcGISIdentityManager.fromToken({
			token: arcgisAccessToken
		})
	: undefined;

type RouteStop = IPoint | ILocation | [number, number] | [number, number, number];
type RouteStops = [RouteStop, RouteStop, ...RouteStop[]] | IFeatureSet;

export const fetchRoute = async (
	startCoords: RouteStop,
	endCoords: RouteStop
): Promise<ISolveRouteResponse> => {
	const stops: RouteStops = [startCoords, endCoords];

	return solveRoute({
		stops,
		...(authentication ? { authentication } : {})
	});
};
