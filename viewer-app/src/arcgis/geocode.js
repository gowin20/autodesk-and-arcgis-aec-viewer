import {suggest, geocode, reverseGeocode} from '@esri/arcgis-rest-geocoding';
import { authentication } from "../App";

// Autosuggest geocoding results
export const findSuggestions = async (query,center) => {
    if (!query || !center) return;

    let response = await suggest(query,{
        authentication,
        params:{
            location: center.lng+','+center.lat
        }
    })
    return response.suggestions;
}

// Perform a forward geocode
export const getAddressCandidate = async (text,key) => {
    if (!text && !key) return;

    console.log('Geocode request:',text);

    let response = await geocode({
        singleLine:text,
        magicKey:key,
        authentication
    })

    if (response.candidates.length > 0) return response.candidates[0];
    else return null;
}

// Perform a reverse geocode
export const getReverseGeocode = async (location) => {
    if (!location) return;
    
    console.log('Reverse geocode request: ',location);

    const response = await reverseGeocode(location, {
        authentication
    })
    if (!response.address || !response.location) return null;

    return response;
}