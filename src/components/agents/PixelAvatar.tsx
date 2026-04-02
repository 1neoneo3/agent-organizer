/**
 * Modern SVG icon avatars for each agent role.
 * Sleek, minimal vector design with refined gradients and subtle glow.
 * viewBox 0 0 32 32 — each role represented by abstract symbols.
 */
import React from "react";

interface PixelAvatarProps {
  role: string | null;
  size?: number;
  className?: string;
}

type RoleRenderer = (id: string) => React.ReactElement;

function LeadEngineer(id: string): React.ReactElement {
  return (
    <>
      <defs>
        <linearGradient id={`${id}-bg`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#4f8eff" />
          <stop offset="100%" stopColor="#7c5cfc" />
        </linearGradient>
        <radialGradient id={`${id}-glow`} cx="50%" cy="40%" r="60%">
          <stop offset="0%" stopColor="#a5b4fc" stopOpacity="0.3" />
          <stop offset="100%" stopColor="#4f8eff" stopOpacity="0" />
        </radialGradient>
        <filter id={`${id}-f`}>
          <feGaussianBlur stdDeviation="0.8" result="b" />
          <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
      </defs>
      <rect x="1" y="1" width="30" height="30" rx="8" fill={`url(#${id}-bg)`} />
      <rect x="1" y="1" width="30" height="30" rx="8" fill={`url(#${id}-glow)`} />
      <g filter={`url(#${id}-f)`} stroke="#e0e7ff" strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round">
        <path d="M11 9.5 L8.5 12 L8.5 14.5 L6.5 16 L8.5 17.5 L8.5 20 L11 22.5" />
        <path d="M21 9.5 L23.5 12 L23.5 14.5 L25.5 16 L23.5 17.5 L23.5 20 L21 22.5" />
        <path d="M15.5 10.5 L13.5 16.5 L16.5 15.5 L14.5 21.5" strokeWidth="2" stroke="#fbbf24" />
      </g>
    </>
  );
}

function Tester(id: string): React.ReactElement {
  return (
    <>
      <defs>
        <linearGradient id={`${id}-bg`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#34d399" />
          <stop offset="100%" stopColor="#059669" />
        </linearGradient>
        <radialGradient id={`${id}-glow`} cx="40%" cy="40%" r="50%">
          <stop offset="0%" stopColor="#a7f3d0" stopOpacity="0.25" />
          <stop offset="100%" stopColor="#34d399" stopOpacity="0" />
        </radialGradient>
        <filter id={`${id}-f`}>
          <feGaussianBlur stdDeviation="0.8" result="b" />
          <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
      </defs>
      <rect x="1" y="1" width="30" height="30" rx="8" fill={`url(#${id}-bg)`} />
      <rect x="1" y="1" width="30" height="30" rx="8" fill={`url(#${id}-glow)`} />
      <g filter={`url(#${id}-f)`} stroke="#d1fae5" strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="14" cy="13.5" r="5.5" />
        <line x1="18.2" y1="17.7" x2="24" y2="23.5" strokeWidth="2.2" />
        <polyline points="11,13.5 13,15.8 17.5,11" strokeWidth="1.8" stroke="#bbf7d0" />
      </g>
    </>
  );
}

function CodeReviewer(id: string): React.ReactElement {
  return (
    <>
      <defs>
        <linearGradient id={`${id}-bg`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#c084fc" />
          <stop offset="100%" stopColor="#7c3aed" />
        </linearGradient>
        <radialGradient id={`${id}-glow`} cx="50%" cy="45%" r="50%">
          <stop offset="0%" stopColor="#e9d5ff" stopOpacity="0.2" />
          <stop offset="100%" stopColor="#c084fc" stopOpacity="0" />
        </radialGradient>
        <filter id={`${id}-f`}>
          <feGaussianBlur stdDeviation="0.8" result="b" />
          <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
      </defs>
      <rect x="1" y="1" width="30" height="30" rx="8" fill={`url(#${id}-bg)`} />
      <rect x="1" y="1" width="30" height="30" rx="8" fill={`url(#${id}-glow)`} />
      <g filter={`url(#${id}-f)`} stroke="#ede9fe" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round">
        <path d="M5.5 15 Q16 7 26.5 15 Q16 23 5.5 15 Z" />
        <circle cx="16" cy="15" r="3.2" fill="#ede9fe" stroke="none" />
        <circle cx="16" cy="15" r="1.6" fill="#7c3aed" stroke="none" />
        <line x1="8" y1="24" x2="14" y2="24" strokeWidth="1.2" opacity="0.45" />
        <line x1="10" y1="26.5" x2="18" y2="26.5" strokeWidth="1.2" opacity="0.3" />
        <line x1="18" y1="24" x2="24" y2="24" strokeWidth="1.2" opacity="0.45" />
      </g>
    </>
  );
}

function Architect(id: string): React.ReactElement {
  return (
    <>
      <defs>
        <linearGradient id={`${id}-bg`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#fbbf24" />
          <stop offset="100%" stopColor="#d97706" />
        </linearGradient>
        <radialGradient id={`${id}-glow`} cx="50%" cy="35%" r="55%">
          <stop offset="0%" stopColor="#fef3c7" stopOpacity="0.3" />
          <stop offset="100%" stopColor="#fbbf24" stopOpacity="0" />
        </radialGradient>
        <filter id={`${id}-f`}>
          <feGaussianBlur stdDeviation="0.8" result="b" />
          <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
      </defs>
      <rect x="1" y="1" width="30" height="30" rx="8" fill={`url(#${id}-bg)`} />
      <rect x="1" y="1" width="30" height="30" rx="8" fill={`url(#${id}-glow)`} />
      <g filter={`url(#${id}-f)`} stroke="#fef9c3" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round">
        <polygon points="16,5.5 6,25 26,25" />
        <line x1="11" y1="15.5" x2="21" y2="15.5" strokeWidth="0.9" opacity="0.5" />
        <line x1="8.5" y1="20.5" x2="23.5" y2="20.5" strokeWidth="0.9" opacity="0.5" />
        <line x1="16" y1="5.5" x2="16" y2="25" strokeWidth="0.9" opacity="0.4" />
        <circle cx="16" cy="15.5" r="1.5" fill="#fef9c3" fillOpacity="0.6" stroke="none" />
      </g>
    </>
  );
}

function SecurityReviewer(id: string): React.ReactElement {
  return (
    <>
      <defs>
        <linearGradient id={`${id}-bg`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#f87171" />
          <stop offset="100%" stopColor="#b91c1c" />
        </linearGradient>
        <radialGradient id={`${id}-glow`} cx="50%" cy="40%" r="55%">
          <stop offset="0%" stopColor="#fecaca" stopOpacity="0.25" />
          <stop offset="100%" stopColor="#f87171" stopOpacity="0" />
        </radialGradient>
        <filter id={`${id}-f`}>
          <feGaussianBlur stdDeviation="0.8" result="b" />
          <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
      </defs>
      <rect x="1" y="1" width="30" height="30" rx="8" fill={`url(#${id}-bg)`} />
      <rect x="1" y="1" width="30" height="30" rx="8" fill={`url(#${id}-glow)`} />
      <g filter={`url(#${id}-f)`} stroke="#fee2e2" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round">
        <path d="M16 4.5 L24.5 8.5 L24.5 15 Q24.5 23.5 16 27 Q7.5 23.5 7.5 15 L7.5 8.5 Z" />
        <rect x="13" y="15.5" width="6" height="5" rx="1.2" fill="#fee2e2" stroke="none" />
        <path d="M14.2 15.5 L14.2 13.5 Q14.2 10.8 16 10.8 Q17.8 10.8 17.8 13.5 L17.8 15.5" strokeWidth="1.5" />
        <circle cx="16" cy="18" r="0.9" fill="#b91c1c" stroke="none" />
      </g>
    </>
  );
}

function Researcher(id: string): React.ReactElement {
  return (
    <>
      <defs>
        <linearGradient id={`${id}-bg`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#818cf8" />
          <stop offset="100%" stopColor="#4338ca" />
        </linearGradient>
        <radialGradient id={`${id}-glow`} cx="35%" cy="35%" r="50%">
          <stop offset="0%" stopColor="#c7d2fe" stopOpacity="0.3" />
          <stop offset="100%" stopColor="#818cf8" stopOpacity="0" />
        </radialGradient>
        <filter id={`${id}-f`}>
          <feGaussianBlur stdDeviation="0.8" result="b" />
          <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
      </defs>
      <rect x="1" y="1" width="30" height="30" rx="8" fill={`url(#${id}-bg)`} />
      <rect x="1" y="1" width="30" height="30" rx="8" fill={`url(#${id}-glow)`} />
      <g filter={`url(#${id}-f)`} stroke="#e0e7ff" strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="10.5" cy="10.5" r="4.5" />
        <line x1="14" y1="14" x2="22" y2="22" strokeWidth="2.2" />
        <line x1="22" y1="22" x2="24" y2="26.5" strokeWidth="1.4" />
        <line x1="22" y1="22" x2="26.5" y2="24" strokeWidth="1.4" />
        <circle cx="22.5" cy="7.5" r="1.2" fill="#e0e7ff" stroke="none" />
        <circle cx="26" cy="11" r="0.8" fill="#c7d2fe" stroke="none" />
        <circle cx="19" cy="5.5" r="0.6" fill="#c7d2fe" stroke="none" />
        <path d="M22.5 6.3 L22.5 8.7 M21.3 7.5 L23.7 7.5" strokeWidth="0.8" stroke="#e0e7ff" />
      </g>
    </>
  );
}

function DevOps(id: string): React.ReactElement {
  return (
    <>
      <defs>
        <linearGradient id={`${id}-bg`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#fb923c" />
          <stop offset="100%" stopColor="#dc2626" />
        </linearGradient>
        <radialGradient id={`${id}-glow`} cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#fed7aa" stopOpacity="0.2" />
          <stop offset="100%" stopColor="#fb923c" stopOpacity="0" />
        </radialGradient>
        <filter id={`${id}-f`}>
          <feGaussianBlur stdDeviation="0.8" result="b" />
          <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
      </defs>
      <rect x="1" y="1" width="30" height="30" rx="8" fill={`url(#${id}-bg)`} />
      <rect x="1" y="1" width="30" height="30" rx="8" fill={`url(#${id}-glow)`} />
      <g filter={`url(#${id}-f)`} stroke="#ffedd5" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="16" cy="16" r="4.2" />
        <circle cx="16" cy="16" r="7.5" strokeDasharray="3.5 2.8" />
        <path d="M16 5.5 A10.5 10.5 0 0 1 26.5 16" />
        <polyline points="24.5,13 26.5,16 23.5,16.5" strokeWidth="1.4" />
        <path d="M16 26.5 A10.5 10.5 0 0 1 5.5 16" />
        <polyline points="7.5,19 5.5,16 8.5,15.5" strokeWidth="1.4" />
      </g>
    </>
  );
}

function Designer(id: string): React.ReactElement {
  return (
    <>
      <defs>
        <linearGradient id={`${id}-bg`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#f472b6" />
          <stop offset="100%" stopColor="#be185d" />
        </linearGradient>
        <radialGradient id={`${id}-glow`} cx="50%" cy="40%" r="55%">
          <stop offset="0%" stopColor="#fbcfe8" stopOpacity="0.25" />
          <stop offset="100%" stopColor="#f472b6" stopOpacity="0" />
        </radialGradient>
        <filter id={`${id}-f`}>
          <feGaussianBlur stdDeviation="0.8" result="b" />
          <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
      </defs>
      <rect x="1" y="1" width="30" height="30" rx="8" fill={`url(#${id}-bg)`} />
      <rect x="1" y="1" width="30" height="30" rx="8" fill={`url(#${id}-glow)`} />
      <g filter={`url(#${id}-f)`} stroke="#fce7f3" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round">
        <path d="M10.5 24.5 L13.5 13.5 L18.5 13.5 L21.5 24.5 Z" />
        <path d="M15 13.5 L16 7.5 L17 13.5" strokeWidth="1.4" />
        <line x1="16" y1="13.5" x2="16" y2="20" strokeWidth="0.8" opacity="0.4" />
        <circle cx="7.5" cy="10" r="2.2" fill="#fbbf24" stroke="none" opacity="0.9" />
        <circle cx="12" cy="6.5" r="2" fill="#60a5fa" stroke="none" opacity="0.9" />
        <circle cx="20" cy="6.5" r="2" fill="#34d399" stroke="none" opacity="0.9" />
        <circle cx="24.5" cy="10" r="2.2" fill="#fb7185" stroke="none" opacity="0.9" />
      </g>
    </>
  );
}

function Planner(id: string): React.ReactElement {
  return (
    <>
      <defs>
        <linearGradient id={`${id}-bg`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#2dd4bf" />
          <stop offset="100%" stopColor="#0d9488" />
        </linearGradient>
        <radialGradient id={`${id}-glow`} cx="50%" cy="40%" r="55%">
          <stop offset="0%" stopColor="#99f6e4" stopOpacity="0.25" />
          <stop offset="100%" stopColor="#2dd4bf" stopOpacity="0" />
        </radialGradient>
        <filter id={`${id}-f`}>
          <feGaussianBlur stdDeviation="0.8" result="b" />
          <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
      </defs>
      <rect x="1" y="1" width="30" height="30" rx="8" fill={`url(#${id}-bg)`} />
      <rect x="1" y="1" width="30" height="30" rx="8" fill={`url(#${id}-glow)`} />
      <g filter={`url(#${id}-f)`} stroke="#ccfbf1" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round">
        <path d="M16 4.5 Q22.5 4.5 22.5 11 Q22.5 17 16 23 Q9.5 17 9.5 11 Q9.5 4.5 16 4.5 Z" />
        <circle cx="16" cy="11" r="2.8" fill="#ccfbf1" stroke="none" />
        <circle cx="7" cy="20" r="1.2" fill="#ccfbf1" stroke="none" />
        <circle cx="10" cy="25.5" r="0.9" fill="#99f6e4" stroke="none" />
        <circle cx="22" cy="25.5" r="0.9" fill="#99f6e4" stroke="none" />
        <circle cx="25" cy="20" r="1.2" fill="#ccfbf1" stroke="none" />
        <path d="M7 20 Q8.5 23 10 25.5" strokeWidth="0.9" opacity="0.4" strokeDasharray="1.5 1.5" />
        <path d="M22 25.5 Q23.5 23 25 20" strokeWidth="0.9" opacity="0.4" strokeDasharray="1.5 1.5" />
      </g>
    </>
  );
}

function DefaultIcon(id: string): React.ReactElement {
  return (
    <>
      <defs>
        <linearGradient id={`${id}-bg`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#94a3b8" />
          <stop offset="100%" stopColor="#475569" />
        </linearGradient>
        <radialGradient id={`${id}-glow`} cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#e2e8f0" stopOpacity="0.2" />
          <stop offset="100%" stopColor="#94a3b8" stopOpacity="0" />
        </radialGradient>
        <filter id={`${id}-f`}>
          <feGaussianBlur stdDeviation="0.8" result="b" />
          <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
      </defs>
      <rect x="1" y="1" width="30" height="30" rx="8" fill={`url(#${id}-bg)`} />
      <rect x="1" y="1" width="30" height="30" rx="8" fill={`url(#${id}-glow)`} />
      <g filter={`url(#${id}-f)`} stroke="#e2e8f0" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round">
        <polygon points="16,5 27,16 16,27 5,16" />
        <line x1="16" y1="5" x2="16" y2="27" strokeWidth="0.8" opacity="0.35" />
        <line x1="5" y1="16" x2="27" y2="16" strokeWidth="0.8" opacity="0.35" />
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
