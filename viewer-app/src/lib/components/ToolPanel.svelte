<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { get } from 'svelte/store';
	import {
		findSuggestions,
		getAddressCandidate,
		type GeocodeSuggestion
	} from '$lib/arcgis/geocode';
	import {
		fetchEnabledTravelModes,
		fetchRoute,
		type ServiceAreaTravelModeObject
	} from '$lib/arcgis/routing';
	import {
		elevationQueryEnabled,
		enabledTravelModes,
		geocodingQuery,
		mapCenter,
		routePlannerLocations,
		routePlannerRouteGeoJson,
		selectedSearchLocation,
		serviceAreaEnabled,
		type ViewerLocation
	} from '$lib/state/location-services';

	const arcgisToken =
		import.meta.env.VITE_ARCGIS_ACCESS_TOKEN?.trim() ??
		import.meta.env.PUBLIC_ARCGIS_ACCESS_TOKEN?.trim() ??
		'';

	const hasArcgisToken = arcgisToken.length > 0;

	type RouteDestinationInput = {
		id: string;
		query: string;
		suggestions: GeocodeSuggestion[];
		isSearching: boolean;
		error: string | null;
		selectedLocation: ViewerLocation | null;
		requestId: number;
		timer: ReturnType<typeof setTimeout> | undefined;
	};

	type RouteSummary = {
		distanceText: string;
		durationText: string;
		label: string;
		subLabel: string;
	};

	type RouteDirectionStep = {
		id: string;
		text: string;
		distanceText: string;
		timeText: string;
	};

	let isServiceAreaEnabled = $state(false);
	let isElevationQueryEnabled = $state(false);
	let isLoadingTravelModes = $state(false);
	let travelModesLoadError = $state<string | null>(null);
	let hasServiceAreaTravelModes = $state(false);
	let geocodingSearchQuery = $state('');
	let geocodeSuggestions = $state<GeocodeSuggestion[]>([]);
	let geocodeError = $state<string | null>(null);
	let isGeocoding = $state(false);
	let suggestionTimer: ReturnType<typeof setTimeout> | undefined;
	let suggestionRequestId = 0;
	let availableRouteTravelModes = $state<ServiceAreaTravelModeObject[]>([]);
	let selectedRouteTravelModeName = $state('');
	let showDirectionsPlanner = $state(false);
	let routeDestinationInputs = $state<RouteDestinationInput[]>([]);
	let optimizeRoute = $state(false);
	let routeSolveError = $state<string | null>(null);
	let isSolvingRoute = $state(false);
	let routeSummary = $state<RouteSummary | null>(null);
	let routeDirectionSteps = $state<RouteDirectionStep[]>([]);
	let showTurnByTurn = $state(false);

	const createRouteDestinationInput = (): RouteDestinationInput => ({
		id: `route-stop-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
		query: '',
		suggestions: [],
		isSearching: false,
		error: null,
		selectedLocation: null,
		requestId: 0,
		timer: undefined
	});

	const ensureInitialRouteDestinations = () => {
		if (routeDestinationInputs.length >= 2) return;
		routeDestinationInputs = [createRouteDestinationInput(), createRouteDestinationInput()];
	};

	const syncRoutePlannerLocations = () => {
		const locations = routeDestinationInputs
			.map((destination, index) => {
				if (!destination.selectedLocation) return null;
				return {
					id: destination.id,
					order: index + 1,
					longitude: destination.selectedLocation.longitude,
					latitude: destination.selectedLocation.latitude,
					label: destination.selectedLocation.label
				};
			})
			.filter((location): location is NonNullable<typeof location> => Boolean(location));
		routePlannerLocations.set(locations);
	};

	const formatDuration = (minutes: number | undefined): string => {
		if (typeof minutes !== 'number' || !Number.isFinite(minutes)) return 'Unavailable';
		const roundedMinutes = Math.max(Math.round(minutes), 0);
		const hours = Math.floor(roundedMinutes / 60);
		const remainingMinutes = roundedMinutes % 60;
		if (hours <= 0) return `${remainingMinutes} min`;
		return `${hours} hr ${remainingMinutes} min`;
	};

	const formatDistance = (kilometers: number | undefined): string => {
		if (typeof kilometers !== 'number' || !Number.isFinite(kilometers)) return 'Unavailable';
		return `${Math.round(kilometers).toLocaleString()} km`;
	};

	const getNumber = (value: unknown): number | undefined =>
		typeof value === 'number' && Number.isFinite(value) ? value : undefined;

	const extractRouteResults = (response: unknown): {
		summary: RouteSummary | null;
		steps: RouteDirectionStep[];
		geoJson: Record<string, unknown> | null;
	} => {
		const raw = response as Record<string, unknown>;
		const routeResults = Array.isArray(raw.routeResults)
			? (raw.routeResults as Array<Record<string, unknown>>)
			: [];
		const firstRouteResult = routeResults[0] ?? {};
		const routeObject = (firstRouteResult.route as Record<string, unknown> | undefined) ?? {};
		const routeAttributes = (routeObject.attributes as Record<string, unknown> | undefined) ?? {};
		const distanceKilometers =
			getNumber(routeAttributes.Total_Kilometers) ??
			getNumber(routeAttributes.Kilometers) ??
			getNumber(routeAttributes.Shape_Length);
		const durationMinutes =
			getNumber(routeAttributes.Total_TravelTime) ?? getNumber(routeAttributes.Total_Minutes);
		const summary =
			typeof distanceKilometers === 'number' || typeof durationMinutes === 'number'
				? {
						distanceText: formatDistance(distanceKilometers),
						durationText: formatDuration(durationMinutes),
						label: `${formatDuration(durationMinutes)} (${formatDistance(distanceKilometers)})`,
						subLabel: 'Route directions'
					}
				: null;

		const rawDirections = firstRouteResult.directions as Record<string, unknown> | undefined;
		const directionFeatures = Array.isArray(rawDirections?.features)
			? (rawDirections.features as Array<Record<string, unknown>>)
			: [];
		const steps = directionFeatures
			.map((feature, index) => {
				const attributes = (feature.attributes as Record<string, unknown> | undefined) ?? {};
				const text = typeof attributes.text === 'string' ? attributes.text : undefined;
				if (!text) return null;
				return {
					id: `direction-${index}`,
					text,
					distanceText: formatDistance(
						getNumber(attributes.length) ?? getNumber(attributes.length_km)
					),
					timeText: formatDuration(getNumber(attributes.time))
				};
			})
			.filter((step): step is RouteDirectionStep => Boolean(step));

		const routeFeatureSet = raw.routes as Record<string, unknown> | undefined;
		const geoJson = (routeFeatureSet?.geoJson as Record<string, unknown> | undefined) ?? null;

		return { summary, steps, geoJson };
	};

	onMount(() => {
		ensureInitialRouteDestinations();
		syncRoutePlannerLocations();

		const unsubscribeServiceAreaEnabled = serviceAreaEnabled.subscribe((enabled) => {
			isServiceAreaEnabled = enabled;
		});
		const unsubscribeElevationQueryEnabled = elevationQueryEnabled.subscribe((enabled) => {
			isElevationQueryEnabled = enabled;
		});
		const unsubscribeGeocodingQuery = geocodingQuery.subscribe((query) => {
			geocodingSearchQuery = query;
		});
		const unsubscribeEnabledTravelModes = enabledTravelModes.subscribe((modes) => {
			availableRouteTravelModes = modes?.supportedTravelModes ?? [];
			const modeNames = new Set(
				availableRouteTravelModes
					.map((mode) => (typeof mode.name === 'string' ? mode.name : ''))
					.filter(Boolean)
			);
			if (!modeNames.has(selectedRouteTravelModeName)) {
				selectedRouteTravelModeName =
					(typeof modes?.driving?.name === 'string' && modes.driving.name) ||
					(typeof availableRouteTravelModes[0]?.name === 'string' ? availableRouteTravelModes[0].name : '');
			}
		});

		void (async () => {
			if (!hasArcgisToken) {
				enabledTravelModes.set(null);
				travelModesLoadError =
					'Set VITE_ARCGIS_ACCESS_TOKEN (or PUBLIC_ARCGIS_ACCESS_TOKEN) to enable routing and location services.';
				return;
			}

			try {
				isLoadingTravelModes = true;
				const travelModes = await fetchEnabledTravelModes();
				enabledTravelModes.set(travelModes);
				hasServiceAreaTravelModes = Boolean(travelModes.driving || travelModes.walking);
				console.log(`[ArcGIS Routing] Retrieved ${travelModes.supportedTravelModes.length} travel modes.`);
				if (!hasServiceAreaTravelModes) {
					travelModesLoadError =
						'Routing service returned no supported Driving Time or Walking Time travel modes.';
					serviceAreaEnabled.set(false);
				} else {
					travelModesLoadError = null;
				}
			} catch (error: unknown) {
				travelModesLoadError =
					error instanceof Error ? error.message : 'Unable to load enabled travel modes.';
				enabledTravelModes.set(null);
				hasServiceAreaTravelModes = false;
				serviceAreaEnabled.set(false);
				elevationQueryEnabled.set(false);
			} finally {
				isLoadingTravelModes = false;
			}
		})();

		return () => {
			unsubscribeServiceAreaEnabled();
			unsubscribeElevationQueryEnabled();
			unsubscribeGeocodingQuery();
			unsubscribeEnabledTravelModes();
		};
	});

	const toggleServiceArea = () => {
		if (!hasArcgisToken || isLoadingTravelModes || travelModesLoadError || !hasServiceAreaTravelModes) {
			return;
		}
		const enabled = !isServiceAreaEnabled;
		serviceAreaEnabled.set(enabled);
		if (enabled) elevationQueryEnabled.set(false);
	};

	const toggleElevationQuery = () => {
		if (!hasArcgisToken || Boolean(travelModesLoadError)) {
			return;
		}
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

	const updateRouteDestinationInput = (
		destinationId: string,
		updater: (destination: RouteDestinationInput) => RouteDestinationInput
	) => {
		routeDestinationInputs = routeDestinationInputs.map((destination) =>
			destination.id === destinationId ? updater(destination) : destination
		);
	};

	const onRouteDestinationAutocompleteInput = (destinationId: string, event: Event) => {
		const target = event.target as { inputValue?: string } | null;
		const query = target?.inputValue?.trim() ?? '';
		routeSolveError = null;

		const destination = routeDestinationInputs.find((entry) => entry.id === destinationId);
		if (!destination) return;

		if (destination.timer) clearTimeout(destination.timer);
		const requestId = destination.requestId + 1;
		updateRouteDestinationInput(destinationId, (entry) => ({
			...entry,
			query,
			requestId,
			error: null,
			selectedLocation: null,
			suggestions: query.length < 3 ? [] : entry.suggestions,
			isSearching: query.length >= 3
		}));
		syncRoutePlannerLocations();
		routePlannerRouteGeoJson.set(null);
		routeSummary = null;
		routeDirectionSteps = [];
		showTurnByTurn = false;

		if (query.length < 3) {
			return;
		}

		const timer = setTimeout(() => {
			void findSuggestions(query, get(mapCenter))
				.then((suggestions) => {
					const currentEntry = routeDestinationInputs.find((entry) => entry.id === destinationId);
					if (!currentEntry || currentEntry.requestId !== requestId) return;
					updateRouteDestinationInput(destinationId, (entry) => ({
						...entry,
						suggestions: suggestions ?? [],
						isSearching: false
					}));
				})
				.catch((error: unknown) => {
					const currentEntry = routeDestinationInputs.find((entry) => entry.id === destinationId);
					if (!currentEntry || currentEntry.requestId !== requestId) return;
					updateRouteDestinationInput(destinationId, (entry) => ({
						...entry,
						suggestions: [],
						isSearching: false,
						error: error instanceof Error ? error.message : 'Address suggestions failed.'
					}));
				});
		}, 250);

		updateRouteDestinationInput(destinationId, (entry) => ({
			...entry,
			timer
		}));
	};

	const searchRouteDestination = async (destinationId: string) => {
		const destination = routeDestinationInputs.find((entry) => entry.id === destinationId);
		if (!destination) return;
		const query = destination.query.trim();
		if (!query) {
			updateRouteDestinationInput(destinationId, (entry) => ({
				...entry,
				error: 'Enter a destination before searching.'
			}));
			return;
		}

		updateRouteDestinationInput(destinationId, (entry) => ({
			...entry,
			isSearching: true,
			error: null
		}));
		try {
			const topSuggestion = destination.suggestions[0];
			const candidate = await getAddressCandidate(
				topSuggestion?.text ?? query,
				topSuggestion?.magicKey ?? null
			);
			if (!candidate) {
				throw new Error('No matching location was found.');
			}
			updateRouteDestinationInput(destinationId, (entry) => ({
				...entry,
				query: candidate.address,
				suggestions: [],
				isSearching: false,
				selectedLocation: {
					longitude: candidate.location.x,
					latitude: candidate.location.y,
					label: candidate.address
				}
			}));
			syncRoutePlannerLocations();
		} catch (error: unknown) {
			updateRouteDestinationInput(destinationId, (entry) => ({
				...entry,
				isSearching: false,
				error: error instanceof Error ? error.message : 'Address search failed.'
			}));
		}
	};

	const selectRouteDestinationSuggestion = async (
		destinationId: string,
		suggestion: GeocodeSuggestion
	) => {
		updateRouteDestinationInput(destinationId, (entry) => ({
			...entry,
			isSearching: true,
			error: null
		}));
		try {
			const candidate = await getAddressCandidate(suggestion.text, suggestion.magicKey);
			if (!candidate) {
				throw new Error('No matching location was found.');
			}
			updateRouteDestinationInput(destinationId, (entry) => ({
				...entry,
				query: candidate.address,
				suggestions: [],
				isSearching: false,
				selectedLocation: {
					longitude: candidate.location.x,
					latitude: candidate.location.y,
					label: candidate.address
				}
			}));
			syncRoutePlannerLocations();
		} catch (error: unknown) {
			updateRouteDestinationInput(destinationId, (entry) => ({
				...entry,
				isSearching: false,
				error: error instanceof Error ? error.message : 'Address search failed.'
			}));
		}
	};

	const addRouteStop = () => {
		routeDestinationInputs = [...routeDestinationInputs, createRouteDestinationInput()];
	};

	const removeRouteStop = (destinationId: string) => {
		if (routeDestinationInputs.length <= 2) {
			return;
		}
		const destination = routeDestinationInputs.find((entry) => entry.id === destinationId);
		if (destination?.timer) clearTimeout(destination.timer);
		routeDestinationInputs = routeDestinationInputs.filter((entry) => entry.id !== destinationId);
		syncRoutePlannerLocations();
	};

	const onRouteStopsOrderChange = (event: Event) => {
		const detail = (
			event as CustomEvent<{
				fromIndex?: number;
				toIndex?: number;
				oldIndex?: number;
				newIndex?: number;
			}>
		).detail;
		if (!detail) return;
		const fromIndex = detail.fromIndex ?? detail.oldIndex;
		const toIndex = detail.toIndex ?? detail.newIndex;
		if (
			typeof fromIndex !== 'number' ||
			typeof toIndex !== 'number' ||
			fromIndex < 0 ||
			toIndex < 0 ||
			fromIndex >= routeDestinationInputs.length ||
			toIndex >= routeDestinationInputs.length ||
			fromIndex === toIndex
		) {
			return;
		}

		const nextInputs = [...routeDestinationInputs];
		const [movedStop] = nextInputs.splice(fromIndex, 1);
		nextInputs.splice(toIndex, 0, movedStop);
		routeDestinationInputs = nextInputs;
		syncRoutePlannerLocations();
	};

	const toggleDirectionsPlanner = () => {
		showDirectionsPlanner = !showDirectionsPlanner;
		if (!showDirectionsPlanner) {
			routePlannerRouteGeoJson.set(null);
			routeSummary = null;
			routeDirectionSteps = [];
			showTurnByTurn = false;
		}
	};

	const solveRouteDirections = () => {
		const routeStops = routeDestinationInputs
			.map((destination) => destination.selectedLocation)
			.filter((location): location is ViewerLocation => Boolean(location))
			.map((location) => [location.longitude, location.latitude] as [number, number]);

		if (routeStops.length < 2) {
			routeSolveError = 'Specify at least two valid stops to calculate directions.';
			return;
		}

		const selectedTravelMode = availableRouteTravelModes.find(
			(mode) => mode.name === selectedRouteTravelModeName
		);
		if (!selectedTravelMode) {
			routeSolveError = 'Select a travel mode before calculating directions.';
			return;
		}

		routeSolveError = null;
		isSolvingRoute = true;
		void fetchRoute(routeStops as [[number, number], [number, number], ...[number, number][]], {
			travelMode: selectedTravelMode,
			findBestSequence: optimizeRoute,
			returnStops: optimizeRoute
		})
			.then((response) => {
				const { summary, steps, geoJson } = extractRouteResults(response);
				routeSummary = summary;
				routeDirectionSteps = steps;
				showTurnByTurn = false;
				routePlannerRouteGeoJson.set(geoJson);
			})
			.catch((error: unknown) => {
				routeSolveError = error instanceof Error ? error.message : 'Route calculation failed.';
				routePlannerRouteGeoJson.set(null);
			})
			.finally(() => {
				isSolvingRoute = false;
			});
	};

	onDestroy(() => {
		if (suggestionTimer) clearTimeout(suggestionTimer);
		for (const destination of routeDestinationInputs) {
			if (destination.timer) clearTimeout(destination.timer);
		}
		routePlannerLocations.set([]);
		routePlannerRouteGeoJson.set(null);
	});
</script>

<calcite-panel heading="Tools" description="Location services and analysis">
	<calcite-block heading="Location services" description="Search and analysis" open>
		{#if !hasArcgisToken}
			<calcite-notice open kind="warning" icon>
				<div slot="message">
					Set VITE_ARCGIS_ACCESS_TOKEN (or PUBLIC_ARCGIS_ACCESS_TOKEN) to enable location services.
				</div>
			</calcite-notice>
		{:else}
			<calcite-block heading="Geocoding" description="Address and place search" open>
				<calcite-label>
					Search
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

			<calcite-block class="tool-subpanel" heading="Elevation" description="Elevation analysis" open>
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
			</calcite-block>

			<calcite-block class="tool-subpanel" heading="Routing" description="Network analysis requests" open>
				{#if isLoadingTravelModes}
					<calcite-notice open kind="info" icon>
						<div slot="message">Loading enabled travel modes...</div>
					</calcite-notice>
				{:else if travelModesLoadError}
					<calcite-notice open kind="danger" icon>
						<div slot="message">{travelModesLoadError}</div>
					</calcite-notice>
				{:else}
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
					<calcite-button
						class="route-planner-toggle"
						width="full"
						appearance={showDirectionsPlanner ? 'solid' : 'outline'}
						kind="neutral"
						icon-start="directions"
						onclick={toggleDirectionsPlanner}
					>
						Calculate directions
					</calcite-button>
					{#if showDirectionsPlanner}
						<calcite-block class="tool-subpanel" heading="Directions" description="Route solver" open>
							<calcite-list
								class="route-stops-list"
								drag-enabled
								display-mode="flat"
								selection-mode="none"
								oncalciteListOrderChange={onRouteStopsOrderChange}
								label="Destinations"
							>
								{#each routeDestinationInputs as destination, index (destination.id)}
									<calcite-list-item
										drag-handle
										sort-handle-open
										display-mode="flat"
										scale="s"
										selection-mode="none"
										selection-appearance="icon"
										interaction-mode="interactive"
										value={destination.id}
										label={`Stop ${index + 1}`}
										description={destination.selectedLocation ? destination.selectedLocation.label : 'No destination selected'}
									>
										<div class="route-stop-item" slot="content">
											<div class="route-stop-search">
												<calcite-autocomplete
													class="route-stop-autocomplete"
													input-value={destination.query}
													label="Find address or place"
													placeholder="Find address or place"
													icon="search"
													clearable
													loading={destination.isSearching}
													open={destination.suggestions.length > 0}
													oncalciteAutocompleteTextInput={(event) =>
														onRouteDestinationAutocompleteInput(destination.id, event)}
												>
													{#each destination.suggestions as suggestion (suggestion.magicKey)}
														<calcite-autocomplete-item
															heading={suggestion.text}
															value={suggestion.magicKey}
															icon-start="pin"
															oncalciteAutocompleteItemSelect={() =>
																selectRouteDestinationSuggestion(destination.id, suggestion)}
														></calcite-autocomplete-item>
													{/each}
												</calcite-autocomplete>
												<calcite-button
													class="route-stop-search-button"
													appearance="transparent"
													kind="neutral"
													icon-start="search"
													loading={destination.isSearching}
													onclick={() => searchRouteDestination(destination.id)}
												></calcite-button>
											</div>
										</div>
										{#if destination.error}
											<calcite-notice open kind="danger" icon>
												<div slot="message">{destination.error}</div>
											</calcite-notice>
										{/if}
										{#if routeDestinationInputs.length > 2}
											<calcite-action
												slot="actions-end"
												icon="trash"
												text="Delete stop"
												onclick={() => removeRouteStop(destination.id)}
											></calcite-action>
										{/if}
									</calcite-list-item>
								{/each}
							</calcite-list>

							<calcite-button class="add-stop-action" width="full" appearance="outline" icon-start="plus" onclick={addRouteStop}>
								Add stop
							</calcite-button>

							<calcite-label>
								Travel mode
								<calcite-select
									value={selectedRouteTravelModeName}
									oncalciteSelectChange={(event) => {
										selectedRouteTravelModeName = (event.target as { value?: string }).value ?? '';
									}}
								>
									{#each availableRouteTravelModes as mode}
										{#if typeof mode.name === 'string'}
											<calcite-option value={mode.name}>{mode.name}</calcite-option>
										{/if}
									{/each}
								</calcite-select>
							</calcite-label>

							<calcite-label layout="inline-space-between">
								Optimize route
								<calcite-switch
									checked={optimizeRoute}
									oncalciteSwitchChange={(event) =>
										(optimizeRoute = Boolean((event.target as { checked?: boolean }).checked))}
								></calcite-switch>
							</calcite-label>

							<calcite-button width="full" loading={isSolvingRoute} disabled={isSolvingRoute} onclick={solveRouteDirections}>
								Solve route
							</calcite-button>
							{#if routeSolveError}
								<calcite-notice open kind="danger" icon>
									<div slot="message">{routeSolveError}</div>
								</calcite-notice>
							{/if}

							{#if !routeSummary}
								<calcite-notice open kind="info" icon>
									<div slot="message">No route results yet. Add stops and click Solve route.</div>
								</calcite-notice>
							{:else}
								<calcite-flow>
									<calcite-flow-item heading="Route result">
										<calcite-list>
											<calcite-list-item
												label={routeSummary.label}
												description={routeSummary.subLabel}
												onclick={() => (showTurnByTurn = true)}
											></calcite-list-item>
										</calcite-list>
									</calcite-flow-item>
									{#if showTurnByTurn}
										<calcite-flow-item
											heading="Turn-by-turn directions"
											oncalciteFlowItemBack={() => (showTurnByTurn = false)}
										>
											{#if routeDirectionSteps.length === 0}
												<calcite-notice open kind="info" icon>
													<div slot="message">No turn-by-turn directions were returned.</div>
												</calcite-notice>
											{:else}
												<calcite-list>
													{#each routeDirectionSteps as step}
														<calcite-list-item
															label={step.text}
															description={`${step.distanceText} • ${step.timeText}`}
														></calcite-list-item>
													{/each}
												</calcite-list>
											{/if}
										</calcite-flow-item>
									{/if}
								</calcite-flow>
							{/if}
						</calcite-block>
					{/if}
					{#if isServiceAreaEnabled}
						<calcite-notice open kind="info" icon>
							<div slot="message">Click the map to set a facility and configure the request.</div>
						</calcite-notice>
					{/if}
				{/if}
			</calcite-block>
		{/if}
	</calcite-block>
</calcite-panel>

<style>
	.tool-subpanel {
		margin-top: 1rem;
	}

	.route-planner-toggle {
		margin-top: 0.75rem;
	}

	.add-stop-action {
		margin-top: 0.75rem;
	}

	.route-stops-list {
		--calcite-list-item-background-color: transparent;
	}

	.route-stop-item {
		padding-block: 0.125rem;
	}

	.route-stop-search {
		display: grid;
		grid-template-columns: 1fr auto;
		gap: 0.35rem;
		align-items: end;
	}

	.route-stop-autocomplete {
		width: 100%;
	}

	.route-stop-search-button {
		align-self: end;
	}
</style>
