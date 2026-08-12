import { writable } from 'svelte/store';
import type { EnabledTravelModes } from '$lib/arcgis/routing';

export interface ViewerLocation {
	longitude: number;
	latitude: number;
	label: string;
}

export interface RoutePlannerLocation {
	id: string;
	order: number;
	longitude: number;
	latitude: number;
	label: string;
}

export interface RoutePlannerPickedPoint {
	targetId: string;
	longitude: number;
	latitude: number;
}

export const serviceAreaEnabled = writable(false);
export const enabledTravelModes = writable<EnabledTravelModes | null>(null);
export const elevationQueryEnabled = writable(false);
export const geocodingQuery = writable('');
export const mapCenter = writable({ lng: -79.88666527, lat: 40.022371938 });
export const selectedSearchLocation = writable<ViewerLocation | null>(null);
export const routePlannerLocations = writable<RoutePlannerLocation[]>([]);
export const routePlannerMapPickTargetId = writable<string | null>(null);
export const routePlannerMapPickedPoint = writable<RoutePlannerPickedPoint | null>(null);
