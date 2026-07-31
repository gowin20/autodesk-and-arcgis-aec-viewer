<script lang="ts">
	import { onMount } from 'svelte';
	import { DEFAULT_BASEMAP_STYLE, selectedBasemapStyle } from '$lib/state/basemap-style';
	import {
		CONTEXTUAL_LAYER_OPTIONS,
		selectedContextualLayerIds
	} from '$lib/state/contextual-layers';
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
		};
	});

	const onContextualLayerSelectionChange = () => {
		const nextSelection =
			contextualLayerCombobox?.selectedItems
				?.map((item) => item.value)
				.filter((value): value is string => Boolean(value)) ?? [];
		selectedContextualLayerIds.set(nextSelection);
	};
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
	</calcite-block>
</calcite-panel>
