import { derived, get, writable } from 'svelte/store';
import snowdonArchitecturalThumbnail from '$lib/assets/thumbs/snowdon-architectural.png';
import nottinghamArenaThumbnail from '$lib/assets/thumbs/nottingham-arena.png';
import indiaFacilityThumbnail from '$lib/assets/thumbs/india-facility.png';
import bauhausDessauThumbnail from '$lib/assets/thumbs/bauhaus-dessau.png';

export type SiteDefinition = {
	id: string;
	label: string;
	coordinates: [number, number];
	modelUrn: string;
	thumbnailUrl: string;
};

export const SITE_LOCATIONS: SiteDefinition[] = [
	{
		id: 'site-1',
		label: 'Snowdon Architectural',
		coordinates: [-79.88666527, 40.022371938],
		modelUrn: 'dXJuOmFkc2sub2JqZWN0czpvcy5vYmplY3Q6c2FtcGxlbW9kZWxzL09mZmljZS5ydnQ=',
		thumbnailUrl: snowdonArchitecturalThumbnail
	},
	{
		id: 'site-2',
		label: 'Nottingham Arena',
		coordinates: [-1.139453764, 52.953294528],
		// Placeholder: replace with Site 2 LMV URN when available.
		modelUrn: 'dXJuOmFkc2sub2JqZWN0czpvcy5vYmplY3Q6c2FtcGxlbW9kZWxzL09mZmljZS5ydnQ=',
		thumbnailUrl: nottinghamArenaThumbnail
	},
	{
		id: 'site-3',
		label: 'India Facility',
		coordinates: [86.026848, 25.414847],
		// Placeholder: replace with Site 3 LMV URN when available.
		modelUrn: 'dXJuOmFkc2sub2JqZWN0czpvcy5vYmplY3Q6c2FtcGxlbW9kZWxzL09mZmljZS5ydnQ=',
		thumbnailUrl: indiaFacilityThumbnail
	},
	{
		id: 'site-4',
		label: 'Bauhaus Dessau',
		coordinates: [12.22729, 51.839334],
		// Placeholder: replace with Site 4 LMV URN when available.
		modelUrn: 'dXJuOmFkc2sub2JqZWN0czpvcy5vYmplY3Q6c2FtcGxlbW9kZWxzL09mZmljZS5ydnQ=',
		thumbnailUrl: bauhausDessauThumbnail
	}
];

export const currentSiteId = writable<string>(SITE_LOCATIONS[0].id);

export const currentSite = derived(currentSiteId, ($currentSiteId) => {
	const matchedSite = SITE_LOCATIONS.find((site) => site.id === $currentSiteId);
	return matchedSite ?? SITE_LOCATIONS[0];
});

export const setCurrentSite = (siteId: string) => {
	const siteExists = SITE_LOCATIONS.some((site) => site.id === siteId);
	if (!siteExists) {
		return;
	}
	const currentId = get(currentSiteId);
	if (currentId === siteId) {
		return;
	}
	currentSiteId.set(siteId);
};
