export type AppColorMode = 'light' | 'dark';

// Single global switch for application color mode.
export const APP_COLOR_MODE: AppColorMode = 'dark';

export const applyColorMode = (mode: AppColorMode) => {
	if (typeof document === 'undefined') {
		return;
	}

	const root = document.documentElement;
	root.classList.remove('calcite-mode-light', 'calcite-mode-dark');
	root.classList.add(mode === 'dark' ? 'calcite-mode-dark' : 'calcite-mode-light');
};

export const getLmvTheme = (mode: AppColorMode): 'light-theme' | 'dark-theme' =>
	mode === 'dark' ? 'dark-theme' : 'light-theme';
