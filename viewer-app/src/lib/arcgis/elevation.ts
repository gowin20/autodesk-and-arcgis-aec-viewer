import {
	findElevationAtPoint,
	type IFindElevationAtPointResponse
} from '@esri/arcgis-rest-elevation';
import { arcgisAuthentication } from './authentication';

export type ElevationReference = 'meanSeaLevel' | 'ellipsoid';

export const getElevationAtLocation = async (
	longitude: number,
	latitude: number,
	relativeTo: ElevationReference = 'meanSeaLevel'
): Promise<IFindElevationAtPointResponse> =>
	findElevationAtPoint({
		lon: longitude,
		lat: latitude,
		relativeTo,
		...(arcgisAuthentication ? { authentication: arcgisAuthentication } : {})
	});
