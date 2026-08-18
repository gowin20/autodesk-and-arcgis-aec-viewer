import { writable } from 'svelte/store';

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

export const routePlannerLocations = writable<RoutePlannerLocation[]>([]);
export const routePlannerMapPickTargetId = writable<string | null>(null);
export const routePlannerMapPickedPoint = writable<RoutePlannerPickedPoint | null>(null);
