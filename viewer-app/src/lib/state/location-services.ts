import { writable } from 'svelte/store';

export const serviceAreaEnabled = writable(false);
export const elevationQueryEnabled = writable(false);
export const geocodingQuery = writable('');
