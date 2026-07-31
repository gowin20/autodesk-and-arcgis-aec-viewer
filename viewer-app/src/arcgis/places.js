import { findPlacesWithinExtent,getPlaceDetails } from '@esri/arcgis-rest-places';
// import { authentication, apiKey } from "../App.js";

// Get places in a bounding box
// This function is not currently being used as ArcGIS REST JS has yet to add support for the `icon` param added last week
// Once it does, you can simply add the `icon:\'png\'` to the param list and replace `fetchPlacesRaw` with this function for identical behavior.
export const fetchPlaces = async (query,map) => {

    if (!query) return;

    console.log("findPlacesWithinExtent request:" + query)

    const bounds = map.getBounds()
    const topRight = bounds.getNorthEast()
    const bottomLeft = bounds.getSouthWest()

    // Request parameters
    const params = {
        // Search bounds
        xmin: bottomLeft.lng,
        ymin: bottomLeft.lat,
        xmax: topRight.lng,
        ymax: topRight.lat,
        // Search text / category
        categoryIds: query.placeType?.categoryIds,
        searchText: query.searchText,
        pageSize:20,
        icon:'png',
        // authentication
    }

    if (typeof query === 'string') params.searchText = query;
    else params.categoryIds = query;

    try {

        let response = await findPlacesWithinExtent(params)
        console.log(response.results);
        return response.results;
        /*
        // Paginate results
        if (response.results.length > 0) {
            let results = response.results;
            while (response.nextPage) {
                response = await response.nextPage();
                results = results.concat(response.results)
            }
            console.log('Results:',results)
            return results;
        }
            */
    } catch (err) {
        console.error(err)
    }   
}

// A version of the request that uses `fetch()` instead of ArcGIS REST JS
export const fetchPlacesRaw = async (query, map) => {
    if (!query) return;

    console.log("findPlacesWithinExtent request (using fetch):" + query)

    const bounds = map.getBounds()
    const topRight = bounds.getNorthEast()
    const bottomLeft = bounds.getSouthWest()

    // Request parameters
    const params = {
        // Search bounds
        xmin: bottomLeft.lng,
        ymin: bottomLeft.lat,
        xmax: topRight.lng,
        ymax: topRight.lat,
        // Search text / category
        categoryIds: query.placeType?.categoryIds,
        searchText: query.searchText,
        pageSize:20,
        icon:'png'
    }

    if (typeof query === 'string') params.searchText = query;
    else params.categoryIds = query;

    try {

        // REST JS service call
        let placesEndpoint = `https://places-api.arcgis.com/arcgis/rest/services/places-service/v1/places/within-extent?token=${apiKey}`;

        for (const param of Object.keys(params)) {
            if (params[param] !== undefined) placesEndpoint += `&${param}=${params[param]}`;
        }
        const response = await (await fetch(placesEndpoint)).json();

        if (response.results.length === 0) return null;
        
        return response.results;

        /* We are not currently paginating results in this app
        // Paginate results
        if (response.results.length > 0) {
            let results = response.results;
            while (response.nextPage) {
                response = await (await fetch(response.pagination.nextUrl())).json(); //fetch next URL
                results = results.concat(response.results)
            }
            console.log('Place results:',results)
            return results;
        }
        */
    } catch (err) {
        console.error(err)
    }   
}

// Fetch details about a place
export const fetchPlaceDetails = async (placeId) => {
    console.log('placeDetails request:',placeId)
    const params = {
        placeId: placeId,
        requestedFields: ["all"], // Request all fields - change this to decrase usage costs
        // authentication,
    }
    try {
        // REST JS service call
        const result = await getPlaceDetails(params)
        return result.placeDetails;

    } catch (err) {
        console.log(err)
    }
}