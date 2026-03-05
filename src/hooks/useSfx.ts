import { useCallback, useRef, useState } from "react";

type SfxName = "select" | "confirm" | "cancel" | "alert";

const SFX_STORAGE_KEY = "eb-sfx-enabled";

function getAudioCtx(ref: React.MutableRefObject<AudioContext | null>): AudioContext {
  if (!ref.current) {
    ref.current = new AudioContext();
  }
  return ref.current;
}

function playTone(ctx: AudioContext, freq: number, duration: number, startTime: number, type: OscillatorType = "square") {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0.08, startTime);
  gain.gain.exponentialRampToValueAtTime(0.001, startTime + duration);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(startTime);
  osc.stop(startTime + duration);
}

const SFX_MAP: Record<SfxName, (ctx: AudioContext) => void> = {
  select: (ctx) => {
    // High-pitched blip
    const t = ctx.currentTime;
    playTone(ctx, 880, 0.06, t);
  },
  confirm: (ctx) => {
    // Rising two-tone
    const t = ctx.currentTime;
    playTone(ctx, 660, 0.08, t);
    playTone(ctx, 880, 0.1, t + 0.08);
  },
  cancel: (ctx) => {
    // Descending tone
    const t = ctx.currentTime;
    playTone(ctx, 440, 0.08, t);
    playTone(ctx, 330, 0.1, t + 0.08);
  },
  alert: (ctx) => {
    // Three-note pattern
    const t = ctx.currentTime;
    playTone(ctx, 660, 0.06, t);
    playTone(ctx, 880, 0.06, t + 0.08);
    playTone(ctx, 660, 0.08, t + 0.16);
  },
};

export function useSfx() {
  const ctxRef = useRef<AudioContext | null>(null);
  const [enabled, setEnabledState] = useState<boolean>(() => {
    const stored = localStorage.getItem(SFX_STORAGE_KEY);
    return stored === null ? true : stored === "true";
  });

  const play = useCallback((name: SfxName) => {
    if (!enabled) return;
    try {
      const ctx = getAudioCtx(ctxRef);
      if (ctx.state === "suspended") {
        void ctx.resume();
      }
      SFX_MAP[name](ctx);
    } catch {
      // Audio not available — silent fail
    }
  }, [enabled]);

  const setEnabled = useCallback((val: boolean) => {
    setEnabledState(val);
    localStorage.setItem(SFX_STORAGE_KEY, String(val));
  }, []);

  return { play, enabled, setEnabled } as const;
}
