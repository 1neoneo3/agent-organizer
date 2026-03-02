import { useState, useEffect, useCallback } from "react";

export type Flavor = "mint" | "strawberry" | "banana" | "peanut" | "plain";
export type TimeOfDay = "day" | "night";

const FLAVORS: Flavor[] = ["mint", "strawberry", "banana", "peanut", "plain"];

export function useTheme() {
  const [flavor, setFlavorState] = useState<Flavor>(() => {
    const stored = localStorage.getItem("eb-flavor");
    return FLAVORS.includes(stored as Flavor) ? (stored as Flavor) : "mint";
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

  const toggleTimeOfDay = useCallback(() => {
    setTimeOfDayState((prev) => (prev === "night" ? "day" : "night"));
  }, []);

  // Backward compatibility
  const theme = timeOfDay === "night" ? "dark" : "light";
  const toggleTheme = toggleTimeOfDay;

  return { flavor, setFlavor, timeOfDay, toggleTimeOfDay, theme, toggleTheme, flavors: FLAVORS } as const;
}
