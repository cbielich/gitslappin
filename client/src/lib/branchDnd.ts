import type { DragEvent } from 'react';
import type { DropRef } from './dropMenu';

/*
 * V6: the dragged branch lives ONLY here (in-app state), never in dataTransfer. A drop with no in-app drag
 * (text, files or links from outside) is ignored: a drop only counts when our own MIME type was set at dragstart.
 */
let dragging: DropRef | null = null;
/** Set at dragstart; its presence in dataTransfer.types proves the drag started here. */
export const BRANCH_MIME = 'application/x-gitslappin-branch';
/** RepoView registers: would dropping `src` on `dst` show a menu? (so a drop target that would give an empty menu is not highlighted) */
let gate: ((src: DropRef, dst: DropRef) => boolean) | null = null;
export function setDropGate(fn: ((src: DropRef, dst: DropRef) => boolean) | null): void {
  gate = fn;
}

const same = (a: DropRef, b: DropRef) => a.name === b.name && a.kind === b.kind;
const hot = (el: HTMLElement, on: boolean) => (on ? el.setAttribute('data-drop-target', 'true') : el.removeAttribute('data-drop-target'));
const ours = (e: DragEvent<HTMLElement>) => Array.from(e.dataTransfer.types ?? []).includes(BRANCH_MIME);

// The drag source may unmount mid-drag (so its own dragend never fires): the window clears the state too.
if (typeof window !== 'undefined') {
  const clear = () => {
    dragging = null;
  };
  window.addEventListener('dragend', clear);
  window.addEventListener('drop', clear);
  window.addEventListener('pointerdown', clear);
}

/** `alts` = more names on the same pill (e.g. the remote-tracking names next to a local branch); the first one that gives a menu is the target. */
export function branchDndProps(ref: DropRef, onDrop: (x: number, y: number, src: DropRef, dst: DropRef) => void, alts: DropRef[] = []) {
  const target = (): DropRef | null => {
    const src = dragging;
    if (!src) return null;
    return [ref, ...alts].find((c) => !same(src, c) && (gate ? gate(src, c) : true)) ?? null;
  };
  const over = (e: DragEvent<HTMLElement>) => {
    if (!ours(e) || !target()) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    hot(e.currentTarget, true);
  };
  return {
    draggable: true,
    onDragStart: (e: DragEvent<HTMLElement>) => {
      e.stopPropagation();
      dragging = ref;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData(BRANCH_MIME, ref.name);
      e.dataTransfer.setData('text/plain', ref.name);
    },
    onDragEnd: (e: DragEvent<HTMLElement>) => {
      dragging = null;
      hot(e.currentTarget, false);
    },
    onDragEnter: over,
    onDragOver: over,
    onDragLeave: (e: DragEvent<HTMLElement>) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) hot(e.currentTarget, false);
    },
    onDrop: (e: DragEvent<HTMLElement>) => {
      hot(e.currentTarget, false);
      const src = dragging;
      const dst = ours(e) ? target() : null;
      dragging = null;
      if (!src || !dst) return;
      e.preventDefault();
      e.stopPropagation();
      onDrop(e.clientX, e.clientY, src, dst);
    },
  };
}
