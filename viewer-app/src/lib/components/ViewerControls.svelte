<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { get } from 'svelte/store';
	import {
		findSuggestions,
		getAddressCandidate,
		type GeocodeSuggestion
	} from '$lib/arcgis/geocode';
	import type { ServiceAreaTravelMode } from '$lib/arcgis/routing';
	import { DEFAULT_BASEMAP_STYLE, selectedBasemapStyle } from '$lib/state/basemap-style';
	import {
		CONTEXTUAL_LAYER_OPTIONS,
		selectedContextualLayerIds
	} from '$lib/state/contextual-layers';
	import {
		elevationQueryEnabled,
		geocodingQuery,
		mapCenter,
		selectedSearchLocation,
		serviceAreaEnabled,
		serviceAreaTravelMode
	} from '$lib/state/location-services';
	import type { BasemapStyleObject } from '@esri/maplibre-arcgis';

	type BasemapOption = {
		label: string;
		value: string;
	};

	const arcgisToken =
		import.meta.env.VITE_ARCGIS_ACCESS_TOKEN?.trim() ??
		import.meta.env.PUBLIC_ARCGIS_ACCESS_TOKEN?.trim() ??
		'';

	let basemapOptions = $state<BasemapOption[]>([]);
	let isLoadingBasemaps = $state(true);
	let basemapLoadError = $state<string | null>(null);
	let selectedStyleId = $state(DEFAULT_BASEMAP_STYLE);
	let selectedLayerIds = $state<string[]>([]);
	let isServiceAreaEnabled = $state(false);
	let selectedServiceAreaTravelMode = $state<ServiceAreaTravelMode>('driving');
	let isElevationQueryEnabled = $state(false);
	let geocodingSearchQuery = $state('');
	let geocodeSuggestions = $state<GeocodeSuggestion[]>([]);
	let geocodeError = $state<string | null>(null);
	let isGeocoding = $state(false);
	let suggestionTimer: ReturnType<typeof setTimeout> | undefined;
	let suggestionRequestId = 0;
	let contextualLayerCombobox:
		| (HTMLElement & {
				selectedItems?: Array<{ value?: string }>;
		  })
		| undefined;

	const CONTEXTUAL_LAYER_GROUP_ORDER = ['Hydrology', 'Infrastructure'] as const;

	const selectBasemapStyle = (styleId: string) => {
		selectedStyleId = styleId;
		selectedBasemapStyle.set(styleId);
	};

	const toBasemapOption = (style: BasemapStyleObject): BasemapOption => ({
		label: style.name,
		value: style.path
	});

	const getSelectedStyleLabel = (): string =>
		basemapOptions.find((style) => style.value === selectedStyleId)?.label ?? 'Select basemap style';
	const getContextualLayersForGroup = (group: (typeof CONTEXTUAL_LAYER_GROUP_ORDER)[number]) =>
		CONTEXTUAL_LAYER_OPTIONS.filter((layer) => layer.group === group);

	onMount(() => {
		const unsubscribeSelectedBasemapStyle = selectedBasemapStyle.subscribe((styleId) => {
			selectedStyleId = styleId;
		});
		const unsubscribeSelectedContextualLayerIds = selectedContextualLayerIds.subscribe((layerIds) => {
			selectedLayerIds = layerIds;
		});
		const unsubscribeServiceAreaEnabled = serviceAreaEnabled.subscribe((enabled) => {
			isServiceAreaEnabled = enabled;
		});
		const unsubscribeServiceAreaTravelMode = serviceAreaTravelMode.subscribe((travelMode) => {
			selectedServiceAreaTravelMode = travelMode;
		});
		const unsubscribeElevationQueryEnabled = elevationQueryEnabled.subscribe((enabled) => {
			isElevationQueryEnabled = enabled;
		});
		const unsubscribeGeocodingQuery = geocodingQuery.subscribe((query) => {
			geocodingSearchQuery = query;
		});

		void (async () => {
			if (!arcgisToken) {
				basemapLoadError =
					'Set VITE_ARCGIS_ACCESS_TOKEN (or PUBLIC_ARCGIS_ACCESS_TOKEN) to load basemap styles.';
				isLoadingBasemaps = false;
				return;
			}

			try {
				const { BasemapStyle } = await import('@esri/maplibre-arcgis');
				const basemapSelf = await BasemapStyle.getSelf({ token: arcgisToken });
				basemapOptions = basemapSelf.styles
					.filter((style) => style.complete && style.styleFamily === 'arcgis' && !style.deprecated)
					.map(toBasemapOption)
					.sort((a, b) => a.label.localeCompare(b.label));
				basemapLoadError = null;
			} catch (error: unknown) {
				basemapLoadError = error instanceof Error ? error.message : 'Unable to load basemap styles.';
			} finally {
				isLoadingBasemaps = false;
			}
		})();

		return () => {
			unsubscribeSelectedBasemapStyle();
			unsubscribeSelectedContextualLayerIds();
			unsubscribeServiceAreaEnabled();
			unsubscribeServiceAreaTravelMode();
			unsubscribeElevationQueryEnabled();
			unsubscribeGeocodingQuery();
		};
	});

	const onContextualLayerSelectionChange = () => {
		const nextSelection =
			contextualLayerCombobox?.selectedItems
				?.map((item) => item.value)
				.filter((value): value is string => Boolean(value)) ?? [];
		selectedContextualLayerIds.set(nextSelection);
	};
	const toggleServiceArea = () => {
		const enabled = !isServiceAreaEnabled;
		serviceAreaEnabled.set(enabled);
		if (enabled) elevationQueryEnabled.set(false);
	};
	const setServiceAreaTravelMode = (travelMode: ServiceAreaTravelMode) => {
		selectedServiceAreaTravelMode = travelMode;
		serviceAreaTravelMode.set(travelMode);
	};
	const toggleElevationQuery = () => {
		const enabled = !isElevationQueryEnabled;
		elevationQueryEnabled.set(enabled);
		if (enabled) serviceAreaEnabled.set(false);
	};
	const onGeocodingInput = (event: Event) => {
		const target = event.target as { inputValue?: string } | null;
		const query = target?.inputValue?.trim() ?? '';
		geocodingQuery.set(query);
		geocodeError = null;
		if (suggestionTimer) clearTimeout(suggestionTimer);

		if (query.length < 3) {
			geocodeSuggestions = [];
			isGeocoding = false;
			return;
		}

		const requestId = ++suggestionRequestId;
		isGeocoding = true;
		suggestionTimer = setTimeout(() => {
			void findSuggestions(query, get(mapCenter))
				.then((suggestions) => {
					if (requestId === suggestionRequestId) {
						geocodeSuggestions = suggestions ?? [];
					}
				})
				.catch((error: unknown) => {
					if (requestId === suggestionRequestId) {
						geocodeSuggestions = [];
						geocodeError = error instanceof Error ? error.message : 'Address suggestions failed.';
					}
				})
				.finally(() => {
					if (requestId === suggestionRequestId) isGeocoding = false;
				});
		}, 250);
	};
	const selectGeocodeSuggestion = async (suggestion: GeocodeSuggestion) => {
		isGeocoding = true;
		geocodeError = null;
		try {
			const candidate = await getAddressCandidate(suggestion.text, suggestion.magicKey);
			if (!candidate) {
				throw new Error('No matching location was found.');
			}

			geocodingQuery.set(candidate.address);
			geocodeSuggestions = [];
			selectedSearchLocation.set({
				longitude: candidate.location.x,
				latitude: candidate.location.y,
				label: candidate.address
			});
		} catch (error: unknown) {
			geocodeError = error instanceof Error ? error.message : 'Address search failed.';
		} finally {
			isGeocoding = false;
		}
	};

	onDestroy(() => {
		if (suggestionTimer) clearTimeout(suggestionTimer);
	});
</script>

<calcite-panel heading="Viewer controls" description="Configure the map display">
	<calcite-block heading="View" description="Map presentation" open>
		<calcite-label layout="inline-space-between">
			Show project layers
			<calcite-switch checked></calcite-switch>
		</calcite-label>
		<calcite-label>
			Display mode
			<calcite-segmented-control width="full">
				<calcite-segmented-control-item value="2d" checked>2D</calcite-segmented-control-item>
				<calcite-segmented-control-item value="3d">3D</calcite-segmented-control-item>
			</calcite-segmented-control>
		</calcite-label>
	</calcite-block>

	<calcite-block heading="Basemap style" description="ArcGIS basemap styles" open>
		{#if basemapLoadError}
			<calcite-notice open kind="danger" icon>
				<div slot="message">{basemapLoadError}</div>
			</calcite-notice>
		{:else if isLoadingBasemaps}
			<calcite-notice open kind="info" icon>
				<div slot="message">Loading ArcGIS basemap styles...</div>
			</calcite-notice>
		{:else}
			<calcite-dropdown width="full" placement="bottom-start" close-on-select>
				<calcite-button slot="trigger" width="full" appearance="outline">{getSelectedStyleLabel()}</calcite-button>
				<calcite-dropdown-group group-title="ArcGIS Basemap Styles" selection-mode="single">
					{#each basemapOptions as style}
						<calcite-dropdown-item
							selected={style.value === selectedStyleId}
							onclick={() => selectBasemapStyle(style.value)}
						>
							{style.label}
						</calcite-dropdown-item>
					{/each}
				</calcite-dropdown-group>
			</calcite-dropdown>
		{/if}
	</calcite-block>

	<calcite-block heading="Layers" description="Project data" open>
		<calcite-label>
			Contextual layers
			<calcite-combobox
				bind:this={contextualLayerCombobox}
				label="Contextual layers"
				selection-mode="multiple"
				selection-display="all"
				selection-appearance="icon"
				scale="m"
				placeholder="Select contextual layers"
				oncalciteComboboxChange={onContextualLayerSelectionChange}
			>
				{#each CONTEXTUAL_LAYER_GROUP_ORDER as group}
					<calcite-combobox-item-group label={group}>
						{#each getContextualLayersForGroup(group) as layer}
							<calcite-combobox-item
								value={layer.id}
								heading={layer.label}
								selected={selectedLayerIds.includes(layer.id)}
							></calcite-combobox-item>
						{/each}
					</calcite-combobox-item-group>
				{/each}
			</calcite-combobox>
		</calcite-label>
		<calcite-label>
			Building layers
			<calcite-combobox
				label="Building layers"
				selection-mode="multiple"
				selection-display="all"
				selection-appearance="icon"
				scale="m"
				placeholder="Select building layers"
			>
			</calcite-combobox>
		</calcite-label>
	</calcite-block>

	<calcite-block heading="Location services" description="Search and analysis" open>
		<calcite-label>
			Elevation query
			<calcite-button
				width="full"
				appearance={isElevationQueryEnabled ? 'solid' : 'outline'}
				onclick={toggleElevationQuery}
			>
				Elevation query {isElevationQueryEnabled ? 'On' : 'Off'}
			</calcite-button>
		</calcite-label>

		<calcite-label>
			Geocoding
			<calcite-autocomplete
				input-value={geocodingSearchQuery}
				label="Search by address or place"
				placeholder="Search by address or place"
				icon="search"
				clearable
				loading={isGeocoding}
				open={geocodeSuggestions.length > 0}
				oncalciteAutocompleteTextInput={onGeocodingInput}
			>
				{#each geocodeSuggestions as suggestion (suggestion.magicKey)}
					<calcite-autocomplete-item
						heading={suggestion.text}
						value={suggestion.magicKey}
						icon-start="pin"
						oncalciteAutocompleteItemSelect={() => selectGeocodeSuggestion(suggestion)}
					></calcite-autocomplete-item>
				{/each}
			</calcite-autocomplete>
		</calcite-label>
		{#if geocodeError}
			<calcite-notice open kind="danger" icon>
				<div slot="message">{geocodeError}</div>
			</calcite-notice>
		{/if}
	</calcite-block>

	<calcite-block heading="Routing" description="Network analysis requests" open>
		<calcite-label>
			Service area
			<calcite-button
				width="full"
				appearance={isServiceAreaEnabled ? 'solid' : 'outline'}
				onclick={toggleServiceArea}
			>
				Service area {isServiceAreaEnabled ? 'On' : 'Off'}
			</calcite-button>
		</calcite-label>
		<calcite-label>
			Travel mode
			<calcite-segmented-control width="full">
				<calcite-segmented-control-item
					value="driving"
					checked={selectedServiceAreaTravelMode === 'driving'}
					onclick={() => setServiceAreaTravelMode('driving')}
				>
					Driving
				</calcite-segmented-control-item>
				<calcite-segmented-control-item
					value="walking"
					checked={selectedServiceAreaTravelMode === 'walking'}
					onclick={() => setServiceAreaTravelMode('walking')}
				>
					Walking
				</calcite-segmented-control-item>
			</calcite-segmented-control>
		</calcite-label>
		{#if isServiceAreaEnabled}
			<calcite-notice open kind="info" icon>
				<div slot="message">Click the map to set a facility and configure the request.</div>
			</calcite-notice>
		{/if}
	</calcite-block>
</calcite-panel>
