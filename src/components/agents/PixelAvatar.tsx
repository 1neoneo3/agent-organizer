/**
 * Modern SVG icon avatars for each agent role.
 * Minimal, flat vector design with gradient/glow effects.
 * Each icon uses abstract symbols to represent the role.
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
}: {
  id: string;
  from: string;
  to: string;
}): React.ReactElement {
  return (
    <defs>
      <linearGradient id={`${id}-bg`} x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stopColor={from} />
        <stop offset="100%" stopColor={to} />
      </linearGradient>
      <filter id={`${id}-glow`}>
        <feGaussianBlur stdDeviation="1" result="blur" />
        <feMerge>
          <feMergeNode in="blur" />
          <feMergeNode in="SourceGraphic" />
        </feMerge>
      </filter>
    </defs>
  );
}

function Bg({ id }: { id: string }): React.ReactElement {
  return <rect x="1" y="1" width="30" height="30" rx="8" fill={`url(#${id}-bg)`} />;
}

function LeadEngineer(id: string): React.ReactElement {
  return (
    <>
      <Defs id={id} from="#3b82f6" to="#6366f1" />
      <Bg id={id} />
      <g
        filter={`url(#${id}-glow)`}
        stroke="#e0e7ff"
        strokeWidth="2"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {/* { } brackets */}
        <path d="M11 9.5 L8.5 12 L8.5 14.5 L6.5 16 L8.5 17.5 L8.5 20 L11 22.5" />
        <path d="M21 9.5 L23.5 12 L23.5 14.5 L25.5 16 L23.5 17.5 L23.5 20 L21 22.5" />
        {/* lightning bolt */}
        <path d="M15.5 10 L13 16.5 L16.5 15.5 L14 22" strokeWidth="2.2" stroke="#fbbf24" />
      </g>
    </>
  );
}

function Tester(id: string): React.ReactElement {
  return (
    <>
      <Defs id={id} from="#22c55e" to="#059669" />
      <Bg id={id} />
      <g
        filter={`url(#${id}-glow)`}
        stroke="#d1fae5"
        strokeWidth="2"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {/* magnifying glass */}
        <circle cx="14" cy="13.5" r="5.5" />
        <line x1="18.5" y1="18" x2="24" y2="23.5" strokeWidth="2.5" />
        {/* checkmark inside lens */}
        <polyline points="11,13.5 13,15.5 17.5,11" strokeWidth="2" stroke="#a7f3d0" />
      </g>
    </>
  );
}

function CodeReviewer(id: string): React.ReactElement {
  return (
    <>
      <Defs id={id} from="#a855f7" to="#7c3aed" />
      <Bg id={id} />
      <g
        filter={`url(#${id}-glow)`}
        stroke="#ede9fe"
        strokeWidth="1.8"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {/* eye shape */}
        <path d="M5.5 16 Q16 7.5 26.5 16 Q16 24.5 5.5 16 Z" strokeWidth="1.6" />
        {/* iris */}
        <circle cx="16" cy="16" r="3.5" fill="#ede9fe" stroke="none" />
        <circle cx="16" cy="16" r="1.8" fill="#7c3aed" stroke="none" />
        {/* highlight */}
        <circle cx="17.2" cy="14.8" r="0.8" fill="#ffffff" stroke="none" />
        {/* code scan lines */}
        <line x1="8" y1="25" x2="14" y2="25" strokeWidth="1.2" opacity="0.5" />
        <line x1="16" y1="25" x2="24" y2="25" strokeWidth="1.2" opacity="0.5" />
        <line x1="10" y1="27" x2="18" y2="27" strokeWidth="1.2" opacity="0.3" />
      </g>
    </>
  );
}

function Architect(id: string): React.ReactElement {
  return (
    <>
      <Defs id={id} from="#f59e0b" to="#d97706" />
      <Bg id={id} />
      <g
        filter={`url(#${id}-glow)`}
        stroke="#fef3c7"
        strokeWidth="1.8"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {/* pyramid */}
        <polygon points="16,5 5.5,25 26.5,25" />
        {/* horizontal grid lines */}
        <line x1="10.5" y1="15" x2="21.5" y2="15" strokeWidth="1" opacity="0.5" />
        <line x1="8" y1="20" x2="24" y2="20" strokeWidth="1" opacity="0.5" />
        {/* vertical center line */}
        <line x1="16" y1="5" x2="16" y2="25" strokeWidth="1" opacity="0.4" />
        {/* apex glow dot */}
        <circle cx="16" cy="5" r="1.5" fill="#fef3c7" stroke="none" opacity="0.8" />
      </g>
    </>
  );
}

function SecurityReviewer(id: string): React.ReactElement {
  return (
    <>
      <Defs id={id} from="#ef4444" to="#b91c1c" />
      <Bg id={id} />
      <g
        filter={`url(#${id}-glow)`}
        stroke="#fee2e2"
        strokeWidth="1.8"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {/* shield */}
        <path d="M16 4.5 L24.5 8.5 L24.5 15 Q24.5 23.5 16 27 Q7.5 23.5 7.5 15 L7.5 8.5 Z" />
        {/* lock body */}
        <rect x="12.5" y="16" width="7" height="5.5" rx="1.2" fill="#fee2e2" stroke="none" />
        {/* lock shackle */}
        <path d="M13.5 16 L13.5 13.5 Q13.5 10.5 16 10.5 Q18.5 10.5 18.5 13.5 L18.5 16" strokeWidth="1.8" />
        {/* keyhole */}
        <circle cx="16" cy="18.5" r="1" fill="#b91c1c" stroke="none" />
        <line x1="16" y1="19.5" x2="16" y2="20.5" stroke="#b91c1c" strokeWidth="1.2" />
      </g>
    </>
  );
}

function Researcher(id: string): React.ReactElement {
  return (
    <>
      <Defs id={id} from="#6366f1" to="#4338ca" />
      <Bg id={id} />
      <g
        filter={`url(#${id}-glow)`}
        stroke="#e0e7ff"
        strokeWidth="1.8"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {/* telescope tube */}
        <circle cx="10" cy="10" r="4.5" strokeWidth="1.6" />
        <line x1="13.5" y1="13.5" x2="21" y2="21" strokeWidth="2.2" />
        {/* tripod legs */}
        <line x1="21" y1="21" x2="24" y2="26" strokeWidth="1.6" />
        <line x1="21" y1="21" x2="26" y2="23" strokeWidth="1.6" />
        <line x1="21" y1="21" x2="18" y2="26" strokeWidth="1.6" />
        {/* stars */}
        <circle cx="22" cy="7" r="1.2" fill="#e0e7ff" stroke="none" />
        <circle cx="26" cy="11" r="0.8" fill="#c7d2fe" stroke="none" />
        <circle cx="18.5" cy="5" r="0.6" fill="#c7d2fe" stroke="none" />
        <circle cx="25" cy="5.5" r="0.5" fill="#a5b4fc" stroke="none" />
      </g>
    </>
  );
}

function DevOps(id: string): React.ReactElement {
  return (
    <>
      <Defs id={id} from="#f97316" to="#c2410c" />
      <Bg id={id} />
      <g
        filter={`url(#${id}-glow)`}
        stroke="#ffedd5"
        strokeWidth="1.8"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {/* gear outer ring with teeth */}
        <circle cx="16" cy="16" r="4.5" />
        <circle cx="16" cy="16" r="8" strokeDasharray="3.5 2.8" strokeWidth="2.5" />
        {/* infinity / cycle arrows */}
        <path d="M16 5.5 A10.5 10.5 0 0 1 26.5 16" strokeWidth="1.6" />
        <polyline points="24.5,13 26.5,16 23.5,16.5" strokeWidth="1.5" fill="none" />
        <path d="M16 26.5 A10.5 10.5 0 0 1 5.5 16" strokeWidth="1.6" />
        <polyline points="7.5,19 5.5,16 8.5,15.5" strokeWidth="1.5" fill="none" />
      </g>
    </>
  );
}

function Designer(id: string): React.ReactElement {
  return (
    <>
      <Defs id={id} from="#ec4899" to="#be185d" />
      <Bg id={id} />
      <g
        filter={`url(#${id}-glow)`}
        stroke="#fce7f3"
        strokeWidth="1.8"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {/* pen nib */}
        <path d="M16 6 L12 16 L10 25 L16 21 L22 25 L20 16 Z" />
        <path d="M13.5 16 L18.5 16" strokeWidth="1" opacity="0.5" />
        {/* pen tip */}
        <circle cx="16" cy="8" r="1" fill="#fce7f3" stroke="none" />
        {/* color palette dots */}
        <circle cx="6" cy="10" r="2.2" fill="#fbbf24" stroke="none" opacity="0.9" />
        <circle cx="7" cy="16" r="1.8" fill="#60a5fa" stroke="none" opacity="0.9" />
        <circle cx="25" cy="10" r="2.2" fill="#34d399" stroke="none" opacity="0.9" />
        <circle cx="26" cy="16" r="1.8" fill="#f87171" stroke="none" opacity="0.9" />
      </g>
    </>
  );
}

function Planner(id: string): React.ReactElement {
  return (
    <>
      <Defs id={id} from="#14b8a6" to="#0f766e" />
      <Bg id={id} />
      <g
        filter={`url(#${id}-glow)`}
        stroke="#ccfbf1"
        strokeWidth="1.8"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {/* map pin */}
        <path d="M16 4 Q22.5 4 22.5 10.5 Q22.5 17 16 24 Q9.5 17 9.5 10.5 Q9.5 4 16 4 Z" />
        <circle cx="16" cy="10.5" r="3" fill="#ccfbf1" stroke="none" />
        {/* route path */}
        <path d="M7 21 Q10 28 16 27 Q22 26 25 21" strokeWidth="1.4" strokeDasharray="2 2" opacity="0.6" />
        {/* waypoint dots */}
        <circle cx="7" cy="21" r="1.2" fill="#ccfbf1" stroke="none" />
        <circle cx="25" cy="21" r="1.2" fill="#ccfbf1" stroke="none" />
      </g>
    </>
  );
}

function DefaultIcon(id: string): React.ReactElement {
  return (
    <>
      <Defs id={id} from="#64748b" to="#334155" />
      <Bg id={id} />
      <g
        filter={`url(#${id}-glow)`}
        stroke="#e2e8f0"
        strokeWidth="1.8"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {/* diamond shape */}
        <polygon points="16,4 28,16 16,28 4,16" />
        {/* inner diamond */}
        <polygon points="16,9 23,16 16,23 9,16" strokeWidth="1.2" opacity="0.5" />
        {/* center dot */}
        <circle cx="16" cy="16" r="1.5" fill="#e2e8f0" stroke="none" />
        {/* cross lines */}
        <line x1="16" y1="4" x2="16" y2="9" strokeWidth="1" opacity="0.3" />
        <line x1="16" y1="23" x2="16" y2="28" strokeWidth="1" opacity="0.3" />
        <line x1="4" y1="16" x2="9" y2="16" strokeWidth="1" opacity="0.3" />
        <line x1="23" y1="16" x2="28" y2="16" strokeWidth="1" opacity="0.3" />
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

export function PixelAvatar({ role, size = 32, className = "" }: PixelAvatarProps) {
  const reactId = useId();
  const renderer = (role && ROLE_RENDERERS[role]) || DefaultIcon;
  const uniqueId = `av-${reactId}-${role || "default"}`;

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
