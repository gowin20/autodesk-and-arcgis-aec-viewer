import { ApiKeyManager } from '@esri/arcgis-rest-request';

const arcgisAccessToken =
	import.meta.env.VITE_ARCGIS_ACCESS_TOKEN?.trim() ??
	import.meta.env.PUBLIC_ARCGIS_ACCESS_TOKEN?.trim() ??
	'';

export const arcgisAuthentication = arcgisAccessToken
	? ApiKeyManager.fromKey(arcgisAccessToken)
	: undefined;
