/**
 * Modern SVG icon avatars for each agent role.
 * Premium flat vector design with dual-tone gradients, soft glow, and refined symbols.
 * viewBox 0 0 32 32, dark-mode optimized palette.
 */
import React from "react";

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
      <radialGradient id={`${id}-shine`} cx="0.35" cy="0.35" r="0.65">
        <stop offset="0%" stopColor="#fff" stopOpacity="0.18" />
        <stop offset="100%" stopColor="#fff" stopOpacity="0" />
      </radialGradient>
      <filter id={`${id}-glow`}>
        <feGaussianBlur stdDeviation="0.8" result="b" />
        <feMerge>
          <feMergeNode in="b" />
          <feMergeNode in="SourceGraphic" />
        </feMerge>
      </filter>
    </defs>
  );
}

function Bg({ id }: { id: string }): React.ReactElement {
  return (
    <>
      <circle cx="16" cy="16" r="15" fill={`url(#${id}-bg)`} />
      <circle cx="16" cy="16" r="15" fill={`url(#${id}-shine)`} />
    </>
  );
}

function LeadEngineer(id: string): React.ReactElement {
  return (
    <>
      <Defs id={id} from="#3b82f6" to="#6366f1" />
      <Bg id={id} />
      <g
        filter={`url(#${id}-glow)`}
        stroke="#e0e7ff"
        strokeWidth="1.6"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M11 9.5 L8.5 12 L8.5 14.5 L6.5 16 L8.5 17.5 L8.5 20 L11 22.5" />
        <path d="M21 9.5 L23.5 12 L23.5 14.5 L25.5 16 L23.5 17.5 L23.5 20 L21 22.5" />
        <path
          d="M15.5 10.5 L13 16.5 L16.5 15.5 L14 22"
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
      <Defs id={id} from="#10b981" to="#059669" />
      <Bg id={id} />
      <g
        filter={`url(#${id}-glow)`}
        stroke="#d1fae5"
        strokeWidth="1.6"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="13.5" cy="13.5" r="5.5" />
        <line x1="17.5" y1="17.5" x2="24" y2="24" strokeWidth="2.4" />
        <polyline
          points="10.5,13.5 12.5,15.8 17,11"
          strokeWidth="1.8"
          stroke="#6ee7b7"
        />
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
        strokeWidth="1.6"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M5.5 16 Q16 7.5 26.5 16 Q16 24.5 5.5 16 Z" />
        <circle cx="16" cy="16" r="3.2" fill="#ede9fe" stroke="none" />
        <circle cx="16" cy="16" r="1.6" fill="#7c3aed" stroke="none" />
        <line x1="8" y1="24.5" x2="14" y2="24.5" strokeWidth="1.2" opacity="0.5" />
        <line x1="18" y1="24.5" x2="24" y2="24.5" strokeWidth="1.2" opacity="0.5" />
        <line x1="10" y1="26.5" x2="22" y2="26.5" strokeWidth="1.2" opacity="0.3" />
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
        strokeWidth="1.6"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <polygon points="16,5 5,25 27,25" />
        <line x1="10.5" y1="15" x2="21.5" y2="15" strokeWidth="1" opacity="0.45" />
        <line x1="7.8" y1="20" x2="24.2" y2="20" strokeWidth="1" opacity="0.45" />
        <line x1="16" y1="5" x2="16" y2="25" strokeWidth="1" opacity="0.35" />
        <circle cx="16" cy="17" r="1.2" fill="#fef3c7" stroke="none" opacity="0.7" />
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
        stroke="#fecaca"
        strokeWidth="1.6"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M16 4.5 L24.5 8.5 L24.5 15 Q24.5 23.5 16 27 Q7.5 23.5 7.5 15 L7.5 8.5 Z" />
        <rect x="13" y="15.5" width="6" height="5" rx="1" fill="#fecaca" stroke="none" />
        <path d="M14.2 15.5 L14.2 13.5 Q14.2 10.5 16 10.5 Q17.8 10.5 17.8 13.5 L17.8 15.5" strokeWidth="1.5" />
        <circle cx="16" cy="18" r="0.8" fill="#b91c1c" stroke="none" />
      </g>
    </>
  );
}

function Researcher(id: string): React.ReactElement {
  return (
    <>
      <Defs id={id} from="#818cf8" to="#4f46e5" />
      <Bg id={id} />
      <g
        filter={`url(#${id}-glow)`}
        stroke="#e0e7ff"
        strokeWidth="1.6"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="10" cy="10" r="4.5" />
        <line x1="13.5" y1="13.5" x2="22" y2="22" strokeWidth="2.2" />
        <line x1="22" y1="22" x2="24" y2="26.5" strokeWidth="1.4" />
        <line x1="22" y1="22" x2="26.5" y2="24" strokeWidth="1.4" />
        <circle cx="22" cy="7.5" r="1.2" fill="#c7d2fe" stroke="none" />
        <circle cx="25.5" cy="11" r="0.8" fill="#a5b4fc" stroke="none" />
        <circle cx="19" cy="5.5" r="0.6" fill="#a5b4fc" stroke="none" />
        <path d="M21.2 7.5 L22.8 7.5 M22 6.7 L22 8.3" strokeWidth="0.8" stroke="#c7d2fe" />
      </g>
    </>
  );
}

function DevOps(id: string): React.ReactElement {
  return (
    <>
      <Defs id={id} from="#f97316" to="#ea580c" />
      <Bg id={id} />
      <g
        filter={`url(#${id}-glow)`}
        stroke="#fed7aa"
        strokeWidth="1.6"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="16" cy="16" r="3.8" />
        <circle cx="16" cy="16" r="7" strokeDasharray="3.5 2" />
        <path d="M16 5.5 A10.5 10.5 0 0 1 26.5 16" />
        <polyline points="24.5,13 26.5,16 23.5,16" strokeWidth="1.4" />
        <path d="M16 26.5 A10.5 10.5 0 0 1 5.5 16" />
        <polyline points="7.5,19 5.5,16 8.5,16" strokeWidth="1.4" />
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
        strokeWidth="1.6"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M10 24.5 L13.5 13.5 L18.5 13.5 L22 24.5 Z" />
        <path d="M14.8 13.5 L16 7.5 L17.2 13.5" strokeWidth="1.4" />
        <line x1="16" y1="13.5" x2="16" y2="20" strokeWidth="0.8" opacity="0.4" />
        <circle cx="8" cy="9.5" r="2.2" fill="#fbbf24" stroke="none" opacity="0.9" />
        <circle cx="12.5" cy="6.5" r="2" fill="#60a5fa" stroke="none" opacity="0.9" />
        <circle cx="19.5" cy="6.5" r="2" fill="#34d399" stroke="none" opacity="0.9" />
        <circle cx="24" cy="9.5" r="2.2" fill="#fb7185" stroke="none" opacity="0.9" />
      </g>
    </>
  );
}

function Planner(id: string): React.ReactElement {
  return (
    <>
      <Defs id={id} from="#14b8a6" to="#0d9488" />
      <Bg id={id} />
      <g
        filter={`url(#${id}-glow)`}
        stroke="#ccfbf1"
        strokeWidth="1.6"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M16 4.5 Q22.5 4.5 22.5 11 Q22.5 17.5 16 23.5 Q9.5 17.5 9.5 11 Q9.5 4.5 16 4.5 Z" />
        <circle cx="16" cy="11" r="2.8" fill="#ccfbf1" stroke="none" />
        <path d="M8 22 Q12 28 16 25 Q20 28 24 22" strokeWidth="1.2" opacity="0.5" strokeDasharray="2 2" />
        <circle cx="8" cy="22" r="1.2" fill="#99f6e4" stroke="none" />
        <circle cx="24" cy="22" r="1.2" fill="#99f6e4" stroke="none" />
      </g>
    </>
  );
}

function DefaultIcon(id: string): React.ReactElement {
  return (
    <>
      <Defs id={id} from="#64748b" to="#475569" />
      <Bg id={id} />
      <g
        filter={`url(#${id}-glow)`}
        stroke="#e2e8f0"
        strokeWidth="1.6"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <polygon points="16,4.5 27.5,16 16,27.5 4.5,16" />
        <polygon points="16,9.5 22.5,16 16,22.5 9.5,16" strokeWidth="1" opacity="0.45" />
        <line x1="16" y1="4.5" x2="16" y2="27.5" strokeWidth="0.8" opacity="0.3" />
        <line x1="4.5" y1="16" x2="27.5" y2="16" strokeWidth="0.8" opacity="0.3" />
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

let idCounter = 0;

export function PixelAvatar({
  role,
  size = 32,
  className = "",
}: PixelAvatarProps) {
  const renderer = (role && ROLE_RENDERERS[role]) || DefaultIcon;
  const uniqueId = `av-${role || "d"}-${idCounter++}`;

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
