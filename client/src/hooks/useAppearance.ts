import { useCallback, useEffect, useRef, useState } from 'react';
import type { Theme } from '@gitslappin/shared';
import { api } from '../api';

const THEME_KEY = 'gitslappin-theme';
export const ZOOM_MIN = 0.8;
export const ZOOM_MAX = 1.5;
const tenths = (z: number) => Math.round(z * 10) / 10;

/** Saves go out one after the other, so the last change is the one that stays. */
let saving: Promise<unknown> = Promise.resolve();
const save = (patch: { theme: Theme } | { zoom: number }, onError?: (message: string) => void) => {
  saving = saving
    .then(() => api.putPrefs(patch))
    .catch((e: unknown) => onError?.(e instanceof Error ? e.message : 'The preferences could not be saved.'));
};

const ZOOM_KEY = 'gitslappin-zoom'; // read by theme-boot.js (whitelisted 0.8..1.5)
function rememberZoom(z: number): void {
  try {
    window.localStorage.setItem(ZOOM_KEY, String(z));
  } catch {
    // storage blocked: the saved prefs still decide on the next load
  }
}

function applyTheme(t: Theme): void {
  document.documentElement.setAttribute('data-theme', t);
  try {
    window.localStorage.setItem(THEME_KEY, t); // read by theme-boot.js before the next load (only "dark" / "light" are ever applied)
  } catch {
    // storage blocked: the saved prefs still decide on the next load
  }
}

/** Theme and zoom. /api/prefs is the source of truth; the page is updated at once and the prefs are saved in the background. */
export function useAppearance(onSaveError?: (message: string) => void) {
  const [theme, setThemeState] = useState<Theme>(() => (document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark'));
  const [zoom, setZoomState] = useState(() => {
    const z = Number(document.documentElement.style.zoom); // theme-boot.js may have set it already
    return z >= ZOOM_MIN && z <= ZOOM_MAX ? z : 1;
  });
  const zoomRef = useRef(zoom);
  const touched = useRef({ theme: false, zoom: false }); // changed by the user before the first getPrefs came back
  const onError = useRef(onSaveError);
  onError.current = onSaveError;
  const fail = useCallback((m: string) => onError.current?.(m), []);

  useEffect(() => {
    let live = true;
    api
      .getPrefs()
      .then((p) => {
        if (!live) return;
        if (!touched.current.theme) {
          setThemeState(p.theme);
          applyTheme(p.theme);
        }
        if (!touched.current.zoom) {
          zoomRef.current = p.zoom;
          setZoomState(p.zoom);
          rememberZoom(p.zoom);
        }
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    document.documentElement.style.zoom = String(zoom);
  }, [zoom]);

  const setTheme = useCallback((t: Theme) => {
    touched.current.theme = true;
    setThemeState(t);
    applyTheme(t);
    save({ theme: t }, fail);
  }, [fail]);

  const setZoom = useCallback((z: number) => {
    const next = tenths(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z)));
    if (next === zoomRef.current) return;
    touched.current.zoom = true;
    zoomRef.current = next;
    setZoomState(next);
    rememberZoom(next);
    save({ zoom: next }, fail);
  }, [fail]);

  const zoomIn = useCallback(() => setZoom(zoomRef.current + 0.1), [setZoom]);
  const zoomOut = useCallback(() => setZoom(zoomRef.current - 0.1), [setZoom]);
  const zoomReset = useCallback(() => setZoom(1), [setZoom]);

  return { theme, setTheme, zoom, zoomIn, zoomOut, zoomReset };
}
