import {solveRoute} from '@esri/arcgis-rest-routing';
import { authentication } from "../App";

export const fetchRoute = async (startCoords,endCoords) => {

    const response = await solveRoute({
        stops: [startCoords,endCoords],
        authentication
    })

    return response;
}