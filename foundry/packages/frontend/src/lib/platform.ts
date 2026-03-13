import { useSyncExternalStore } from "react";

const MOBILE_BREAKPOINT = 768;

/** True when built with VITE_MOBILE=1 (Tauri mobile build) */
export const isNativeMobile = !!import.meta.env.VITE_MOBILE;

/** True when built with VITE_DESKTOP=1 (Tauri desktop build) */
export const isNativeDesktop = !!import.meta.env.VITE_DESKTOP;

/** True when running inside any Tauri shell */
export const isNativeApp = isNativeMobile || isNativeDesktop;

function getIsMobileViewport(): boolean {
  if (typeof window === "undefined") return false;
  return window.innerWidth < MOBILE_BREAKPOINT;
}

let currentIsMobile = isNativeMobile || getIsMobileViewport();

const listeners = new Set<() => void>();

if (typeof window !== "undefined") {
  const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);
  mql.addEventListener("change", (e) => {
    const next = isNativeMobile || e.matches;
    if (next !== currentIsMobile) {
      currentIsMobile = next;
      for (const fn of listeners) fn();
    }
  });
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function getSnapshot() {
  return currentIsMobile;
}

/**
 * Returns true when the app should render in mobile layout.
 * This is true when:
 * - Built with VITE_MOBILE=1 (always mobile), OR
 * - Viewport width is below 768px (responsive web)
 *
 * Re-renders when the viewport crosses the breakpoint.
 */
export function useIsMobile(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}
