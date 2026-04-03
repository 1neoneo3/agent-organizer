/**
 * Modern SVG icon avatars for each agent role.
 * Linear/Notion-inspired minimal flat design with subtle gradient and glow.
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
        <feGaussianBlur stdDeviation="0.8" result="blur" />
        <feMerge>
          <feMergeNode in="blur" />
          <feMergeNode in="SourceGraphic" />
        </feMerge>
      </filter>
    </defs>
  );
}

function BgCircle({ id }: { id: string }): React.ReactElement {
  return <circle cx="16" cy="16" r="15" fill={`url(#${id}-bg)`} />;
}

function LeadEngineer(id: string): React.ReactElement {
  return (
    <>
      <Defs id={id} from="#3b82f6" to="#6366f1" />
      <BgCircle id={id} />
      <g
        filter={`url(#${id}-glow)`}
        stroke="#e0e7ff"
        strokeWidth="2"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M11 9.5 L8.5 12 L8.5 15 L6.5 16 L8.5 17 L8.5 20 L11 22.5" />
        <path d="M21 9.5 L23.5 12 L23.5 15 L25.5 16 L23.5 17 L23.5 20 L21 22.5" />
        <path
          d="M15.5 11 L13.5 17 L16.5 16 L14.5 22"
          strokeWidth="2.2"
          stroke="#fbbf24"
        />
      </g>
    </>
  );
}

function Tester(id: string): React.ReactElement {
  return (
    <>
      <Defs id={id} from="#22c55e" to="#059669" />
      <BgCircle id={id} />
      <g
        filter={`url(#${id}-glow)`}
        stroke="#d1fae5"
        strokeWidth="2"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="14" cy="13.5" r="5.5" />
        <line x1="18.2" y1="17.7" x2="24" y2="23.5" strokeWidth="2.5" />
        <polyline
          points="11,13.5 13,15.5 17,11.5"
          strokeWidth="2"
          stroke="#a7f3d0"
        />
      </g>
    </>
  );
}

function CodeReviewer(id: string): React.ReactElement {
  return (
    <>
      <Defs id={id} from="#a855f7" to="#7c3aed" />
      <BgCircle id={id} />
      <g
        filter={`url(#${id}-glow)`}
        stroke="#ede9fe"
        strokeWidth="1.8"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M5 16 Q16 7.5 27 16 Q16 24.5 5 16 Z" />
        <circle cx="16" cy="16" r="3.2" fill="#ede9fe" stroke="none" />
        <circle cx="16" cy="16" r="1.5" fill="#7c3aed" stroke="none" />
        <line x1="8" y1="25" x2="14" y2="25" strokeWidth="1.4" opacity="0.5" />
        <line x1="18" y1="25" x2="24" y2="25" strokeWidth="1.4" opacity="0.5" />
      </g>
    </>
  );
}

function Architect(id: string): React.ReactElement {
  return (
    <>
      <Defs id={id} from="#f59e0b" to="#d97706" />
      <BgCircle id={id} />
      <g
        filter={`url(#${id}-glow)`}
        stroke="#fef3c7"
        strokeWidth="2"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <polygon points="16,5.5 5.5,25 26.5,25" />
        <line x1="10.8" y1="15" x2="21.2" y2="15" strokeWidth="1.2" opacity="0.45" />
        <line x1="8" y1="20" x2="24" y2="20" strokeWidth="1.2" opacity="0.45" />
        <line x1="16" y1="5.5" x2="16" y2="25" strokeWidth="1.2" opacity="0.45" />
      </g>
    </>
  );
}

function SecurityReviewer(id: string): React.ReactElement {
  return (
    <>
      <Defs id={id} from="#ef4444" to="#b91c1c" />
      <BgCircle id={id} />
      <g
        filter={`url(#${id}-glow)`}
        stroke="#fee2e2"
        strokeWidth="1.8"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M16 4.5 L24.5 8.5 L24.5 15.5 Q24.5 24 16 27.5 Q7.5 24 7.5 15.5 L7.5 8.5 Z" />
        <rect x="13" y="16" width="6" height="5" rx="1.2" fill="#fee2e2" stroke="none" />
        <path d="M14.2 16 L14.2 13.8 Q14.2 11 16 11 Q17.8 11 17.8 13.8 L17.8 16" strokeWidth="1.8" />
        <circle cx="16" cy="18.5" r="0.9" fill="#b91c1c" stroke="none" />
      </g>
    </>
  );
}

function Researcher(id: string): React.ReactElement {
  return (
    <>
      <Defs id={id} from="#6366f1" to="#4338ca" />
      <BgCircle id={id} />
      <g
        filter={`url(#${id}-glow)`}
        stroke="#e0e7ff"
        strokeWidth="2"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="10" cy="10" r="4.5" />
        <line x1="13.5" y1="13.5" x2="22" y2="22" strokeWidth="2.2" />
        <line x1="22" y1="22" x2="24" y2="26.5" strokeWidth="1.6" />
        <line x1="22" y1="22" x2="26.5" y2="24" strokeWidth="1.6" />
        <circle cx="22" cy="7.5" r="1.2" fill="#e0e7ff" stroke="none" />
        <circle cx="25.5" cy="11" r="0.8" fill="#c7d2fe" stroke="none" />
        <circle cx="19" cy="5.5" r="0.6" fill="#c7d2fe" stroke="none" />
      </g>
    </>
  );
}

function DevOps(id: string): React.ReactElement {
  return (
    <>
      <Defs id={id} from="#f97316" to="#c2410c" />
      <BgCircle id={id} />
      <g
        filter={`url(#${id}-glow)`}
        stroke="#ffedd5"
        strokeWidth="2"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="16" cy="16" r="4.2" />
        <circle cx="16" cy="16" r="7.5" strokeDasharray="3.5 2.8" />
        <path d="M16 5.5 A10.5 10.5 0 0 1 26.5 16" />
        <polyline points="25,13 26.5,16 23.5,16" strokeWidth="1.6" />
        <path d="M16 26.5 A10.5 10.5 0 0 1 5.5 16" />
        <polyline points="7,19 5.5,16 8.5,16" strokeWidth="1.6" />
      </g>
    </>
  );
}

function Designer(id: string): React.ReactElement {
  return (
    <>
      <Defs id={id} from="#ec4899" to="#be185d" />
      <BgCircle id={id} />
      <g
        filter={`url(#${id}-glow)`}
        stroke="#fce7f3"
        strokeWidth="1.8"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M10 24.5 L13.5 13.5 L18.5 13.5 L22 24.5 Z" />
        <path d="M14.8 13.5 L16 7.5 L17.2 13.5" strokeWidth="1.6" />
        <line x1="16" y1="13.5" x2="16" y2="20" strokeWidth="1" opacity="0.4" />
        <circle cx="7.5" cy="10" r="2.2" fill="#fbbf24" stroke="none" />
        <circle cx="12" cy="6.5" r="2" fill="#60a5fa" stroke="none" />
        <circle cx="20" cy="6.5" r="2" fill="#34d399" stroke="none" />
        <circle cx="24.5" cy="10" r="2.2" fill="#f87171" stroke="none" />
      </g>
    </>
  );
}

function Planner(id: string): React.ReactElement {
  return (
    <>
      <Defs id={id} from="#14b8a6" to="#0f766e" />
      <BgCircle id={id} />
      <g
        filter={`url(#${id}-glow)`}
        stroke="#ccfbf1"
        strokeWidth="2"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M16 4.5 Q22.5 4.5 22.5 11 Q22.5 17.5 16 23.5 Q9.5 17.5 9.5 11 Q9.5 4.5 16 4.5 Z" />
        <circle cx="16" cy="11" r="2.8" fill="#ccfbf1" stroke="none" />
        <circle cx="6.5" cy="20" r="1.2" fill="#ccfbf1" stroke="none" />
        <circle cx="9.5" cy="25.5" r="0.9" fill="#99f6e4" stroke="none" />
        <circle cx="22.5" cy="25.5" r="0.9" fill="#99f6e4" stroke="none" />
        <circle cx="25.5" cy="20" r="1.2" fill="#ccfbf1" stroke="none" />
        <path d="M6.5 20 L9.5 25.5" strokeWidth="1.2" opacity="0.35" />
        <path d="M22.5 25.5 L25.5 20" strokeWidth="1.2" opacity="0.35" />
      </g>
    </>
  );
}

function DefaultIcon(id: string): React.ReactElement {
  return (
    <>
      <Defs id={id} from="#64748b" to="#334155" />
      <BgCircle id={id} />
      <g
        filter={`url(#${id}-glow)`}
        stroke="#e2e8f0"
        strokeWidth="2"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <polygon points="16,4.5 27.5,16 16,27.5 4.5,16" />
        <line x1="16" y1="4.5" x2="16" y2="27.5" strokeWidth="1.2" opacity="0.35" />
        <line x1="4.5" y1="16" x2="27.5" y2="16" strokeWidth="1.2" opacity="0.35" />
        <polygon points="16,9.5 22.5,16 16,22.5 9.5,16" strokeWidth="1.2" opacity="0.45" />
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
