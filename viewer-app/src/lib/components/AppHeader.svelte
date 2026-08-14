<script lang="ts">
	import { onMount } from 'svelte';
	import { lmvInteractionEnabled } from '$lib/state/lmv-interaction';
	import { loadSiteCatalog, selectedSiteId, siteCatalog } from '$lib/state/site-catalog';

	let catalogError = $state<string | null>(null);

	onMount(() => {
		void loadSiteCatalog().catch((error: unknown) => {
			catalogError = error instanceof Error ? error.message : 'Failed to load site catalog.';
		});
	});

	const onSiteSelected = (event: Event) => {
		const select = event.currentTarget as {
			selectedOption?: { value?: string };
		} | null;
		selectedSiteId.set(select?.selectedOption?.value || null);
	};
</script>

<calcite-navigation class="app-header">
	<calcite-navigation-logo
		slot="logo"
		heading="Autodesk + ArcGIS for AEC"
		description="Interactive Viewer"
	></calcite-navigation-logo>
	{#if catalogError}
		<calcite-tag slot="content-start" kind="danger" icon="exclamation-mark-triangle" label="Site catalog error">
			Site catalog error
		</calcite-tag>
	{:else}
		<calcite-select
			slot="content-start"
			class="site-select"
			label="Load model by site"
			placeholder="Load model…"
			oncalciteSelectChange={onSiteSelected}
		>
			<calcite-option value="">Load model…</calcite-option>
			{#each $siteCatalog as site}
				<calcite-option value={site.id}>{site.name}</calcite-option>
			{/each}
		</calcite-select>
	{/if}
	<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
	<calcite-action
		slot="content-end"
		icon="cube"
		text="Interact with 3D model"
		text-enabled
		active={$lmvInteractionEnabled}
		onclick={() => lmvInteractionEnabled.update((enabled) => !enabled)}
	></calcite-action>
</calcite-navigation>

<style>
	.app-header {
		--calcite-navigation-background-color: var(--calcite-color-foreground-2);
		--calcite-navigation-logo-heading-text-color: var(--calcite-color-text-1);
		--calcite-navigation-logo-text-color: var(--calcite-color-text-2);
		border-block-end: 1px solid var(--calcite-color-border-2);
	}

	.site-select {
		inline-size: 16rem;
	}
</style>
