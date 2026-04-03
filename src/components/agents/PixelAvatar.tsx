/**
 * Modern SVG icon avatars for each agent role.
 * Linear/Notion-inspired minimal flat design with gradient backgrounds and glow effects.
 * viewBox 0 0 32 32, abstract symbols per role.
 */
import React, { useId } from "react";

interface PixelAvatarProps {
  role: string | null;
  size?: number;
  className?: string;
}

type RoleRenderer = (id: string) => React.ReactElement;

function Defs({
  id,
  from,
  to,
  glowColor,
}: {
  id: string;
  from: string;
  to: string;
  glowColor?: string;
}): React.ReactElement {
  return (
    <defs>
      <linearGradient id={`${id}-bg`} x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stopColor={from} />
        <stop offset="100%" stopColor={to} />
      </linearGradient>
      <filter id={`${id}-glow`}>
        <feGaussianBlur stdDeviation="1" result="blur" />
        <feFlood floodColor={glowColor ?? "#fff"} floodOpacity="0.3" />
        <feComposite in2="blur" operator="in" />
        <feMerge>
          <feMergeNode />
          <feMergeNode in="SourceGraphic" />
        </feMerge>
      </filter>
    </defs>
  );
}

function BgCircle({ id }: { id: string }): React.ReactElement {
  return (
    <>
      <circle cx="16" cy="16" r="15.5" fill={`url(#${id}-bg)`} />
      <circle cx="16" cy="16" r="15.5" fill="none" stroke="#fff" strokeOpacity="0.1" strokeWidth="0.5" />
    </>
  );
}

// lead_engineer: Code brackets { } with lightning bolt
function LeadEngineer(id: string): React.ReactElement {
  return (
    <>
      <Defs id={id} from="#3b82f6" to="#6366f1" glowColor="#93c5fd" />
      <BgCircle id={id} />
      <g filter={`url(#${id}-glow)`}>
        <path
          d="M10.5 9 Q8 9 8 11.5 L8 14 Q8 16 6 16 Q8 16 8 18 L8 20.5 Q8 23 10.5 23"
          fill="none"
          stroke="#e0e7ff"
          strokeWidth="2"
          strokeLinecap="round"
        />
        <path
          d="M21.5 9 Q24 9 24 11.5 L24 14 Q24 16 26 16 Q24 16 24 18 L24 20.5 Q24 23 21.5 23"
          fill="none"
          stroke="#e0e7ff"
          strokeWidth="2"
          strokeLinecap="round"
        />
        <path
          d="M15 11 L13.5 17 L17 15.5 L15 22"
          fill="none"
          stroke="#fbbf24"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </g>
    </>
  );
}

// tester: Magnifying glass with checkmark inside
function Tester(id: string): React.ReactElement {
  return (
    <>
      <Defs id={id} from="#10b981" to="#059669" glowColor="#6ee7b7" />
      <BgCircle id={id} />
      <g filter={`url(#${id}-glow)`}>
        <circle cx="14" cy="13" r="6" fill="none" stroke="#d1fae5" strokeWidth="2" />
        <line x1="18.5" y1="17.5" x2="25" y2="24" stroke="#d1fae5" strokeWidth="2.5" strokeLinecap="round" />
        <polyline
          points="11,13 13,15.5 17.5,10.5"
          fill="none"
          stroke="#a7f3d0"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </g>
    </>
  );
}

// code_reviewer: Eye with code lines beneath
function CodeReviewer(id: string): React.ReactElement {
  return (
    <>
      <Defs id={id} from="#a855f7" to="#7c3aed" glowColor="#c4b5fd" />
      <BgCircle id={id} />
      <g filter={`url(#${id}-glow)`}>
        <path
          d="M5 15 Q16 7 27 15 Q16 23 5 15 Z"
          fill="none"
          stroke="#ede9fe"
          strokeWidth="1.8"
        />
        <circle cx="16" cy="15" r="3" fill="#ede9fe" />
        <circle cx="16" cy="15" r="1.4" fill="#7c3aed" />
        <g stroke="#ede9fe" strokeWidth="1.5" strokeLinecap="round" opacity="0.45">
          <line x1="8" y1="24" x2="15" y2="24" />
          <line x1="17" y1="24" x2="24" y2="24" />
          <line x1="10" y1="27" x2="22" y2="27" />
        </g>
      </g>
    </>
  );
}

// architect: Pyramid with internal grid structure
function Architect(id: string): React.ReactElement {
  return (
    <>
      <Defs id={id} from="#f59e0b" to="#d97706" glowColor="#fcd34d" />
      <BgCircle id={id} />
      <g filter={`url(#${id}-glow)`}>
        <polygon
          points="16,5 5,26 27,26"
          fill="none"
          stroke="#fef3c7"
          strokeWidth="2"
          strokeLinejoin="round"
        />
        <line x1="10.5" y1="15.5" x2="21.5" y2="15.5" stroke="#fef3c7" strokeWidth="1" opacity="0.5" />
        <line x1="7.8" y1="20.8" x2="24.2" y2="20.8" stroke="#fef3c7" strokeWidth="1" opacity="0.5" />
        <line x1="16" y1="5" x2="16" y2="26" stroke="#fef3c7" strokeWidth="1" opacity="0.4" />
        <line x1="16" y1="5" x2="10.5" y2="26" stroke="#fef3c7" strokeWidth="0.8" opacity="0.25" />
        <line x1="16" y1="5" x2="21.5" y2="26" stroke="#fef3c7" strokeWidth="0.8" opacity="0.25" />
      </g>
    </>
  );
}

// security_reviewer: Shield with lock
function SecurityReviewer(id: string): React.ReactElement {
  return (
    <>
      <Defs id={id} from="#ef4444" to="#b91c1c" glowColor="#fca5a5" />
      <BgCircle id={id} />
      <g filter={`url(#${id}-glow)`}>
        <path
          d="M16 4 L25 8.5 L25 15 Q25 23.5 16 28 Q7 23.5 7 15 L7 8.5 Z"
          fill="none"
          stroke="#fee2e2"
          strokeWidth="1.8"
          strokeLinejoin="round"
        />
        <rect x="12.5" y="15.5" width="7" height="5.5" rx="1.2" fill="#fee2e2" />
        <path
          d="M14 15.5 L14 13 Q14 10.5 16 10.5 Q18 10.5 18 13 L18 15.5"
          fill="none"
          stroke="#fee2e2"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
        <circle cx="16" cy="18" r="1" fill="#b91c1c" />
      </g>
    </>
  );
}

// researcher: Telescope with stars
function Researcher(id: string): React.ReactElement {
  return (
    <>
      <Defs id={id} from="#6366f1" to="#4338ca" glowColor="#a5b4fc" />
      <BgCircle id={id} />
      <g filter={`url(#${id}-glow)`}>
        <circle cx="11" cy="11" r="5" fill="none" stroke="#e0e7ff" strokeWidth="2" />
        <line x1="14.8" y1="14.8" x2="23" y2="23" stroke="#e0e7ff" strokeWidth="2.2" strokeLinecap="round" />
        <line x1="23" y1="23" x2="25" y2="27" stroke="#e0e7ff" strokeWidth="1.5" strokeLinecap="round" />
        <line x1="23" y1="23" x2="27" y2="25" stroke="#e0e7ff" strokeWidth="1.5" strokeLinecap="round" />
        <circle cx="22" cy="7" r="1.3" fill="#e0e7ff" />
        <circle cx="26" cy="11" r="0.9" fill="#c7d2fe" />
        <circle cx="19" cy="5" r="0.7" fill="#c7d2fe" />
      </g>
    </>
  );
}

// devops: Gear with circular arrows (CI/CD cycle)
function DevOps(id: string): React.ReactElement {
  return (
    <>
      <Defs id={id} from="#f97316" to="#c2410c" glowColor="#fdba74" />
      <BgCircle id={id} />
      <g filter={`url(#${id}-glow)`}>
        <circle cx="16" cy="16" r="4" fill="none" stroke="#ffedd5" strokeWidth="2" />
        <circle cx="16" cy="16" r="7.5" fill="none" stroke="#ffedd5" strokeWidth="1.5" strokeDasharray="3.5 3" />
        <path d="M16 5 A11 11 0 0 1 27 16" fill="none" stroke="#ffedd5" strokeWidth="1.8" />
        <polyline points="25,13 27,16 24,16.5" fill="none" stroke="#ffedd5" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M16 27 A11 11 0 0 1 5 16" fill="none" stroke="#ffedd5" strokeWidth="1.8" />
        <polyline points="7,19 5,16 8,15.5" fill="none" stroke="#ffedd5" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </g>
    </>
  );
}

// designer: Pen nib with color palette dots
function Designer(id: string): React.ReactElement {
  return (
    <>
      <Defs id={id} from="#ec4899" to="#be185d" glowColor="#f9a8d4" />
      <BgCircle id={id} />
      <g filter={`url(#${id}-glow)`}>
        <path
          d="M10 25 L14 13 L18 13 L22 25 Z"
          fill="none"
          stroke="#fce7f3"
          strokeWidth="1.8"
          strokeLinejoin="round"
        />
        <path
          d="M15 13 L16 7 L17 13"
          fill="none"
          stroke="#fce7f3"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <circle cx="16" cy="7" r="1" fill="#fce7f3" />
        <circle cx="7" cy="10" r="2.2" fill="#fbbf24" />
        <circle cx="11.5" cy="6.5" r="2" fill="#60a5fa" />
        <circle cx="20.5" cy="6.5" r="2" fill="#34d399" />
        <circle cx="25" cy="10" r="2.2" fill="#f87171" />
      </g>
    </>
  );
}

// planner: Map pin with route waypoints
function Planner(id: string): React.ReactElement {
  return (
    <>
      <Defs id={id} from="#14b8a6" to="#0f766e" glowColor="#5eead4" />
      <BgCircle id={id} />
      <g filter={`url(#${id}-glow)`}>
        <path
          d="M16 4 Q23 4 23 11 Q23 18 16 24 Q9 18 9 11 Q9 4 16 4 Z"
          fill="none"
          stroke="#ccfbf1"
          strokeWidth="2"
        />
        <circle cx="16" cy="11" r="3" fill="#ccfbf1" />
        <path
          d="M6 21 L10 26"
          fill="none"
          stroke="#99f6e4"
          strokeWidth="1.2"
          strokeLinecap="round"
          opacity="0.6"
        />
        <path
          d="M22 26 L26 21"
          fill="none"
          stroke="#99f6e4"
          strokeWidth="1.2"
          strokeLinecap="round"
          opacity="0.6"
        />
        <circle cx="6" cy="21" r="1.3" fill="#ccfbf1" />
        <circle cx="10" cy="26" r="1" fill="#99f6e4" />
        <circle cx="22" cy="26" r="1" fill="#99f6e4" />
        <circle cx="26" cy="21" r="1.3" fill="#ccfbf1" />
      </g>
    </>
  );
}

// default: Diamond with inner facets
function DefaultIcon(id: string): React.ReactElement {
  return (
    <>
      <Defs id={id} from="#64748b" to="#334155" glowColor="#94a3b8" />
      <BgCircle id={id} />
      <g filter={`url(#${id}-glow)`}>
        <polygon
          points="16,4 28,16 16,28 4,16"
          fill="none"
          stroke="#e2e8f0"
          strokeWidth="2"
          strokeLinejoin="round"
        />
        <polygon
          points="16,9 23,16 16,23 9,16"
          fill="none"
          stroke="#e2e8f0"
          strokeWidth="1"
          opacity="0.4"
        />
        <line x1="16" y1="4" x2="16" y2="28" stroke="#e2e8f0" strokeWidth="0.8" opacity="0.3" />
        <line x1="4" y1="16" x2="28" y2="16" stroke="#e2e8f0" strokeWidth="0.8" opacity="0.3" />
      </g>
    </>
  );
}

const ROLE_RENDERERS: Record<string, RoleRenderer> = {
  lead_engineer: LeadEngineer,
  tester: Tester,
  code_reviewer: CodeReviewer,
  architect: Architect,
  security_reviewer: SecurityReviewer,
  researcher: Researcher,
  devops: DevOps,
  designer: Designer,
  planner: Planner,
};

export function PixelAvatar({
  role,
  size = 32,
  className = "",
}: PixelAvatarProps) {
  const reactId = useId();
  const renderer = (role && ROLE_RENDERERS[role]) || DefaultIcon;
  const uniqueId = `av-${reactId.replace(/:/g, "")}`;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      {renderer(uniqueId)}
    </svg>
  );
}
