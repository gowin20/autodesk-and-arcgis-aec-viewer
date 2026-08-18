import { writable } from 'svelte/store';
import type { FeatureCollection } from 'geojson';

export type Site = {
	id: string;
	name: string;
	urn: string;
	thumbnail?: string;
	bearingOffset: number;
	/** Model rotation in degrees around its Z axis (placement matrix). */
	modelRotationDeg: number;
	/** Extra scale multiplier applied on top of the base unit scale. */
	modelScale: number;
	/** Model placement origin (geo); falls back to the pin lon/lat when absent. */
	modelOriginLon: number;
	modelOriginLat: number;
	/** Model placement altitude in metres above ground (default 10). */
	modelAltitude: number;
	lon: number;
	lat: number;
};

export const siteCatalog = writable<Site[]>([]);
export const selectedSiteId = writable<string | null>(null);

let geojsonPromise: Promise<FeatureCollection> | null = null;

/**
 * Fetch the shared site geojson (copied from acc-folder-rvt-on-map) from
 * SvelteKit's static assets. The promise is cached so the catalog and the
 * outline geometry share a single fetch.
 */
function fetchSiteGeojson(): Promise<FeatureCollection> {
	geojsonPromise ??= fetch('/site_outlines.geojson')
		.then((resp) => {
			if (!resp.ok) throw new Error(`Failed to load site catalog: ${resp.status}`);
			return resp.json();
		})
		.catch((error: unknown) => {
			geojsonPromise = null; // allow retry on next call
			throw error;
		});
	return geojsonPromise;
}

/** Site pins (Point features) for the header combo box and map markers. */
export function loadSiteCatalog(): Promise<Site[]> {
	const promise = fetchSiteGeojson().then((data) =>
		data.features
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			.filter((f: any) => f.geometry.type === 'Point')
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			.map((f: any) => ({
				id: f.properties.id,
				name: f.properties.name,
				urn: f.properties.urn,
				thumbnail: f.properties.thumbnail,
				bearingOffset: f.properties.bearingOffset || 0,
				modelRotationDeg: f.properties.modelRotationDeg ?? 0,
				modelScale: f.properties.modelScale ?? 1,
				modelOriginLon: f.properties.modelOriginLon ?? f.geometry.coordinates[0],
				modelOriginLat: f.properties.modelOriginLat ?? f.geometry.coordinates[1],
				modelAltitude: f.properties.modelAltitude ?? 10,
				lon: f.geometry.coordinates[0],
				lat: f.geometry.coordinates[1]
			}))
	);
	promise.then((sites) => siteCatalog.set(sites)).catch(() => {});
	return promise;
}

/** Full feature collection (pins + outline polygons) for the map layers. */
export function loadSiteOutlines(): Promise<FeatureCollection> {
	const promise = fetchSiteGeojson();
	promise.catch(() => {});
	return promise;
}
