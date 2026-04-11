/**
 * Agent role avatars: flat circular badges with a single lucide line icon.
 *
 * The previous avatars used gradients + Gaussian-blur glow filters which
 * made them feel busy and out of step with the palettemaker-inspired
 * muted teal theme. Every badge now renders as:
 *
 *   - a solid pastel-tinted circle background
 *   - a single 2px-stroke lucide icon in a darker sibling color
 *
 * Role-specific colors come from the palette below so the cards still
 * read as distinct at a glance. Roles that have no mapping fall back to
 * a neutral grey `Bot` icon.
 */
import type { LucideIcon } from "lucide-react";
import {
  Bot,
  Code2,
  Cog,
  FlaskConical,
  Layers,
  MapPin,
  Microscope,
  Palette,
  ScanEye,
  Shield,
} from "lucide-react";

interface PixelAvatarProps {
  role: string | null;
  size?: number;
  className?: string;
}

interface RoleVisual {
  icon: LucideIcon;
  /** Pale tint used for the circle background. */
  bg: string;
  /** Darker sibling color used for the icon stroke. */
  fg: string;
}

/**
 * Role → visual mapping.
 *
 * Colors are picked from the palette so they coexist with the rest of
 * the UI. Each role gets a distinct hue pair to stay recognizable.
 */
const ROLE_VISUALS: Record<string, RoleVisual> = {
  lead_engineer: { icon: Code2, bg: "#e0eef0", fg: "#558b90" },
  tester: { icon: FlaskConical, bg: "#e2efea", fg: "#5f9582" },
  code_reviewer: { icon: ScanEye, bg: "#ece7f3", fg: "#7e6fa8" },
  architect: { icon: Layers, bg: "#f3e9d6", fg: "#ae8346" },
  security_reviewer: { icon: Shield, bg: "#f3e0e0", fg: "#a86666" },
  researcher: { icon: Microscope, bg: "#e2eff0", fg: "#5f9aa0" },
  devops: { icon: Cog, bg: "#f3e4d8", fg: "#b3826a" },
  designer: { icon: Palette, bg: "#ece7f3", fg: "#7e6fa8" },
  planner: { icon: MapPin, bg: "#e2efea", fg: "#5f9582" },
};

const DEFAULT_VISUAL: RoleVisual = {
  icon: Bot,
  bg: "#e8eeef",
  fg: "#5e7a7f",
};

export function PixelAvatar({ role, size = 32, className = "" }: PixelAvatarProps) {
  const visual = (role && ROLE_VISUALS[role]) || DEFAULT_VISUAL;
  const Icon = visual.icon;
  const iconSize = Math.round(size * 0.55);

  return (
    <span
      className={className}
      aria-hidden="true"
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: `${size}px`,
        height: `${size}px`,
        borderRadius: "50%",
        background: visual.bg,
        color: visual.fg,
        flexShrink: 0,
      }}
    >
      <Icon size={iconSize} strokeWidth={2} />
    </span>
  );
}
