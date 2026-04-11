import { useState, useEffect, useCallback } from "react";

export type Flavor = "mint" | "strawberry" | "banana" | "peanut" | "blueberry" | "plain";
export type TimeOfDay = "day" | "night";

/**
 * Full color palettes. Unlike `flavor` (accent-only), a `palette` swaps
 * every surface, text, status, and shadow variable in `index.css`. Adding
 * a new palette means: (1) add the name here, (2) define the variables
 * under `[data-palette="<name>"]` and `.dark[data-palette="<name>"]` in
 * index.css.
 */
export type Palette = "teal" | "denim" | "forest" | "aqua";

/**
 * Human-readable metadata for each palette. The swatch colors are used by
 * the sidebar theme picker so users see the palette's hero color. Keep
 * the `primary` value in sync with --accent-primary for that palette.
 */
export interface PaletteMeta {
  id: Palette;
  label: string;
  primary: string;
  secondary: string;
}

export const PALETTES: ReadonlyArray<PaletteMeta> = [
  { id: "teal", label: "Teal", primary: "#6ba4a9", secondary: "#a89bc7" },
  { id: "denim", label: "Denim", primary: "#5978b8", secondary: "#dcab91" },
  { id: "forest", label: "Forest", primary: "#0d524e", secondary: "#b5cec8" },
  { id: "aqua", label: "Aqua", primary: "#0b8b8b", secondary: "#6dbfe3" },
];

const PALETTE_IDS: Palette[] = PALETTES.map((p) => p.id);

const FLAVORS: Flavor[] = ["mint", "strawberry", "banana", "peanut", "blueberry", "plain"];

export function useTheme() {
  const [flavor, setFlavorState] = useState<Flavor>(() => {
    const stored = localStorage.getItem("eb-flavor");
    return FLAVORS.includes(stored as Flavor) ? (stored as Flavor) : "mint";
  });

  const [palette, setPaletteState] = useState<Palette>(() => {
    const stored = localStorage.getItem("ao-palette");
    return PALETTE_IDS.includes(stored as Palette) ? (stored as Palette) : "teal";
  });

  const [timeOfDay, setTimeOfDayState] = useState<TimeOfDay>(() => {
    const stored = localStorage.getItem("eb-time-of-day");
    return stored === "day" ? "day" : "night";
  });

  useEffect(() => {
    document.documentElement.setAttribute("data-flavor", flavor);
    localStorage.setItem("eb-flavor", flavor);
  }, [flavor]);

  useEffect(() => {
    document.documentElement.setAttribute("data-palette", palette);
    localStorage.setItem("ao-palette", palette);
  }, [palette]);

  useEffect(() => {
    const root = document.documentElement;
    if (timeOfDay === "night") {
      root.classList.add("dark");
    } else {
      root.classList.remove("dark");
    }
    localStorage.setItem("eb-time-of-day", timeOfDay);
  }, [timeOfDay]);

  const setFlavor = useCallback((f: Flavor) => {
    setFlavorState(f);
  }, []);

  const setPalette = useCallback((p: Palette) => {
    setPaletteState(p);
  }, []);

  const toggleTimeOfDay = useCallback(() => {
    setTimeOfDayState((prev) => (prev === "night" ? "day" : "night"));
  }, []);

  // Backward compatibility
  const theme = timeOfDay === "night" ? "dark" : "light";
  const toggleTheme = toggleTimeOfDay;

  return {
    flavor,
    setFlavor,
    palette,
    setPalette,
    palettes: PALETTES,
    timeOfDay,
    toggleTimeOfDay,
    theme,
    toggleTheme,
    flavors: FLAVORS,
  } as const;
}
