import adapter from '@sveltejs/adapter-auto';
import { sveltekit } from '@sveltejs/kit/vite';
import { viteStaticCopy } from 'vite-plugin-static-copy';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	ssr: {
		noExternal: ['@esri/calcite-components', '@esri/maplibre-arcgis', 'maplibre-gl']
	},

	server: {
		// APS sample-server proxy used by the LMV bridge (auth token + model catalog).
		proxy: {
			'/api': {
				target: 'https://aps-extensions.autodesk.io',
				changeOrigin: true,
				secure: true
			}
		}
	},

	// Calcite v5 publishes browser-ready ESM, so Vite handles module resolution,
	// CSS extraction, CommonJS interop, and minification without Rollup plugins.
	plugins: [
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},

			// adapter-auto only supports some environments, see https://svelte.dev/docs/kit/adapter-auto for a list.
			// If your environment is not supported, or you settled on a specific environment, switch out the adapter.
			// See https://svelte.dev/docs/kit/adapters for more information about adapters.
			adapter: adapter()
		})
	],

	test: {
		css: true
	}
});
