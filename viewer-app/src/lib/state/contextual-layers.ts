export const MAJOR_CITIES_LAYER_ID = 'usa-major-cities';
export const FLOOD_HAZARD_AREAS_LAYER_ID = 'flood-hazard-areas';
export const FAYETTE_COUNTY_PARCELS_LAYER_ID = 'fayette-county-parcels';
export const HUC12_WATERSHEDS_LAYER_ID = 'huc12-watersheds';
export const LEVEES_LAYER_ID = 'levees';
export const INTERNET_BROADBAND_SPEED_DOWNLOAD_LAYER_ID = 'internet-broadband-speed-download';

export const CONTEXTUAL_LAYER_OPTIONS = [
	{
		id: FLOOD_HAZARD_AREAS_LAYER_ID,
		label: 'Flood hazard risk',
		group: 'Hydrology',
		url: 'https://services5.arcgis.com/7weheFjxuNkGGiZi/ArcGIS/rest/services/USA_Flood_Hazard_Areas_view/FeatureServer/0',
		itemUrl: 'https://arcgis-devlabs.maps.arcgis.com/home/item.html?id=ccd29fb4bd5e4b44a2d61638829a5d7e#overview',
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
		itemUrl: 'https://arcgis-devlabs.maps.arcgis.com/home/item.html?id=cf86758469324bfbaef2b06058c11dd3#overview',
		style: {
			type: 'line',
			paint: {
				'line-color': '#c48a4e',
				'line-width': 3
			}
		}
	},
	{
		id: LEVEES_LAYER_ID,
		label: 'Levee stations',
		group: 'Hydrology',
		url: 'https://services2.arcgis.com/FiaPA4ga0iQKduv3/arcgis/rest/services/NLD2_PUBLIC_v1/FeatureServer/1',
		itemUrl: 'https://arcgis-devlabs.maps.arcgis.com/home/item.html?id=87acff1ba86c40098b59472292de3d11#overview',
	},
	{
		id: FAYETTE_COUNTY_PARCELS_LAYER_ID,
		label: 'Parcels',
		group: 'Infrastructure',
		url: 'https://services5.arcgis.com/n3KaqXoFYDuIhfyz/ArcGIS/rest/services/Fayette_County_Parcels/FeatureServer/0',
		itemUrl: 'https://arcgis-devlabs.maps.arcgis.com/home/item.html?id=460d482b135e456086575f4b1bae66db#overview',
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
		url: 'https://services3.arcgis.com/GVgbJbqm8hXASVYi/arcgis/rest/services/USA_Major_Cities/FeatureServer/0',
		itemUrl: 'https://arcgis-devlabs.maps.arcgis.com/home/item.html?id=869611ee7a9a4d57b3dbb3b66a432144#overview'
	},
	{
		id: INTERNET_BROADBAND_SPEED_DOWNLOAD_LAYER_ID,
		label: 'Internet broadband speed (download)',
		group: 'Infrastructure',
		url: 'https://services.arcgis.com/jIL9msH9OI208GCb/arcgis/rest/services/Speedtest_by_Ookla_Global_Fixed_and_Mobile_Network_Performance_Map_Tiles/FeatureServer/0',
		itemUrl: 'https://arcgis-devlabs.maps.arcgis.com/home/item.html?id=048da3d1818b4d0b95ec526b9e642719#overview'
	},
] as const;

export type ContextualLayerOption = (typeof CONTEXTUAL_LAYER_OPTIONS)[number];
export const CONTEXTUAL_LAYER_GROUPS = Array.from(
	new Set(CONTEXTUAL_LAYER_OPTIONS.map((layer) => layer.group))
);
