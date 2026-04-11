import { useCallback } from "react";

type SfxName = "select" | "confirm" | "cancel" | "alert";

// Sound effects are disabled by default — the square-wave blips were too
// noisy during normal UI interactions (every click / drag / drop played one).
// The hook is kept as a no-op so call sites do not need to be rewritten and
// future re-enablement stays a one-file change.
export function useSfx() {
  const play = useCallback((_name: SfxName) => {
    // no-op
  }, []);

  const setEnabled = useCallback((_val: boolean) => {
    // no-op — kept for API compatibility
  }, []);

  return { play, enabled: false, setEnabled } as const;
}
