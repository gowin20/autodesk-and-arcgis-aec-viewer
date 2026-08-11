import { writable } from 'svelte/store';
import type { ServiceAreaTravelMode } from '$lib/arcgis/routing';

export interface ViewerLocation {
	longitude: number;
	latitude: number;
	label: string;
}

export const serviceAreaEnabled = writable(false);
export const serviceAreaTravelMode = writable<ServiceAreaTravelMode>('driving');
export const elevationQueryEnabled = writable(false);
export const geocodingQuery = writable('');
export const mapCenter = writable({ lng: -79.88666527, lat: 40.022371938 });
export const selectedSearchLocation = writable<ViewerLocation | null>(null);
