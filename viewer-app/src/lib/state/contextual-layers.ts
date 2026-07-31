import { writable } from 'svelte/store';

export const MAJOR_CITIES_LAYER_ID = 'usa-major-cities';
export const FLOOD_HAZARD_AREAS_LAYER_ID = 'flood-hazard-areas';
export const FAYETTE_COUNTY_PARCELS_LAYER_ID = 'fayette-county-parcels';
export const HUC12_WATERSHEDS_LAYER_ID = 'huc12-watersheds';

export const CONTEXTUAL_LAYER_OPTIONS = [
	{
		id: FLOOD_HAZARD_AREAS_LAYER_ID,
		label: 'Flood hazard risk',
		group: 'Hydrology',
		url: 'https://services5.arcgis.com/7weheFjxuNkGGiZi/ArcGIS/rest/services/USA_Flood_Hazard_Areas_view/FeatureServer/0',
		style: {
			type: 'fill',
			paint: {
				'fill-color': [
					'case',
					['==', ['get', 'esri_symbology'], '0.2% Annual Chance Flood Hazard'],
					'#d8b4fe',
					['==', ['get', 'esri_symbology'], '1% Annual Chance Flood Hazard'],
					'#6b21a8',
					'#d8b4fe'
				],
				'fill-opacity': 0.55
			}
		}
	},
	{
		id: HUC12_WATERSHEDS_LAYER_ID,
		label: 'HUC12 Watersheds',
		group: 'Hydrology',
		url: 'https://services5.arcgis.com/7weheFjxuNkGGiZi/ArcGIS/rest/services/Watershed_Boundary_HUC12/FeatureServer/0',
		style: {
			type: 'line',
			paint: {
				'line-color': '#c48a4e',
				'line-width': 3
			}
		}
	},
	{
		id: FAYETTE_COUNTY_PARCELS_LAYER_ID,
		label: 'Parcels',
		group: 'Infrastructure',
		url: 'https://services5.arcgis.com/n3KaqXoFYDuIhfyz/ArcGIS/rest/services/Fayette_County_Parcels/FeatureServer/0',
		style: {
			type: 'line',
			paint: {
				'line-color': '#000000',
				'line-width': 1
			}
		}
	},
	{
		id: MAJOR_CITIES_LAYER_ID,
		label: 'Major cities',
		group: 'Infrastructure',
		url: 'https://services3.arcgis.com/GVgbJbqm8hXASVYi/arcgis/rest/services/USA_Major_Cities/FeatureServer/0'
	},
] as const;

export const selectedContextualLayerIds = writable<string[]>([]);
