import { writable } from 'svelte/store';

export const DEFAULT_BASEMAP_STYLE = 'arcgis/navigation';

export const selectedBasemapStyle = writable<string>(DEFAULT_BASEMAP_STYLE);
