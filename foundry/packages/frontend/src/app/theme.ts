import { createDarkTheme, type Theme } from "baseui";

export const appTheme: Theme = createDarkTheme({
  colors: {
    primary: "#e4e4e7", // zinc-200
    accent: "#ff4f00", // orange accent (inspector)
    backgroundPrimary: "#000000", // pure black (inspector --bg)
    backgroundSecondary: "#0a0a0b", // near-black panels (inspector --bg-panel)
    backgroundTertiary: "#0a0a0b", // same as panel (border provides separation)
    backgroundInversePrimary: "#fafafa",
    contentPrimary: "#ffffff", // white (inspector --text)
    contentSecondary: "#a1a1aa", // zinc-400 (inspector --muted)
    contentTertiary: "#71717a", // zinc-500
    contentInversePrimary: "#000000",
    borderOpaque: "rgba(255, 255, 255, 0.18)", // inspector --border
    borderTransparent: "rgba(255, 255, 255, 0.14)", // inspector --border-2
  },
});
