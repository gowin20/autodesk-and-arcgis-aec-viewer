import adapterAuto from '@sveltejs/adapter-auto';
import adapterStatic from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import { viteStaticCopy } from 'vite-plugin-static-copy';
import { defineConfig } from 'vitest/config';

// GH_PAGES=1 → fully static build for GitHub Pages (served from the repo
// subpath /autodesk-and-arcgis-aec-viewer/).
const ghPages = !!process.env.GH_PAGES;

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
			// GH_PAGES=1 → static SPA build (prerender + index.html fallback) under
			// the repo subpath; auth uses the CORS-enabled CloudFront API (lmv-loader).
			adapter: ghPages ? adapterStatic({ fallback: 'index.html' }) : adapterAuto(),
			paths: { base: ghPages ? '/autodesk-and-arcgis-aec-viewer' : '' }
		}),
		viteStaticCopy({
			targets: [
				{
					src: 'node_modules/@esri/calcite-components/dist/cdn/assets/**/*',
					dest: 'calcite/assets'
				}
			]
		})
	],

	test: {
		css: true
	}
});
