<script lang="ts">
	import { onMount } from 'svelte';
	import { DEFAULT_BASEMAP_STYLE, selectedBasemapStyle } from '$lib/state/basemap-style';
	import {
		CONTEXTUAL_LAYER_GROUPS,
		CONTEXTUAL_LAYER_OPTIONS,
		type ContextualLayerOption
	} from '$lib/state/contextual-layers';
	import {
		addContextualViewerLayer,
		projectLayersVisible,
		resetViewerLayers,
		removeViewerLayer,
		toggleViewerLayerVisibility,
		viewerLayers,
		type ViewerLayer
	} from '$lib/state/layers';
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
	let projectLayers = $state<ViewerLayer[]>([]);
	let isProjectLayersVisible = $state(true);
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
	const getAvailableContextualLayers = (): ContextualLayerOption[] => {
		const activeContextualLayerIds = new Set(
			projectLayers
				.filter((layer): layer is Extract<ViewerLayer, { kind: 'contextual' }> => layer.kind === 'contextual')
				.map((layer) => layer.contextualLayerId)
		);
		return CONTEXTUAL_LAYER_OPTIONS.filter((layer) => !activeContextualLayerIds.has(layer.id));
	};
	const getAvailableContextualLayersForGroup = (group: string): ContextualLayerOption[] =>
		getAvailableContextualLayers().filter((layer) => layer.group === group);
	const getLayerIcon = (visible: boolean): string => (visible ? 'view-visible' : 'view-hide');
	const canClearLayers = (): boolean => {
		if (!isProjectLayersVisible) return true;
		return !(projectLayers.length === 1 && projectLayers[0]?.kind === 'site-location');
	};
	const getLayerDescription = (layer: ViewerLayer): string => {
		switch (layer.kind) {
			case 'contextual':
				return 'Contextual layer';
			case 'service-area':
				return 'Service area result';
			case 'site-location':
				return 'Default site marker';
			case 'geocode-result':
				return 'Geocoding result marker';
			case 'elevation-result':
				return 'Elevation result marker';
			case 'routing-result':
				return 'Route result line';
		}
	};
	const hasArcgisToken = arcgisToken.length > 0;

	onMount(() => {
		const unsubscribeSelectedBasemapStyle = selectedBasemapStyle.subscribe((styleId) => {
			selectedStyleId = styleId;
		});
		const unsubscribeViewerLayers = viewerLayers.subscribe((layers) => {
			projectLayers = layers;
		});
		const unsubscribeProjectLayersVisible = projectLayersVisible.subscribe((visible) => {
			isProjectLayersVisible = visible;
		});
		void (async () => {
			if (!hasArcgisToken) {
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
			unsubscribeViewerLayers();
			unsubscribeProjectLayersVisible();
		};
	});
</script>

<calcite-panel heading="Viewer controls" description="Configure the map display">
	<calcite-block heading="View" description="Map presentation" open>
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

	<calcite-block heading="ArcGIS data" description="Project data" open>
		<div class="layer-controls-row">
			<calcite-label class="layer-visibility-control" layout="inline-space-between">
				Show project layers
				<calcite-switch
					scale="s"
					checked={isProjectLayersVisible}
					oncalciteSwitchChange={(event) =>
						projectLayersVisible.set(Boolean((event.target as { checked?: boolean }).checked))}
				></calcite-switch>
			</calcite-label>
		</div>
		<calcite-dropdown width="full" placement="bottom-start" close-on-select>
			<calcite-button
				slot="trigger"
				width="full"
				appearance="outline"
				disabled={getAvailableContextualLayers().length === 0}
			>
				Add data
			</calcite-button>
			<calcite-dropdown-group group-title="Data sources" selection-mode="none">
				<calcite-dropdown-item disabled>
					Data sourced from ArcGIS Living Atlas, ArcGIS Hub, and ArcGIS Online
				</calcite-dropdown-item>
			</calcite-dropdown-group>
			{#each CONTEXTUAL_LAYER_GROUPS as group}
				{#if getAvailableContextualLayersForGroup(group).length > 0}
					<calcite-dropdown-group group-title={group} selection-mode="none">
						{#each getAvailableContextualLayersForGroup(group) as layer}
							<calcite-dropdown-item onclick={() => addContextualViewerLayer(layer.id)}>
								{layer.label}
							</calcite-dropdown-item>
						{/each}
					</calcite-dropdown-group>
				{/if}
			{/each}
		</calcite-dropdown>
		<h4 class="layers-list-heading">Layers</h4>
		{#if projectLayers.length === 0}
			<calcite-notice class="layers-list-content" open kind="info" icon>
				<div slot="message">No layers have been added yet.</div>
			</calcite-notice>
		{:else}
			<calcite-list class="layers-list-content" label="Project layers">
				{#each projectLayers as layer (layer.id)}
					<calcite-list-item
						value={layer.id}
						label={layer.label}
						description={getLayerDescription(layer)}
					>
						<calcite-action
							slot="actions-end"
							icon={getLayerIcon(layer.visible)}
							text="Toggle visibility"
							onclick={() => toggleViewerLayerVisibility(layer.id)}
						></calcite-action>
						<calcite-action
							slot="actions-end"
							icon="x"
							text="Remove layer"
							onclick={() => removeViewerLayer(layer.id)}
						></calcite-action>
					</calcite-list-item>
				{/each}
			</calcite-list>
		{/if}
		<calcite-button
			class="clear-layers-action"
			width="full"
			appearance="outline"
			kind="neutral"
			scale="s"
			icon-start="trash"
			disabled={!canClearLayers()}
			onclick={resetViewerLayers}
		>
			Clear all layers
		</calcite-button>
	</calcite-block>

</calcite-panel>

<style>
	.layers-list-heading {
		margin: 1rem 0 0.5rem;
		font-size: var(--calcite-font-size--1);
		font-weight: var(--calcite-font-weight-medium);
		color: var(--calcite-color-text-1);
	}

	.layers-list-content {
		margin-top: 0.5rem;
	}

	.layer-controls-row {
		display: block;
		margin-bottom: 0.75rem;
	}

	.layer-visibility-control {
		margin: 0;
	}

	.clear-layers-action {
		margin-top: 0.75rem;
	}
</style>
