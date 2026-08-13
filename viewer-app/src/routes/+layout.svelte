<script lang="ts">
	import { browser } from '$app/environment';
	import { base } from '$app/paths';
	import { setAssetPath } from '@esri/calcite-components';
	import favicon from '$lib/assets/favicon.svg';
	import '../app.css';

	if (browser) {
		setAssetPath(`${base}/calcite/`);
	}

	import '@esri/calcite-components/components/calcite-action/customElement';
	import '@esri/calcite-components/components/calcite-action-bar/customElement';
	import '@esri/calcite-components/components/calcite-autocomplete/customElement';
	import '@esri/calcite-components/components/calcite-autocomplete-item/customElement';
	import '@esri/calcite-components/components/calcite-block/customElement';
	import '@esri/calcite-components/components/calcite-button/customElement';
	import '@esri/calcite-components/components/calcite-dropdown/customElement';
	import '@esri/calcite-components/components/calcite-dropdown-group/customElement';
	import '@esri/calcite-components/components/calcite-dropdown-item/customElement';
	import '@esri/calcite-components/components/calcite-flow/customElement';
	import '@esri/calcite-components/components/calcite-flow-item/customElement';
	import '@esri/calcite-components/components/calcite-icon/customElement';
	import '@esri/calcite-components/components/calcite-input/customElement';
	import '@esri/calcite-components/components/calcite-label/customElement';
	import '@esri/calcite-components/components/calcite-list/customElement';
	import '@esri/calcite-components/components/calcite-list-item/customElement';
	import '@esri/calcite-components/components/calcite-list-item-group/customElement';
	import '@esri/calcite-components/components/calcite-navigation/customElement';
	import '@esri/calcite-components/components/calcite-navigation-logo/customElement';
	import '@esri/calcite-components/components/calcite-notice/customElement';
	import '@esri/calcite-components/components/calcite-panel/customElement';
	import '@esri/calcite-components/components/calcite-option/customElement';
	import '@esri/calcite-components/components/calcite-segmented-control/customElement';
	import '@esri/calcite-components/components/calcite-segmented-control-item/customElement';
	import '@esri/calcite-components/components/calcite-select/customElement';
	import '@esri/calcite-components/components/calcite-shell/customElement';
	import '@esri/calcite-components/components/calcite-shell-panel/customElement';
	import '@esri/calcite-components/components/calcite-switch/customElement';

	let { children } = $props();
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
</svelte:head>

{@render children()}
