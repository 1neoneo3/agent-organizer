/**
 * AgentAvatar – PixelAvatar wrapper with CLI provider badge and state animation.
 *
 * Shows the role-based Mother 2 sprite plus a small colored dot indicating the
 * CLI provider (Claude / Codex / Gemini).  Applies the appropriate sprite
 * animation class based on the agent's current status.
 */
import { PixelAvatar } from "../agents/PixelAvatar.js";
import type { Agent } from "../../types/index.js";

const PROVIDER_COLORS: Record<Agent["cli_provider"], string> = {
  claude: "#a855f7",  // purple
  codex: "#22c55e",   // green
  gemini: "#3b82f6",  // blue
};

const PROVIDER_LABELS: Record<Agent["cli_provider"], string> = {
  claude: "C",
  codex: "X",
  gemini: "G",
};

interface AgentAvatarProps {
  agent: Agent;
  size?: number;
}

export function AgentAvatar({ agent, size = 32 }: AgentAvatarProps) {
  const animationClass =
    agent.status === "working"
      ? "eb-sprite-typing"
      : agent.status === "idle"
        ? "eb-sprite-idle"
        : "";

  const badgeSize = Math.max(10, Math.round(size * 0.35));
  const providerColor = PROVIDER_COLORS[agent.cli_provider];

  return (
    <div style={{ position: "relative", display: "inline-block", width: size, height: size }}>
      <span className={animationClass} style={{ display: "block" }}>
        <PixelAvatar role={agent.role} size={size} />
      </span>

      {/* CLI provider badge */}
      <span
        style={{
          position: "absolute",
          bottom: -2,
          right: -2,
          width: badgeSize,
          height: badgeSize,
          borderRadius: "50%",
          background: providerColor,
          border: "2px solid var(--eb-bg)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: `${Math.max(6, badgeSize - 4)}px`,
          fontFamily: "var(--eb-font-heading)",
          color: "#fff",
          lineHeight: 1,
        }}
        title={agent.cli_provider}
      >
        {PROVIDER_LABELS[agent.cli_provider]}
      </span>
    </div>
  );
}
