import { derived, writable } from 'svelte/store';

export const DEFAULT_BASEMAP_STYLE = 'arcgis/navigation';
export const SATELLITE_BASEMAP_STYLE = 'arcgis/imagery';

export const selectedBasemapStyle = writable<string>(DEFAULT_BASEMAP_STYLE);
export const satelliteBasemapEnabled = writable(false);
export const activeBasemapStyle = derived(
	[selectedBasemapStyle, satelliteBasemapEnabled],
	([$selectedBasemapStyle, $satelliteBasemapEnabled]) =>
		$satelliteBasemapEnabled ? SATELLITE_BASEMAP_STYLE : $selectedBasemapStyle
);

export const toggleSatelliteBasemap = () => {
	satelliteBasemapEnabled.update((enabled) => !enabled);
};
