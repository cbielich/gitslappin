import { describe, expect, it } from 'vitest';
import { PALETTE_ITEMS, visiblePaletteItems } from './paletteItems';

/*
 * V6 design "3 Command palette": client/src/lib/paletteItems.ts (contract chosen by the test author):
 *   export interface PaletteItem { id: string; label: string; keywords?: string; needsRepo: boolean }
 *   export const PALETTE_ITEMS: PaletteItem[]                       exactly the 33 kept items, alphabetical (plain code-unit order, which is the order the design lists them)
 *   export function visiblePaletteItems(hasRepo: boolean): PaletteItem[]    hasRepo=false hides every needsRepo item; hasRepo=true returns all 33
 * Item ids the e2e specs and the audit tests rely on: 'discard-all' ("Discard all changes"), 'stash-pop', 'stash-apply', 'stash-create', 'create-branch', 'checkout', 'history', 'blame',
 *   'open-repo', 'open-terminal' ("Open in default terminal"), 'open-folder' ("Open in file manager"). V6b added "Toggle terminal panel" (33 items).
 */

const KEPT = [
  'Activity Logs',
  'Blame',
  'Checkout',
  'Clone',
  'Close Tab',
  'Create Annotated Tag',
  'Create Branch',
  'Create Tag',
  'Decrease Zoom',
  'Discard all changes',
  'Fetch All',
  'History',
  'Increase Zoom',
  'Initialize a Repo',
  'Keyboard Shortcuts',
  'Open Repo',
  'Open Repository Management Tab',
  'Open in default terminal',
  'Open in file manager',
  'Rename Branch',
  'Reset Zoom',
  'Search Commits',
  'Settings',
  'Stage all changes',
  'Stash: Apply',
  'Stash: Create',
  'Stash: Pop',
  'Switch Theme',
  'Toggle Commit Details Panel',
  'Toggle Left Panel',
  'Toggle terminal panel',
  'Unstage all changes',
  'View Working Directory Changes',
];

// The 25 of the 58 reference items (screens/34-command-palette-items.txt) that the design cuts.
const CUT = [
  'Apply patch',
  'Configure Commit Signing',
  'Configure Gitflow',
  'Configure LFS',
  'Create File',
  'Create patch from all working directory changes',
  'Delete File',
  'Edit File',
  'Generate Commit Message',
  'Initialize LFS on this repo',
  'Manage Account',
  'Open File',
  'Open Workspaces',
  'Open in External Diff/Merge Tool',
  'Open in VS Code',
  'Perform Repo Maintenance',
  'Share commit as Cloud Patch',
  'Start Pull Request',
  'Switch to Profile',
  'Toggle Syntax Highlighting',
  'Toggle Toolbar Labels',
  'View Error Logs',
  'View File',
  'View Performance Logs',
  'View Release Notes',
];

describe('palette items', () => {
  it('are exactly the 33 kept ones, in the design order', () => {
    expect(PALETTE_ITEMS).toHaveLength(33);
    expect(PALETTE_ITEMS.map((i) => i.label)).toEqual(KEPT);
  });
  it('are alphabetical (code-unit order) with unique ids and unique labels', () => {
    const l = PALETTE_ITEMS.map((i) => i.label);
    expect(l).toEqual([...l].sort());
    expect(new Set(PALETTE_ITEMS.map((i) => i.id)).size).toBe(33);
    expect(new Set(l).size).toBe(33);
  });
  it('none of the 25 cut items is present (by label, case-insensitive)', () => {
    expect(CUT).toHaveLength(25);
    const have = new Set(PALETTE_ITEMS.map((i) => i.label.toLowerCase()));
    for (const c of CUT) expect(have.has(c.toLowerCase()), c).toBe(false);
  });
  it('the ids named in the contract exist', () => {
    const ids = PALETTE_ITEMS.map((i) => i.id);
    for (const id of ['discard-all', 'stash-pop', 'stash-apply', 'stash-create', 'create-branch', 'checkout', 'history', 'blame', 'open-repo', 'open-terminal', 'open-folder', 'settings', 'keyboard-shortcuts', 'toggle-left-panel']) expect(ids).toContain(id);
    expect(PALETTE_ITEMS.find((i) => i.id === 'open-terminal')!.label).toBe('Open in default terminal');
  });
  it('keyword items carry the en-us.json keywords (FuzzyFinder-DiscardAllKeywords, -OpenInFileManagerKeywords, -InitRepoKeywords, -SettingsKeywords)', () => {
    const kw = (label: string) => PALETTE_ITEMS.find((i) => i.label === label)!.keywords ?? '';
    expect(kw('Discard all changes')).toContain('reset hard all');
    expect(kw('Open in file manager')).toContain('folder explorer finder');
    expect(kw('Initialize a Repo')).toContain('initialize');
    expect(kw('Settings')).toContain('preferences options');
  });
});

describe('visiblePaletteItems', () => {
  it('with a repo tab every item shows', () => {
    expect(visiblePaletteItems(true).map((i) => i.label)).toEqual(KEPT);
  });
  it('with no repo tab the repo-only items are hidden and the global ones stay', () => {
    const labels = visiblePaletteItems(false).map((i) => i.label);
    for (const g of ['Clone', 'Open Repo', 'Initialize a Repo', 'Settings', 'Keyboard Shortcuts', 'Switch Theme', 'Open Repository Management Tab']) expect(labels, g).toContain(g);
    for (const r of ['Create Branch', 'Fetch All', 'Stash: Pop', 'Stash: Apply', 'Stash: Create', 'Discard all changes', 'Stage all changes', 'Unstage all changes', 'Checkout', 'History', 'Blame', 'Search Commits', 'Open in default terminal', 'Open in file manager']) {
      expect(labels, r).not.toContain(r);
    }
  });
});
