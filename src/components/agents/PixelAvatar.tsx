/**
 * Modern SVG icon avatars for each agent role.
 * Minimal, flat vector design with gradient/glow effects.
 * Each icon uses abstract symbols to represent the role.
 */
import React from "react";

interface PixelAvatarProps {
  role: string | null;
  size?: number;
  className?: string;
}

type RoleRenderer = (defsId: string) => React.ReactElement;

function LeadEngineer(id: string): React.ReactElement {
  return (
    <>
      <defs>
        <linearGradient id={`${id}-bg`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#3b82f6" />
          <stop offset="100%" stopColor="#6366f1" />
        </linearGradient>
        <filter id={`${id}-glow`}>
          <feGaussianBlur stdDeviation="1.2" result="blur" />
          <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
      </defs>
      <circle cx="16" cy="16" r="14" fill={`url(#${id}-bg)`} />
      <g filter={`url(#${id}-glow)`} stroke="#e0e7ff" strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round">
        {/* { } brackets */}
        <path d="M10 10 L8 12 L8 14 L6 16 L8 18 L8 20 L10 22" />
        <path d="M22 10 L24 12 L24 14 L26 16 L24 18 L24 20 L22 22" />
        {/* lightning bolt */}
        <path d="M15 11 L13 17 L16 16 L14 22" strokeWidth="2" stroke="#fbbf24" />
      </g>
    </>
  );
}

function Tester(id: string): React.ReactElement {
  return (
    <>
      <defs>
        <linearGradient id={`${id}-bg`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#22c55e" />
          <stop offset="100%" stopColor="#16a34a" />
        </linearGradient>
        <filter id={`${id}-glow`}>
          <feGaussianBlur stdDeviation="1.2" result="blur" />
          <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
      </defs>
      <circle cx="16" cy="16" r="14" fill={`url(#${id}-bg)`} />
      <g filter={`url(#${id}-glow)`} stroke="#dcfce7" strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round">
        {/* magnifying glass */}
        <circle cx="14" cy="14" r="5" />
        <line x1="18" y1="18" x2="23" y2="23" strokeWidth="2.2" />
        {/* checkmark inside */}
        <polyline points="11.5,14 13.5,16 17,12" strokeWidth="1.6" stroke="#bbf7d0" />
      </g>
    </>
  );
}

function CodeReviewer(id: string): React.ReactElement {
  return (
    <>
      <defs>
        <linearGradient id={`${id}-bg`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#a855f7" />
          <stop offset="100%" stopColor="#7c3aed" />
        </linearGradient>
        <filter id={`${id}-glow`}>
          <feGaussianBlur stdDeviation="1.2" result="blur" />
          <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
      </defs>
      <circle cx="16" cy="16" r="14" fill={`url(#${id}-bg)`} />
      <g filter={`url(#${id}-glow)`} stroke="#ede9fe" strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round">
        {/* eye */}
        <path d="M6 16 Q16 8 26 16 Q16 24 6 16 Z" />
        <circle cx="16" cy="16" r="3" fill="#ede9fe" stroke="none" />
        <circle cx="16" cy="16" r="1.5" fill="#7c3aed" stroke="none" />
        {/* code lines below */}
        <line x1="9" y1="25" x2="15" y2="25" strokeWidth="1.2" opacity="0.6" />
        <line x1="17" y1="25" x2="23" y2="25" strokeWidth="1.2" opacity="0.6" />
      </g>
    </>
  );
}

function Architect(id: string): React.ReactElement {
  return (
    <>
      <defs>
        <linearGradient id={`${id}-bg`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#f59e0b" />
          <stop offset="100%" stopColor="#d97706" />
        </linearGradient>
        <filter id={`${id}-glow`}>
          <feGaussianBlur stdDeviation="1.2" result="blur" />
          <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
      </defs>
      <circle cx="16" cy="16" r="14" fill={`url(#${id}-bg)`} />
      <g filter={`url(#${id}-glow)`} stroke="#fef3c7" strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round">
        {/* pyramid / triangle */}
        <polygon points="16,6 6,24 26,24" />
        {/* inner grid lines */}
        <line x1="11" y1="15" x2="21" y2="15" strokeWidth="1" opacity="0.5" />
        <line x1="8.5" y1="20" x2="23.5" y2="20" strokeWidth="1" opacity="0.5" />
        <line x1="16" y1="6" x2="16" y2="24" strokeWidth="1" opacity="0.5" />
      </g>
    </>
  );
}

function SecurityReviewer(id: string): React.ReactElement {
  return (
    <>
      <defs>
        <linearGradient id={`${id}-bg`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#ef4444" />
          <stop offset="100%" stopColor="#b91c1c" />
        </linearGradient>
        <filter id={`${id}-glow`}>
          <feGaussianBlur stdDeviation="1.2" result="blur" />
          <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
      </defs>
      <circle cx="16" cy="16" r="14" fill={`url(#${id}-bg)`} />
      <g filter={`url(#${id}-glow)`} stroke="#fee2e2" strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round">
        {/* shield */}
        <path d="M16 5 L24 9 L24 16 Q24 24 16 27 Q8 24 8 16 L8 9 Z" />
        {/* lock */}
        <rect x="13" y="16" width="6" height="5" rx="1" fill="#fee2e2" stroke="none" />
        <path d="M14 16 L14 14 Q14 11 16 11 Q18 11 18 14 L18 16" strokeWidth="1.6" />
        <circle cx="16" cy="18.5" r="0.8" fill="#b91c1c" stroke="none" />
      </g>
    </>
  );
}

function Researcher(id: string): React.ReactElement {
  return (
    <>
      <defs>
        <linearGradient id={`${id}-bg`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#6366f1" />
          <stop offset="100%" stopColor="#4f46e5" />
        </linearGradient>
        <filter id={`${id}-glow`}>
          <feGaussianBlur stdDeviation="1.2" result="blur" />
          <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
      </defs>
      <circle cx="16" cy="16" r="14" fill={`url(#${id}-bg)`} />
      <g filter={`url(#${id}-glow)`} stroke="#e0e7ff" strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round">
        {/* telescope */}
        <circle cx="10" cy="10" r="4" />
        <line x1="13" y1="13" x2="22" y2="22" strokeWidth="2" />
        <line x1="22" y1="22" x2="24" y2="26" strokeWidth="1.5" />
        <line x1="22" y1="22" x2="26" y2="24" strokeWidth="1.5" />
        {/* stars */}
        <circle cx="22" cy="8" r="1" fill="#e0e7ff" stroke="none" />
        <circle cx="25" cy="12" r="0.7" fill="#c7d2fe" stroke="none" />
        <circle cx="19" cy="6" r="0.5" fill="#c7d2fe" stroke="none" />
      </g>
    </>
  );
}

function DevOps(id: string): React.ReactElement {
  return (
    <>
      <defs>
        <linearGradient id={`${id}-bg`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#f97316" />
          <stop offset="100%" stopColor="#ea580c" />
        </linearGradient>
        <filter id={`${id}-glow`}>
          <feGaussianBlur stdDeviation="1.2" result="blur" />
          <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
      </defs>
      <circle cx="16" cy="16" r="14" fill={`url(#${id}-bg)`} />
      <g filter={`url(#${id}-glow)`} stroke="#ffedd5" strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round">
        {/* gear */}
        <circle cx="16" cy="16" r="4" />
        <circle cx="16" cy="16" r="7" strokeDasharray="3 2.5" />
        {/* circular arrows */}
        <path d="M16 6 A10 10 0 0 1 26 16" />
        <polyline points="25,13 26,16 23,16" strokeWidth="1.5" />
        <path d="M16 26 A10 10 0 0 1 6 16" />
        <polyline points="7,19 6,16 9,16" strokeWidth="1.5" />
      </g>
    </>
  );
}

function Designer(id: string): React.ReactElement {
  return (
    <>
      <defs>
        <linearGradient id={`${id}-bg`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#ec4899" />
          <stop offset="100%" stopColor="#db2777" />
        </linearGradient>
        <filter id={`${id}-glow`}>
          <feGaussianBlur stdDeviation="1.2" result="blur" />
          <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
      </defs>
      <circle cx="16" cy="16" r="14" fill={`url(#${id}-bg)`} />
      <g filter={`url(#${id}-glow)`} stroke="#fce7f3" strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round">
        {/* pen nib */}
        <path d="M10 24 L13 14 L19 14 L22 24 Z" />
        <path d="M14.5 14 L16 8 L17.5 14" strokeWidth="1.5" />
        <line x1="16" y1="14" x2="16" y2="20" strokeWidth="1" opacity="0.5" />
        {/* color dots */}
        <circle cx="8" cy="10" r="2" fill="#fbbf24" stroke="none" />
        <circle cx="12" cy="7" r="1.8" fill="#60a5fa" stroke="none" />
        <circle cx="20" cy="7" r="1.8" fill="#34d399" stroke="none" />
        <circle cx="24" cy="10" r="2" fill="#f87171" stroke="none" />
      </g>
    </>
  );
}

function Planner(id: string): React.ReactElement {
  return (
    <>
      <defs>
        <linearGradient id={`${id}-bg`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#14b8a6" />
          <stop offset="100%" stopColor="#0d9488" />
        </linearGradient>
        <filter id={`${id}-glow`}>
          <feGaussianBlur stdDeviation="1.2" result="blur" />
          <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
      </defs>
      <circle cx="16" cy="16" r="14" fill={`url(#${id}-bg)`} />
      <g filter={`url(#${id}-glow)`} stroke="#ccfbf1" strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round">
        {/* map pin */}
        <path d="M16 5 Q22 5 22 11 Q22 17 16 23 Q10 17 10 11 Q10 5 16 5 Z" />
        <circle cx="16" cy="11" r="2.5" fill="#ccfbf1" stroke="none" />
        {/* route dots */}
        <circle cx="7" cy="20" r="1" fill="#ccfbf1" stroke="none" />
        <circle cx="10" cy="25" r="0.8" fill="#99f6e4" stroke="none" />
        <circle cx="22" cy="25" r="0.8" fill="#99f6e4" stroke="none" />
        <circle cx="25" cy="20" r="1" fill="#ccfbf1" stroke="none" />
        {/* route lines */}
        <path d="M7 20 L10 25" strokeWidth="1" opacity="0.4" />
        <path d="M22 25 L25 20" strokeWidth="1" opacity="0.4" />
      </g>
    </>
  );
}

function DefaultIcon(id: string): React.ReactElement {
  return (
    <>
      <defs>
        <linearGradient id={`${id}-bg`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#64748b" />
          <stop offset="100%" stopColor="#475569" />
        </linearGradient>
        <filter id={`${id}-glow`}>
          <feGaussianBlur stdDeviation="1.2" result="blur" />
          <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
      </defs>
      <circle cx="16" cy="16" r="14" fill={`url(#${id}-bg)`} />
      <g filter={`url(#${id}-glow)`} stroke="#e2e8f0" strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round">
        {/* diamond / cube shape */}
        <polygon points="16,5 27,16 16,27 5,16" />
        <line x1="16" y1="5" x2="16" y2="27" strokeWidth="1" opacity="0.4" />
        <line x1="5" y1="16" x2="27" y2="16" strokeWidth="1" opacity="0.4" />
        {/* inner diamond */}
        <polygon points="16,10 22,16 16,22 10,16" strokeWidth="1" opacity="0.5" />
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

export function PixelAvatar({ role, size = 32, className = "" }: PixelAvatarProps) {
  const renderer = (role && ROLE_RENDERERS[role]) || DefaultIcon;
  const uniqueId = `avatar-${role || "default"}-${idCounter++}`;

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
