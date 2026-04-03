/**
 * Modern SVG icon avatars for each agent role.
 * Minimal, flat vector design with radial gradient backgrounds
 * and subtle glow effects for a premium look in dark mode.
 */
import React, { useId } from "react";

interface PixelAvatarProps {
  role: string | null;
  size?: number;
  className?: string;
}

type RoleRenderer = (id: string) => React.ReactElement;

function Bg({ id, c1, c2 }: { id: string; c1: string; c2: string }) {
  return (
    <defs>
      <radialGradient id={`${id}-bg`} cx="35%" cy="35%" r="65%">
        <stop offset="0%" stopColor={c1} />
        <stop offset="100%" stopColor={c2} />
      </radialGradient>
      <filter id={`${id}-glow`}>
        <feGaussianBlur stdDeviation="0.8" result="blur" />
        <feMerge>
          <feMergeNode in="blur" />
          <feMergeNode in="SourceGraphic" />
        </feMerge>
      </filter>
    </defs>
  );
}

function Base({ id }: { id: string }) {
  return (
    <>
      <circle cx="16" cy="16" r="15.5" fill={`url(#${id}-bg)`} />
      <circle
        cx="16"
        cy="16"
        r="15.5"
        fill="none"
        stroke="#fff"
        strokeWidth="0.3"
        opacity="0.12"
      />
    </>
  );
}

function LeadEngineer(id: string): React.ReactElement {
  return (
    <>
      <Bg id={id} c1="#818cf8" c2="#312e81" />
      <Base id={id} />
      <g
        filter={`url(#${id}-glow)`}
        stroke="#c7d2fe"
        strokeWidth="1.5"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M10.5 9.5 L7.5 12.5 L7.5 14.5 L6 16 L7.5 17.5 L7.5 19.5 L10.5 22.5" />
        <path d="M21.5 9.5 L24.5 12.5 L24.5 14.5 L26 16 L24.5 17.5 L24.5 19.5 L21.5 22.5" />
        <path
          d="M15 10 L12.5 17 L16 15.5 L13.5 23"
          strokeWidth="2"
          stroke="#fbbf24"
        />
      </g>
    </>
  );
}

function Tester(id: string): React.ReactElement {
  return (
    <>
      <Bg id={id} c1="#6ee7b7" c2="#064e3b" />
      <Base id={id} />
      <g
        filter={`url(#${id}-glow)`}
        stroke="#d1fae5"
        strokeWidth="1.5"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="13" cy="13" r="5.5" />
        <line x1="17" y1="17" x2="25" y2="25" strokeWidth="2.2" />
        <polyline
          points="10,13 12.2,15.5 16,11"
          strokeWidth="1.8"
          stroke="#a7f3d0"
        />
      </g>
    </>
  );
}

function CodeReviewer(id: string): React.ReactElement {
  return (
    <>
      <Bg id={id} c1="#c4b5fd" c2="#4c1d95" />
      <Base id={id} />
      <g
        filter={`url(#${id}-glow)`}
        stroke="#ede9fe"
        strokeWidth="1.5"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M5 16 Q16 7 27 16 Q16 25 5 16 Z" />
        <circle cx="16" cy="16" r="3.5" fill="#ede9fe" stroke="none" />
        <circle cx="16" cy="16" r="1.8" fill="#5b21b6" stroke="none" />
        <line x1="8" y1="25" x2="14" y2="25" strokeWidth="1" opacity="0.4" />
        <line x1="18" y1="25" x2="24" y2="25" strokeWidth="1" opacity="0.4" />
        <line x1="10" y1="27" x2="22" y2="27" strokeWidth="1" opacity="0.25" />
      </g>
    </>
  );
}

function Architect(id: string): React.ReactElement {
  return (
    <>
      <Bg id={id} c1="#fcd34d" c2="#78350f" />
      <Base id={id} />
      <g
        filter={`url(#${id}-glow)`}
        stroke="#fef3c7"
        strokeWidth="1.5"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <polygon points="16,5 5,26 27,26" />
        <line x1="10.5" y1="15.5" x2="21.5" y2="15.5" strokeWidth="0.8" opacity="0.4" />
        <line x1="8" y1="21" x2="24" y2="21" strokeWidth="0.8" opacity="0.4" />
        <line x1="16" y1="5" x2="16" y2="26" strokeWidth="0.8" opacity="0.4" />
        <circle cx="16" cy="16" r="1.5" fill="#fef3c7" stroke="none" opacity="0.6" />
      </g>
    </>
  );
}

function SecurityReviewer(id: string): React.ReactElement {
  return (
    <>
      <Bg id={id} c1="#fca5a5" c2="#7f1d1d" />
      <Base id={id} />
      <g
        filter={`url(#${id}-glow)`}
        stroke="#fecaca"
        strokeWidth="1.5"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M16 4 L25 8.5 L25 15.5 Q25 24 16 27.5 Q7 24 7 15.5 L7 8.5 Z" />
        <rect x="13" y="15" width="6" height="5.5" rx="1.2" fill="#fecaca" stroke="none" />
        <path d="M14.2 15 L14.2 13 Q14.2 10.5 16 10.5 Q17.8 10.5 17.8 13 L17.8 15" strokeWidth="1.4" />
        <circle cx="16" cy="17.8" r="0.8" fill="#991b1b" stroke="none" />
        <line x1="16" y1="18.6" x2="16" y2="19.5" strokeWidth="0.8" stroke="#991b1b" />
      </g>
    </>
  );
}

function Researcher(id: string): React.ReactElement {
  return (
    <>
      <Bg id={id} c1="#a5b4fc" c2="#1e1b4b" />
      <Base id={id} />
      <g
        filter={`url(#${id}-glow)`}
        stroke="#e0e7ff"
        strokeWidth="1.5"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="10" cy="10" r="4.5" />
        <line x1="13.5" y1="13.5" x2="21" y2="21" strokeWidth="2" />
        <line x1="21" y1="21" x2="23.5" y2="26" strokeWidth="1.3" />
        <line x1="21" y1="21" x2="26" y2="23.5" strokeWidth="1.3" />
        <circle cx="22" cy="7" r="1.3" fill="#e0e7ff" stroke="none" />
        <circle cx="26" cy="11" r="0.9" fill="#c7d2fe" stroke="none" />
        <circle cx="19" cy="5" r="0.6" fill="#c7d2fe" stroke="none" />
        <circle cx="24.5" cy="5" r="0.5" fill="#a5b4fc" stroke="none" />
      </g>
    </>
  );
}

function DevOps(id: string): React.ReactElement {
  return (
    <>
      <Bg id={id} c1="#fdba74" c2="#7c2d12" />
      <Base id={id} />
      <g
        filter={`url(#${id}-glow)`}
        stroke="#fed7aa"
        strokeWidth="1.5"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="16" cy="16" r="3.5" />
        <circle cx="16" cy="16" r="7" strokeDasharray="3 2.5" />
        <path d="M16 5.5 A10.5 10.5 0 0 1 26.5 16" />
        <polyline points="25,12.5 26.5,16 23,16" strokeWidth="1.3" />
        <path d="M16 26.5 A10.5 10.5 0 0 1 5.5 16" />
        <polyline points="7,19.5 5.5,16 9,16" strokeWidth="1.3" />
      </g>
    </>
  );
}

function Designer(id: string): React.ReactElement {
  return (
    <>
      <Bg id={id} c1="#f9a8d4" c2="#831843" />
      <Base id={id} />
      <g
        filter={`url(#${id}-glow)`}
        stroke="#fce7f3"
        strokeWidth="1.5"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M10 24.5 L13.5 13 L18.5 13 L22 24.5 Z" />
        <path d="M15 13 L16 7 L17 13" strokeWidth="1.3" />
        <line x1="16" y1="13" x2="16" y2="20" strokeWidth="0.8" opacity="0.35" />
        <circle cx="7" cy="9" r="2.2" fill="#fbbf24" stroke="none" />
        <circle cx="11.5" cy="6" r="2" fill="#60a5fa" stroke="none" />
        <circle cx="20.5" cy="6" r="2" fill="#34d399" stroke="none" />
        <circle cx="25" cy="9" r="2.2" fill="#fb7185" stroke="none" />
      </g>
    </>
  );
}

function Planner(id: string): React.ReactElement {
  return (
    <>
      <Bg id={id} c1="#5eead4" c2="#134e4a" />
      <Base id={id} />
      <g
        filter={`url(#${id}-glow)`}
        stroke="#ccfbf1"
        strokeWidth="1.5"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M16 4 Q23 4 23 11 Q23 18 16 24 Q9 18 9 11 Q9 4 16 4 Z" />
        <circle cx="16" cy="11" r="3" fill="#ccfbf1" stroke="none" />
        <circle cx="6" cy="20" r="1.2" fill="#ccfbf1" stroke="none" />
        <circle cx="9.5" cy="26" r="0.9" fill="#99f6e4" stroke="none" />
        <circle cx="22.5" cy="26" r="0.9" fill="#99f6e4" stroke="none" />
        <circle cx="26" cy="20" r="1.2" fill="#ccfbf1" stroke="none" />
        <path d="M6 20 L9.5 26" strokeWidth="0.8" opacity="0.35" />
        <path d="M22.5 26 L26 20" strokeWidth="0.8" opacity="0.35" />
      </g>
    </>
  );
}

function DefaultIcon(id: string): React.ReactElement {
  return (
    <>
      <Bg id={id} c1="#94a3b8" c2="#1e293b" />
      <Base id={id} />
      <g
        filter={`url(#${id}-glow)`}
        stroke="#e2e8f0"
        strokeWidth="1.5"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <polygon points="16,4 28,16 16,28 4,16" />
        <line x1="16" y1="4" x2="16" y2="28" strokeWidth="0.8" opacity="0.3" />
        <line x1="4" y1="16" x2="28" y2="16" strokeWidth="0.8" opacity="0.3" />
        <polygon points="16,9 23,16 16,23 9,16" strokeWidth="0.8" opacity="0.4" />
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
  const uniqueId = `avatar-${role || "default"}-${reactId}`;

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
