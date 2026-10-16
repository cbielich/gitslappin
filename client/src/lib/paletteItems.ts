/** The 33 command palette items the design keeps (V6 "3 Command palette"), alphabetical; wording from en-us.json FuzzyFinder-* and screens/34-command-palette-items.txt. */
export interface PaletteItem {
  id: string;
  label: string;
  keywords?: string;
  needsRepo: boolean;
}

const item = (id: string, label: string, needsRepo: boolean, keywords?: string): PaletteItem => ({ id, label, needsRepo, ...(keywords ? { keywords } : {}) });

export const PALETTE_ITEMS: PaletteItem[] = [
  item('activity-logs', 'Activity Logs', true),
  item('blame', 'Blame', true),
  item('checkout', 'Checkout', true),
  item('clone', 'Clone', false),
  item('close-tab', 'Close Tab', true),
  item('create-annotated-tag', 'Create Annotated Tag', true),
  item('create-branch', 'Create Branch', true),
  item('create-tag', 'Create Tag', true),
  item('zoom-out', 'Decrease Zoom', false),
  item('discard-all', 'Discard all changes', true, 'reset hard all'), // FuzzyFinder-DiscardAllKeywords
  item('fetch-all', 'Fetch All', true),
  item('history', 'History', true),
  item('zoom-in', 'Increase Zoom', false),
  item('init-repo', 'Initialize a Repo', false, 'initialize'), // FuzzyFinder-InitRepoKeywords
  item('keyboard-shortcuts', 'Keyboard Shortcuts', false),
  item('open-repo', 'Open Repo', false),
  item('open-repo-management', 'Open Repository Management Tab', false),
  item('open-terminal', 'Open in default terminal', true),
  item('open-folder', 'Open in file manager', true, 'folder explorer finder'), // FuzzyFinder-OpenInFileManagerKeywords
  item('rename-branch', 'Rename Branch', true),
  item('zoom-reset', 'Reset Zoom', false),
  item('search-commits', 'Search Commits', true),
  item('settings', 'Settings', false, 'preferences options'), // FuzzyFinder-SettingsKeywords
  item('stage-all', 'Stage all changes', true),
  item('stash-apply', 'Stash: Apply', true),
  item('stash-create', 'Stash: Create', true),
  item('stash-pop', 'Stash: Pop', true),
  item('switch-theme', 'Switch Theme', false),
  item('toggle-details-panel', 'Toggle Commit Details Panel', true),
  item('toggle-left-panel', 'Toggle Left Panel', true),
  item('toggle-terminal-panel', 'Toggle terminal panel', true), // Repo-OpenEmbeddedTerminal
  item('unstage-all', 'Unstage all changes', true),
  item('view-wip', 'View Working Directory Changes', true, 'changes wip workdir working'), // FuzzyFinder-ViewWorkingDirectoryChangesKeywords
];

/** With no repo tab open the repo-only items are hidden. */
export function visiblePaletteItems(hasRepo: boolean): PaletteItem[] {
  return hasRepo ? PALETTE_ITEMS : PALETTE_ITEMS.filter((i) => !i.needsRepo);
}
