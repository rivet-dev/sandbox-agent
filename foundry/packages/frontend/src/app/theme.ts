import { createDarkTheme, type Theme } from "baseui";

export const appTheme: Theme = createDarkTheme({
  colors: {
    primary: "#e4e4e7", // zinc-200
    accent: "#ff4f00", // orange accent (inspector)
    backgroundPrimary: "#09090b", // darkest — chat center panel
    backgroundSecondary: "#0f0f11", // slightly lighter — sidebars
    backgroundTertiary: "#0c0c0e", // center + right panel headers
    backgroundInversePrimary: "#fafafa",
    contentPrimary: "#ffffff", // white (inspector --text)
    contentSecondary: "#a1a1aa", // zinc-400 (inspector --muted)
    contentTertiary: "#71717a", // zinc-500
    contentInversePrimary: "#000000",
    borderOpaque: "rgba(255, 255, 255, 0.10)", // inspector --border
    borderTransparent: "rgba(255, 255, 255, 0.07)", // inspector --border-2
  },
});
