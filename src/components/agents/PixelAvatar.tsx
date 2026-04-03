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

function Bg({ id, c1, c2 }: { id: string; c1: string; c2: string }) {
  return (
    <defs>
      <radialGradient id={`${id}-bg`} cx="30%" cy="30%" r="70%">
        <stop offset="0%" stopColor={c1} />
        <stop offset="100%" stopColor={c2} />
      </radialGradient>
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

function Base({ id }: { id: string }) {
  return (
    <>
      <circle cx="16" cy="16" r="15" fill={`url(#${id}-bg)`} />
      <circle cx="16" cy="16" r="15" fill="none" stroke="#fff" strokeWidth="0.4" opacity="0.15" />
    </>
  );
}

function LeadEngineer(id: string): React.ReactElement {
  return (
    <>
      <Bg id={id} c1="#60a5fa" c2="#4338ca" />
      <Base id={id} />
      <g filter={`url(#${id}-glow)`} stroke="#e0e7ff" strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round">
        <path d="M10.5 10 L8 12.5 L8 14 L6.5 16 L8 18 L8 19.5 L10.5 22" />
        <path d="M21.5 10 L24 12.5 L24 14 L25.5 16 L24 18 L24 19.5 L21.5 22" />
        <path d="M15.5 10.5 L13 17.5 L16.5 16 L14 23" strokeWidth="2" stroke="#fbbf24" />
      </g>
    </>
  );
}

function Tester(id: string): React.ReactElement {
  return (
    <>
      <Bg id={id} c1="#4ade80" c2="#15803d" />
      <Base id={id} />
      <g filter={`url(#${id}-glow)`} stroke="#dcfce7" strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="13.5" cy="13.5" r="5.5" />
        <line x1="17.5" y1="17.5" x2="24" y2="24" strokeWidth="2.2" />
        <polyline points="10.5,13.5 12.5,15.8 16.5,11.5" strokeWidth="1.8" stroke="#bbf7d0" />
      </g>
    </>
  );
}

function CodeReviewer(id: string): React.ReactElement {
  return (
    <>
      <Bg id={id} c1="#c084fc" c2="#6d28d9" />
      <Base id={id} />
      <g filter={`url(#${id}-glow)`} stroke="#ede9fe" strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round">
        <path d="M5.5 16 Q16 7.5 26.5 16 Q16 24.5 5.5 16 Z" />
        <circle cx="16" cy="16" r="3.2" fill="#ede9fe" stroke="none" />
        <circle cx="16" cy="16" r="1.6" fill="#6d28d9" stroke="none" />
        <line x1="8" y1="25.5" x2="14" y2="25.5" strokeWidth="1.2" opacity="0.5" />
        <line x1="18" y1="25.5" x2="24" y2="25.5" strokeWidth="1.2" opacity="0.5" />
      </g>
    </>
  );
}

function Architect(id: string): React.ReactElement {
  return (
    <>
      <Bg id={id} c1="#fbbf24" c2="#b45309" />
      <Base id={id} />
      <g filter={`url(#${id}-glow)`} stroke="#fef3c7" strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round">
        <polygon points="16,5.5 5.5,25 26.5,25" />
        <line x1="10.8" y1="15" x2="21.2" y2="15" strokeWidth="0.9" opacity="0.45" />
        <line x1="8.2" y1="20" x2="23.8" y2="20" strokeWidth="0.9" opacity="0.45" />
        <line x1="16" y1="5.5" x2="16" y2="25" strokeWidth="0.9" opacity="0.45" />
      </g>
    </>
  );
}

function SecurityReviewer(id: string): React.ReactElement {
  return (
    <>
      <Bg id={id} c1="#f87171" c2="#991b1b" />
      <Base id={id} />
      <g filter={`url(#${id}-glow)`} stroke="#fee2e2" strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round">
        <path d="M16 4.5 L24.5 9 L24.5 16 Q24.5 24.5 16 27.5 Q7.5 24.5 7.5 16 L7.5 9 Z" />
        <rect x="13" y="15.5" width="6" height="5" rx="1" fill="#fee2e2" stroke="none" />
        <path d="M14.2 15.5 L14.2 13.5 Q14.2 10.8 16 10.8 Q17.8 10.8 17.8 13.5 L17.8 15.5" strokeWidth="1.5" />
        <circle cx="16" cy="18" r="0.9" fill="#991b1b" stroke="none" />
      </g>
    </>
  );
}

function Researcher(id: string): React.ReactElement {
  return (
    <>
      <Bg id={id} c1="#818cf8" c2="#3730a3" />
      <Base id={id} />
      <g filter={`url(#${id}-glow)`} stroke="#e0e7ff" strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="10" cy="10" r="4.5" />
        <line x1="13.5" y1="13.5" x2="22" y2="22" strokeWidth="2" />
        <line x1="22" y1="22" x2="24" y2="26.5" strokeWidth="1.4" />
        <line x1="22" y1="22" x2="26.5" y2="24" strokeWidth="1.4" />
        <circle cx="22" cy="7.5" r="1.2" fill="#e0e7ff" stroke="none" />
        <circle cx="25.5" cy="11.5" r="0.8" fill="#c7d2fe" stroke="none" />
        <circle cx="19" cy="5.5" r="0.6" fill="#c7d2fe" stroke="none" />
      </g>
    </>
  );
}

function DevOps(id: string): React.ReactElement {
  return (
    <>
      <Bg id={id} c1="#fb923c" c2="#c2410c" />
      <Base id={id} />
      <g filter={`url(#${id}-glow)`} stroke="#ffedd5" strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="16" cy="16" r="4" />
        <circle cx="16" cy="16" r="7.5" strokeDasharray="3.5 2.5" />
        <path d="M16 5.5 A10.5 10.5 0 0 1 26.5 16" />
        <polyline points="25,12.5 26.5,16 23,16" strokeWidth="1.4" />
        <path d="M16 26.5 A10.5 10.5 0 0 1 5.5 16" />
        <polyline points="7,19.5 5.5,16 9,16" strokeWidth="1.4" />
      </g>
    </>
  );
}

function Designer(id: string): React.ReactElement {
  return (
    <>
      <Bg id={id} c1="#f472b6" c2="#9d174d" />
      <Base id={id} />
      <g filter={`url(#${id}-glow)`} stroke="#fce7f3" strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round">
        <path d="M10 24.5 L13.5 13.5 L18.5 13.5 L22 24.5 Z" />
        <path d="M14.8 13.5 L16 7.5 L17.2 13.5" strokeWidth="1.4" />
        <line x1="16" y1="13.5" x2="16" y2="20" strokeWidth="0.9" opacity="0.4" />
        <circle cx="7.5" cy="9.5" r="2.2" fill="#fbbf24" stroke="none" />
        <circle cx="12" cy="6.5" r="2" fill="#60a5fa" stroke="none" />
        <circle cx="20" cy="6.5" r="2" fill="#34d399" stroke="none" />
        <circle cx="24.5" cy="9.5" r="2.2" fill="#f87171" stroke="none" />
      </g>
    </>
  );
}

function Planner(id: string): React.ReactElement {
  return (
    <>
      <Bg id={id} c1="#2dd4bf" c2="#0f766e" />
      <Base id={id} />
      <g filter={`url(#${id}-glow)`} stroke="#ccfbf1" strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round">
        <path d="M16 4.5 Q22.5 4.5 22.5 11 Q22.5 17.5 16 23.5 Q9.5 17.5 9.5 11 Q9.5 4.5 16 4.5 Z" />
        <circle cx="16" cy="11" r="2.8" fill="#ccfbf1" stroke="none" />
        <circle cx="6.5" cy="20" r="1.2" fill="#ccfbf1" stroke="none" />
        <circle cx="10" cy="25.5" r="0.9" fill="#99f6e4" stroke="none" />
        <circle cx="22" cy="25.5" r="0.9" fill="#99f6e4" stroke="none" />
        <circle cx="25.5" cy="20" r="1.2" fill="#ccfbf1" stroke="none" />
        <path d="M6.5 20 L10 25.5" strokeWidth="0.9" opacity="0.35" />
        <path d="M22 25.5 L25.5 20" strokeWidth="0.9" opacity="0.35" />
      </g>
    </>
  );
}

function DefaultIcon(id: string): React.ReactElement {
  return (
    <>
      <Bg id={id} c1="#94a3b8" c2="#334155" />
      <Base id={id} />
      <g filter={`url(#${id}-glow)`} stroke="#e2e8f0" strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round">
        <polygon points="16,4.5 27.5,16 16,27.5 4.5,16" />
        <line x1="16" y1="4.5" x2="16" y2="27.5" strokeWidth="0.9" opacity="0.35" />
        <line x1="4.5" y1="16" x2="27.5" y2="16" strokeWidth="0.9" opacity="0.35" />
        <polygon points="16,9.5 22.5,16 16,22.5 9.5,16" strokeWidth="0.9" opacity="0.45" />
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
