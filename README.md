# MapLibre combines "Autodesk APS Viewer" BIM Models and "Esri ArcGIS" Feature Data (Handout)

This demo combines Autodesk Platform Services (APS) Viewer with MapLibre GL JS and ArcGIS to create a lightweight, browser-based digital twin
  for construction and asset intelligence.

  The APS Large Model Viewer (LMV) renders BIM models inside a MapLibre custom layer—using one canvas, one WebGL context, one frame loop, and one
  shared camera. MapLibre owns the camera and rendering lifecycle, while LMV draws the geo-located model using MapLibre’s view-projection matrix.
  The result is a synchronized 2D/3D view without iframes, overlays, or camera drift.

https://github.com/user-attachments/assets/b42dad14-bb28-4f28-ab5a-5667cd92d023

Demo: https://gowen.dev/autodesk-and-arcgis-aec-viewer/

Linked In: https://lnkd.in/p/gS-c2mfE

AU Class: https://conferences.autodesk.com/flow/autodesk/au2026/sessioncatalog/page/inperson/session/1775631134042001sZ4A

  The demo shows how to:

  - Load geo-located Revit/SVF2 models based on the map camera.
  - Convert Revit georeferencing metadata into WGS84 and GeoJSON footprints.
  - Combine BIM models with ArcGIS basemaps, terrain, feature layers, and location services.
  - Use LMV capabilities such as properties, selection, measurement, sectioning, visual clustering, and walk mode.
  - Visualize construction phasing and delivery routes at geospatial scale.
  - Extend the workflow with terrain, utility networks, corridor twins, and asset-management data.
  - Use Puppeteer, shader debug layers, frame instrumentation, and render-loop profiling to improve AI-assisted 3D development.

  The bridge is approximately 300 lines of TypeScript across lmv-loader.ts and lmv-maplibre-bridge.ts.

  Goal: provide an open, extensible foundation for building bespoke construction and asset-intelligence applications that connect BIM, GIS,
  terrain, logistics, and digital-twin workflows in a single view.

  
----




# AEC Meets GIS — Handout

**BLD4212 — Autodesk Platform Services Viewer and Esri’s MapLibre SDK for Construction and Asset Intelligence**

> **Session premise.** This talk is for developers who want to build a custom solution for construction-site intelligence—combining a design-side viewer built on Autodesk Platform Services with authoritative geospatial data and services from Esri, unified in a lightweight, open-source MapLibre GL JS application.

## Contents

1. [AEC is a spatial problem](#aec-is-a-spatial-problem)
2. [Core ArcGIS story](#core-arcgis-story)
3. [Existing ArcGIS × Autodesk integrations](#existing-arcgis--autodesk-integrations)
4. [Today’s focus: custom construction-site intelligence](#todays-focus-custom-construction-site-intelligence)
5. [Our custom MapLibre app](#our-custom-maplibre-app)
6. [How the APS Viewer/LMV bridge works](#how-the-aps-viewerlmv-bridge-works)
7. [Demo workflow: models, GIS layers, and asset intelligence](#demo-workflow-models-gis-layers-and-asset-intelligence)
8. [From Revit/SVF2 metadata to GeoJSON](#from-revitsvf2-metadata-to-geojson)
9. [Construction logistics and 4D phasing](#construction-logistics-and-4d-phasing)
10. [Terrain and geospatial context](#terrain-and-geospatial-context)
11. [AI-assisted 3D/WebGL development](#ai-assisted-3dwebgl-development)
12. [ArcGIS services](#arcgis-services)
13. [For developers: use ArcGIS Location Platform](#for-developers-use-arcgis-location-platform)
14. [Build from the examples](#build-from-the-examples)
15. [References](#references)

## AEC is a spatial problem

Architecture, engineering, and construction (AEC) is fundamentally a spatial discipline: every project sits in a real-world location with its own terrain, hydrology, utilities, parcels, and regulatory context. The Autodesk and Esri stories come together when design information must be understood in the context of the real site. This handout focuses on construction-site intelligence, especially the estimation phase and on-the-ground logistics.

## Core ArcGIS story

Esri’s ArcGIS is the geospatial platform that AEC firms use to plan, design, build, and operate in the built and natural environment. GIS brings location intelligence to project delivery—improving workflows, adding real-world context to designs, and increasing collaboration across the project life cycle. Architects, engineers, builders, and owners use it to build smarter communities and assets for the future ([ArcGIS for AEC](https://www.esri.com/en-us/industries/aec/overview)).

- **GIS + BIM:** Integrating GIS and building information modeling (BIM) creates an environment where project professionals and stakeholders collaborate across the full life cycle, leading to more predictable outcomes.
- **Digital twins:** GIS creates digital twins of the natural and built environment, integrating many types of digital models—physical objects, processes, relationships, and behaviors.
- **Reality mapping:** Integrated collection and analysis of site conditions informs decisions with impact for years.
- **Project delivery:** Location acts as the “digital thread” joining planning, design, construction, and operations without complex hand-off schemes.

## Existing ArcGIS × Autodesk integrations

Esri and Autodesk have a strategic alliance, and two flagship integrations already bring GIS and BIM together. Understanding them clarifies where a custom solution adds value.

### ArcGIS for Autodesk Forma

- Integrates authoritative ArcGIS data directly into Autodesk Forma Site Design, the AI-powered cloud software for early-stage design and analysis.
- Brings environmental and spatial context—parcels, land use, roads, utilities, imagery, soils, and hydrology—from ArcGIS Basemaps and ArcGIS Living Atlas into the Forma design environment, then carries georeferenced designs forward into Autodesk Revit.
- Requires a Contributor (or higher) ArcGIS Online or ArcGIS Enterprise user type; it is targeted at architects, planners, and designers, with no GIS expertise required.

### ArcGIS GeoBIM

- Provides a connected data environment linking AEC information in Autodesk Forma (formerly Autodesk Construction Cloud) and BIM 360 with geospatial data and services in ArcGIS.
- Automatically georeferences project documents and issues into hosted feature layers, maps, and scenes; it renders 3D models and issue dashboards in real-world context without moving or duplicating data.
- Configurable web apps let stakeholders locate, analyze, and engage with georeferenced documents, issues, and schedules across projects or portfolios.

## Today’s focus: custom construction-site intelligence

Forma and GeoBIM excel across the design and coordination life cycle. The custom application shown in this session zooms in on the construction-site intelligence problem—two moments where blending design data with authoritative geospatial data pays off most:

- **Estimation phase:** Understand a site before breaking ground—parcels and ownership, existing utilities, terrain and elevation, hydrology, and demographic or market context that drive quantities, risk, and cost.
- **On-the-ground logistics:** Route material deliveries and crews, geocode addresses and staging points, find places of interest near the site, and use elevation profiles for grading and access.

The hidden concept slide also points toward three broader patterns: a corridor twin across a real route, utility-strike checks that compare networks with the model’s MEP footprint, and 4D sequencing paired with live-traffic detours. These are extension areas for the same bridge; the model and GIS layers can change without changing the integration pattern.

## Our custom MapLibre app

The heart of the talk is a custom web app built on MapLibre GL JS with the MapLibre ArcGIS plugin. It sits at the intersection of the Autodesk and Esri stacks, pulling the APS viewer and ArcGIS services into a single, open surface and giving developers more control than a pre-built integration.

### More flexible than existing integrations

- A custom app is more flexible than an existing Forma or GeoBIM integration. Those are excellent, opinionated products, but a bespoke solution is not constrained by their templates, UI, or workflow assumptions.
- A custom app can be fully tailored, performant, and cost-aware: build exactly what is needed, pay only for the services actually consumed, and keep the application focused on the customer’s workflow.

### Why MapLibre GL JS?

MapLibre GL JS is a JavaScript mapping library for web browsers, fully open source under the permissive BSD-3-Clause license. It began in 2020 as a community fork of Mapbox GL JS 1.13 after Mapbox re-licensed its software, and it is now widely adopted, with backing from Esri and Amazon.

- **Open source, popular, and widely supported:** An active community and ecosystem provide longevity, learning resources, and plugins.
- **High performance and low footprint:** WebGL-native rendering is designed for vector data and data-driven styling.

### The value of open source

- **Open core:** MapLibre is supported by both providers, so an application can combine services from Esri and Autodesk without choosing a closed, single-vendor surface.
- **Extensible with plugins:** Open standards and plugins reduce lock-in. Other open-source libraries, including Esri Leaflet, OpenLayers, and CesiumJS, remain options for specialized needs.
- **A productive AI surface:** Because MapLibre is open and widely used, AI coding assistants have substantial training context for its APIs. An open API surface is easier for agents to inspect, modify, and test.
- **ArcGIS MCP services:** The MCP for ArcGIS Location Services (beta) exposes geocoding, routing, elevation, and static maps as tools that an AI agent can discover and chain from a natural-language request, subject to normal service consumption.

## How the APS Viewer/LMV bridge works

The APS Viewer’s Large Model Viewer (LMV) is built on three.js. The bridge does not place LMV in an iframe, stack a second canvas, or composite screenshots. It makes both renderers participate in the same MapLibre frame.

### One canvas, one context, one frame

- **MapLibre GL JS owns** the camera, frame loop, and left-button input used for panning.
- **APS Viewer/LMV renders** the BIM model; its independent render loop is stopped.
- A custom MapLibre layer named `lmv-model` is registered in the map.
- Each frame, MapLibre supplies its view-projection matrix (a `float64` matrix in the bridge) to LMV.
- LMV draws inside MapLibre’s frame using that matrix. State events call `triggerRepaint()` so MapLibre knows when LMV needs another frame.

The result is one shared canvas, one WebGL context, and one camera. When the map pans or tilts, the model moves with it rather than drifting as a separately synchronized overlay. In the demo, the model is geo-pinned in world space around Brownsville, Pennsylvania.

### The bridge is deliberately small

The presentation describes the bridge as approximately 300 lines of TypeScript split across two files:

- `lmv-loader.ts`
- `lmv-maplibre-bridge.ts`

The implementation was born in a live DevCon Europe 2026 AI coding demo, then hardened in pull request #1 and verified with Puppeteer. The source is available in [`gowin20/autodesk-and-arcgis-aec-viewer`](https://github.com/gowin20/autodesk-and-arcgis-aec-viewer).

### How the work evolved

1. An AI benchmark for graphics and 3D coding.
2. A live DevCon Europe talk using AI to attempt the two-renderer, one-WebGL-context challenge.
3. An Esri Developer Summit conversation about MapLibre and open-source GIS.
4. Joint brainstorming about bridging BIM and GIS.
5. The AU 2026 construction and asset-intelligence demonstration.

The earlier live demo was the origin, not the final architecture: the AU version focuses on a repeatable bridge and the construction workflows it enables.

## Demo workflow: models, GIS layers, and asset intelligence

The first demo combines the full LMV feature set with a MapLibre map and ArcGIS data. Standard Revit sample models—RAC basic, RAC advanced, and the DACH building—were converted to SVF2 assets. Their embedded geolocation was extracted into WGS84, and GeoJSON outlines and pins were generated for the map.

### Camera-driven multi-model loading

As the user zooms toward a pin, the corresponding model loads. As the user zooms away or moves to another site, the next model can load when it is close enough to the camera frustum. This is a lightweight, 3D-Tiles-style loading pattern driven by the map camera rather than a collection of manually positioned viewers.

The same canvas exposes standard LMV capabilities, including:

- Model browsing and properties.
- Element selection, highlighting, hide/show, and isolation.
- Measurement and sectioning tools.
- Visual clustering.
- The walk or first-person navigation tool.

This turns a collection of geo-located BIM assets into an asset-management view: the map provides the regional context and the viewer provides the building-level detail.

## From Revit/SVF2 metadata to GeoJSON

The demo reads the SVF2 manifest metadata created from Revit. The metadata includes the model’s georeference information and a `positionLL84` reference in WGS84, together with the model bounding box and transformation information. The application uses that information to create two useful GeoJSON features:

1. An approximate AABB footprint outline, converted from model coordinates to longitude/latitude.
2. A WGS84 point at the model’s georeferenced reference position, used for the map pin.

The footprint center is kept for diagnostics, but the map marker is placed on the model’s georeferenced datum rather than forcing the pin to the axis-aligned bounding-box center. The resulting GeoJSON can be consumed by MapLibre or passed to ArcGIS for further coordination.

The source example is [`wallabyway/acc-folder-rvt-on-map`](https://github.com/wallabyway/acc-folder-rvt-on-map). The presentation calls out that the current outline is an approximation; future improvements may use more precise WKID and WKT2 metadata and better georeferencing collaboration between Autodesk and Esri.

## Construction logistics and 4D phasing

The second demo combines two classic APS examples into a construction-management workflow:

- Revit phasing information.
- A Microsoft Project plan or other project timeline.
- LMV animation, including floor-by-floor construction sequencing.
- MapLibre’s drawing tools and geospatial coordinate system.

A new timeline slider drives LMV’s phasing animation. A delivery route can be drawn from a supplier or holding area to the construction site, then used to communicate a logistics strategy across a regional or even multi-hundred-mile route. Because the route is GeoJSON in WGS84, it remains usable in MapLibre and can be moved into ArcGIS for analysis and collaboration.

This creates a path toward 4D logistics at geospatial scale: ask which phase is active, when materials must arrive, where staging can occur, and how the plan interacts with local traffic and terrain—all while keeping the building and the route in one view.

The APS starting points are the [APS code samples](https://aps.autodesk.com/code-samples), the [phasing demo](https://aps.autodesk.com/code-samples), and Michael Beale’s [APS author page](https://aps.autodesk.com/author/michael-beale) and phasing extension used in this demo: [phase-lmv-extension repo](https://github.com/wallabyway/phase-lmv-extension)

## Terrain and geospatial context

MapLibre plugins extend the base map beyond flat rendering. With an elevation-tile source and the terrain plugin, the model’s location can be shown with surrounding terrain—for example, the Snowdon Tower location in the demo. Terrain makes the construction problem more realistic: access, grading, delivery routes, and visibility depend on the shape of the site, not only its latitude and longitude.

https://gist.github.com/wallabyway/42398496b61117cb0da1402322583bbf

## AI-assisted 3D/WebGL development

The presentation’s final technical section is a practical workflow for improving AI at 3D coding tasks. The central idea is simple: give the agent eyes and measurable goals.

### A render-loop workflow

1. **Set a goal:** Start with a concrete target such as 30 FPS.
2. **Use Puppeteer:** Let the agent launch the browser and inspect screenshots or rendered buffers through a visual test harness.
3. **Expose shader layers:** Ask for G-buffers, segmentation maps, depth, post-processing passes, and other debug views.
4. **Add instrumentation:** Mark frames so the agent can see frame budgets and identify which feature consumes time.
5. **Profile the render loop:** Track redundant draw resets, frame invalidations, and per-feature overhead. Run each feature with its own instrumentation.

When an agent can see debug shader layers and render-loop timings, it is less likely to make changes that reinitialize the entire frame for a small style update. A vision-language model can inspect those intermediate layers and reason about depth, segmentation, normals, and other rendering stages rather than relying only on source code.

### Vector tiles and shadows

One example applies shadow mapping to a MapLibre OpenStreetMap building layer. The debugging process examines the depth map, cascades, segmentation, normals, and related passes until the issue is isolated and fixed. The companion example is [`wallabyway/maplibre-building-shadows`](https://github.com/wallabyway/maplibre-building-shadows/).

The broader lesson is transferable: instrument the renderer, expose intermediate buffers, and make performance budgets visible to both humans and AI agents. The target is a stable, measurable 30–60 FPS experience rather than an opaque render loop that appears to work only until the scene becomes complex.

## ArcGIS services

On the Esri side, three complementary categories of ArcGIS services feed a construction-site intelligence app: open GIS data, analysis results, and ready-to-use location services. All are accessible to developers through ArcGIS Location Platform.

### Open GIS data

Authoritative, ready-to-use geographic data provides the foundation layers a site-intelligence app draws on.

- **ArcGIS Hub:** A cloud-based community-engagement and open-data platform. Government agencies and organizations publish trusted datasets that can be discovered, filtered, and downloaded as CSV, KML, GeoJSON, GeoTIFF, or PNG, or consumed through GeoServices/WMS/WFS APIs ([hub.arcgis.com](https://hub.arcgis.com)).
- **ArcGIS Living Atlas of the World:** A collection of authoritative maps, layers, imagery, and tools from Esri, its partners, and the global GIS community, spanning imagery, basemaps, demographics, boundaries, transportation, and live feeds ([livingatlas.arcgis.com](https://livingatlas.arcgis.com)).

### Useful data for a construction site

- **Parcels:** Ownership boundaries and land-use classifications establish the legal and zoning footprint of a site.
- **Utilities:** Power, water, and road infrastructure networks help teams understand existing services and avoid clashes during construction.
- **Terrain and elevation:** Surface elevation, slope, and elevation change inform earthworks, cut-and-fill estimates, and site access.
- **Hydrology:** Watersheds, flow paths, and flood context influence drainage, grading, and environmental risk.

### Custom data and analysis results

Beyond raw data, ArcGIS spatial analysis services turn inputs into decision-ready insight. A custom app can combine its own feature and tile layers with analysis results and the BIM-derived GeoJSON shown above.

### ArcGIS Location services

Location services are ready-to-use web services hosted by Esri that provide essential geospatial functionality for a mapping app—without requiring the application team to operate the underlying infrastructure or manage all source data.

- **Routing:** Turn-by-turn directions, multi-stop optimization, barrier avoidance for road closures or construction zones, and service-area generation for deliveries and crews.
- **Service areas:** Drive-time or distance areas, such as the suppliers or facilities within a 15-minute drive of the site.
- **Geocoding:** Forward and reverse geocoding with smart autocomplete for staging points, deliveries, and addresses.
- **Basemaps:** More than 50 vector or raster styles, with language and worldview support, for visual and geographic context.

## For developers: use ArcGIS Location Platform

Esri offers several products, but this talk is for developers, so it builds on ArcGIS Location Platform, a developer-focused Platform-as-a-Service. It is lightweight, modular, and designed for developers first: choose the services needed, authenticate with an API key, and integrate them into the MapLibre application.

- **Free tier + pay-as-you-go:** A monthly free tier for select services and a transparent consumption-based model; pay for usage above the free tier.
- **Commercial deployment:** A subscription designed for unlimited public and private commercial applications.
- **Three service categories:** Location services (basemaps, geocoding, routing, places, elevation, and GeoEnrichment), data services (host feature and tile layers), and spatial analysis services (hydrology, elevation, geometry, and more).
- **Exclusive services:** Places, Elevation, and Static Basemap Tiles are available through ArcGIS Location Platform.

## Build from the examples

The session’s closing message is to build a bespoke digital twin for the site, asset, or customer rather than waiting for a product roadmap when a lighter, tailored solution is the better fit. Start with the open examples and replace the model and layers with the data that represents the real problem:

- APS LMV/MapLibre bridge: [`gowin20/autodesk-and-arcgis-aec-viewer`](https://github.com/gowin20/autodesk-and-arcgis-aec-viewer)
- APS MapLibre LMV plugin: `@aps/maplibre-lmv-plugin`
- Esri MapLibre integration: `@esri/maplibre-arcgis`
- Revit/SVF2 footprint extraction: [`wallabyway/acc-folder-rvt-on-map`](https://github.com/wallabyway/acc-folder-rvt-on-map)
- MapLibre building-shadow example: [`wallabyway/maplibre-building-shadows`](https://github.com/wallabyway/maplibre-building-shadows/)

The architectural pattern is reusable: one MapLibre camera and frame, an LMV custom layer for BIM, ArcGIS basemaps and feature layers for context, and application-specific GeoJSON for assets, routes, phases, or analysis results.

## References

### Source presentations and examples

- [APS Viewer + MapLibre bridge source](https://github.com/gowin20/autodesk-and-arcgis-aec-viewer)
- [Revit outline and GeoJSON example](https://github.com/wallabyway/acc-folder-rvt-on-map)
- [MapLibre building shadows](https://github.com/wallabyway/maplibre-building-shadows/)
- [APS code samples](https://aps.autodesk.com/code-samples)
- [Michael Beale’s APS author page](https://aps.autodesk.com/author/michael-beale)
- DevCon Europe precursor: [“(Advanced) Vibe Coding with APS Viewer”](https://youtube.com/watch?v=T6HmQwbrcAY)
- MapLibre ArcGIS, *Building Web Apps* — Esri Dev Summit 2026 (George Owen).
- *ArcGIS Maps SDKs: A Developer’s Guide to Location Services* — UC 2025 (Sheryl Tania, George Owen).

### ArcGIS and MapLibre resources

- [ArcGIS for AEC overview](https://www.esri.com/en-us/industries/aec/overview)
- ArcGIS for Autodesk Forma
- ArcGIS GeoBIM
- [ArcGIS Hub](https://hub.arcgis.com) / [ArcGIS Living Atlas](https://livingatlas.arcgis.com)
- ArcGIS Location Platform
- MapLibre ArcGIS developer guide and API reference
- Find data sources for feature analysis
- AI × ArcGIS development workflow (dchantlos)

---

*This handout combines the existing BLD4212 presentation handout with implementation details, demo notes, and development guidance extracted from the accompanying presentation. It is intended as a technical companion, not a replacement for product documentation or service terms.*
