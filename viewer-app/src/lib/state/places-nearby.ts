import { writable } from 'svelte/store';

export type NearbyPlace = {
	placeId: string;
	name: string;
	categoryLabel: string;
	distanceMeters: number;
	longitude: number;
	latitude: number;
};

export const nearbyPlaces = writable<NearbyPlace[]>([]);

export const setNearbyPlaces = (places: NearbyPlace[]) => {
	nearbyPlaces.set(places);
};

export const clearNearbyPlaces = () => {
	nearbyPlaces.set([]);
};
