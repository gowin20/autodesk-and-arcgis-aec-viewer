<script lang="ts">
	import AppHeader from './AppHeader.svelte';
	import ContextPanel from './ContextPanel.svelte';
	import ViewerCanvas from './ViewerCanvas.svelte';
	import ViewerControls from './ViewerControls.svelte';

	let leftCollapsed = $state(false);
	let rightCollapsed = $state(false);
</script>

<calcite-shell>
	<div slot="header" class="header-slot">
		<AppHeader />
	</div>

	<calcite-shell-panel slot="panel-start" width="m" collapsed={leftCollapsed}>
		<calcite-action-bar slot="action-bar">
			<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
			<calcite-action
				icon={leftCollapsed ? 'chevrons-right' : 'chevrons-left'}
				text={leftCollapsed ? 'Open viewer controls' : 'Collapse viewer controls'}
				onclick={() => (leftCollapsed = !leftCollapsed)}
			></calcite-action>
		</calcite-action-bar>
		<ViewerControls />
	</calcite-shell-panel>

	<ViewerCanvas />

	<calcite-shell-panel slot="panel-end" width="m" collapsed={rightCollapsed}>
		<calcite-action-bar slot="action-bar">
			<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
			<calcite-action
				icon={rightCollapsed ? 'chevrons-left' : 'chevrons-right'}
				text={rightCollapsed ? 'Open contextual information' : 'Collapse contextual information'}
				onclick={() => (rightCollapsed = !rightCollapsed)}
			></calcite-action>
		</calcite-action-bar>
		<ContextPanel />
	</calcite-shell-panel>
</calcite-shell>

<style>
	calcite-shell {
		height: 100dvh;
	}

	.header-slot {
		display: contents;
	}

	calcite-shell-panel {
		--calcite-shell-panel-width: clamp(17rem, 22vw, 22rem);
	}
</style>
