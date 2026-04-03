/**
 * Modern SVG icon avatars for each agent role.
 * Premium flat vector design with layered gradients, soft shadows, and glow accents.
 * Each icon uses abstract symbols to represent the role.
 */
import React, { useId } from "react";

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
        <radialGradient id={`${id}-bg`} cx="30%" cy="30%" r="70%">
          <stop offset="0%" stopColor="#818cf8" />
          <stop offset="100%" stopColor="#4338ca" />
        </radialGradient>
        <filter id={`${id}-shadow`}>
          <feDropShadow dx="0" dy="1" stdDeviation="1.5" floodColor="#312e81" floodOpacity="0.4" />
        </filter>
        <filter id={`${id}-glow`}>
          <feGaussianBlur stdDeviation="1" result="blur" />
          <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
      </defs>
      <circle cx="16" cy="16" r="15" fill={`url(#${id}-bg)`} filter={`url(#${id}-shadow)`} />
      <circle cx="16" cy="16" r="15" fill="none" stroke="#a5b4fc" strokeWidth="0.5" opacity="0.4" />
      <g filter={`url(#${id}-glow)`} stroke="#e0e7ff" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round">
        <path d="M11 9 L8.5 11.5 L8.5 14.5 L6 16 L8.5 17.5 L8.5 20.5 L11 23" />
        <path d="M21 9 L23.5 11.5 L23.5 14.5 L26 16 L23.5 17.5 L23.5 20.5 L21 23" />
      </g>
      <path d="M16.5 10 L13.5 16.5 L16 16 L14 22" stroke="#fbbf24" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" fill="none" filter={`url(#${id}-glow)`} />
    </>
  );
}

function Tester(id: string): React.ReactElement {
  return (
    <>
      <defs>
        <radialGradient id={`${id}-bg`} cx="30%" cy="30%" r="70%">
          <stop offset="0%" stopColor="#4ade80" />
          <stop offset="100%" stopColor="#15803d" />
        </radialGradient>
        <filter id={`${id}-shadow`}>
          <feDropShadow dx="0" dy="1" stdDeviation="1.5" floodColor="#14532d" floodOpacity="0.4" />
        </filter>
        <filter id={`${id}-glow`}>
          <feGaussianBlur stdDeviation="0.8" result="blur" />
          <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
      </defs>
      <circle cx="16" cy="16" r="15" fill={`url(#${id}-bg)`} filter={`url(#${id}-shadow)`} />
      <circle cx="16" cy="16" r="15" fill="none" stroke="#86efac" strokeWidth="0.5" opacity="0.4" />
      <g filter={`url(#${id}-glow)`} stroke="#dcfce7" strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="14" cy="13.5" r="5.5" />
        <line x1="18.2" y1="17.7" x2="24" y2="23.5" strokeWidth="2.5" />
      </g>
      <polyline points="11,13.5 13.2,16 17.5,11.5" stroke="#bbf7d0" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none" filter={`url(#${id}-glow)`} />
    </>
  );
}

function CodeReviewer(id: string): React.ReactElement {
  return (
    <>
      <defs>
        <radialGradient id={`${id}-bg`} cx="30%" cy="30%" r="70%">
          <stop offset="0%" stopColor="#c084fc" />
          <stop offset="100%" stopColor="#6b21a8" />
        </radialGradient>
        <filter id={`${id}-shadow`}>
          <feDropShadow dx="0" dy="1" stdDeviation="1.5" floodColor="#581c87" floodOpacity="0.4" />
        </filter>
        <filter id={`${id}-glow`}>
          <feGaussianBlur stdDeviation="0.8" result="blur" />
          <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
      </defs>
      <circle cx="16" cy="16" r="15" fill={`url(#${id}-bg)`} filter={`url(#${id}-shadow)`} />
      <circle cx="16" cy="16" r="15" fill="none" stroke="#d8b4fe" strokeWidth="0.5" opacity="0.4" />
      <g filter={`url(#${id}-glow)`} stroke="#ede9fe" strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round">
        <path d="M5 15.5 Q10 9 16 15.5 Q22 9 27 15.5" />
        <path d="M5 15.5 Q10 22 16 15.5 Q22 22 27 15.5" />
      </g>
      <circle cx="16" cy="15.5" r="3.5" fill="#ede9fe" opacity="0.9" />
      <circle cx="16" cy="15.5" r="1.8" fill="#6b21a8" />
      <circle cx="17" cy="14.8" r="0.6" fill="#ede9fe" />
      <g stroke="#ede9fe" strokeWidth="1.4" strokeLinecap="round" opacity="0.5">
        <line x1="8" y1="24" x2="14" y2="24" />
        <line x1="10" y1="26.5" x2="18" y2="26.5" />
        <line x1="18" y1="24" x2="24" y2="24" />
      </g>
    </>
  );
}

function Architect(id: string): React.ReactElement {
  return (
    <>
      <defs>
        <radialGradient id={`${id}-bg`} cx="30%" cy="30%" r="70%">
          <stop offset="0%" stopColor="#fbbf24" />
          <stop offset="100%" stopColor="#b45309" />
        </radialGradient>
        <filter id={`${id}-shadow`}>
          <feDropShadow dx="0" dy="1" stdDeviation="1.5" floodColor="#78350f" floodOpacity="0.4" />
        </filter>
        <filter id={`${id}-glow`}>
          <feGaussianBlur stdDeviation="0.8" result="blur" />
          <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
      </defs>
      <circle cx="16" cy="16" r="15" fill={`url(#${id}-bg)`} filter={`url(#${id}-shadow)`} />
      <circle cx="16" cy="16" r="15" fill="none" stroke="#fde68a" strokeWidth="0.5" opacity="0.4" />
      <g filter={`url(#${id}-glow)`} stroke="#fef3c7" strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round">
        <polygon points="16,5 26,25 6,25" />
        <line x1="16" y1="5" x2="16" y2="25" strokeWidth="0.8" opacity="0.4" />
        <line x1="11" y1="15" x2="21" y2="15" strokeWidth="0.8" opacity="0.4" />
        <line x1="8.5" y1="20" x2="23.5" y2="20" strokeWidth="0.8" opacity="0.4" />
      </g>
      <circle cx="16" cy="17" r="2" fill="#fef3c7" opacity="0.6" />
    </>
  );
}

function SecurityReviewer(id: string): React.ReactElement {
  return (
    <>
      <defs>
        <radialGradient id={`${id}-bg`} cx="30%" cy="30%" r="70%">
          <stop offset="0%" stopColor="#f87171" />
          <stop offset="100%" stopColor="#991b1b" />
        </radialGradient>
        <filter id={`${id}-shadow`}>
          <feDropShadow dx="0" dy="1" stdDeviation="1.5" floodColor="#7f1d1d" floodOpacity="0.4" />
        </filter>
        <filter id={`${id}-glow`}>
          <feGaussianBlur stdDeviation="0.8" result="blur" />
          <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
      </defs>
      <circle cx="16" cy="16" r="15" fill={`url(#${id}-bg)`} filter={`url(#${id}-shadow)`} />
      <circle cx="16" cy="16" r="15" fill="none" stroke="#fca5a5" strokeWidth="0.5" opacity="0.4" />
      <g filter={`url(#${id}-glow)`} stroke="#fee2e2" strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round">
        <path d="M16 4 L25 8.5 L25 15 Q25 23 16 27 Q7 23 7 15 L7 8.5 Z" />
      </g>
      <rect x="12.5" y="15.5" width="7" height="5.5" rx="1.2" fill="#fee2e2" opacity="0.9" />
      <path d="M13.8 15.5 L13.8 13.5 Q13.8 10.5 16 10.5 Q18.2 10.5 18.2 13.5 L18.2 15.5" stroke="#fee2e2" strokeWidth="1.8" fill="none" strokeLinecap="round" />
      <circle cx="16" cy="18" r="1" fill="#991b1b" />
      <line x1="16" y1="19" x2="16" y2="20" stroke="#991b1b" strokeWidth="1" strokeLinecap="round" />
    </>
  );
}

function Researcher(id: string): React.ReactElement {
  return (
    <>
      <defs>
        <radialGradient id={`${id}-bg`} cx="30%" cy="30%" r="70%">
          <stop offset="0%" stopColor="#818cf8" />
          <stop offset="100%" stopColor="#3730a3" />
        </radialGradient>
        <filter id={`${id}-shadow`}>
          <feDropShadow dx="0" dy="1" stdDeviation="1.5" floodColor="#312e81" floodOpacity="0.4" />
        </filter>
        <filter id={`${id}-glow`}>
          <feGaussianBlur stdDeviation="1" result="blur" />
          <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
      </defs>
      <circle cx="16" cy="16" r="15" fill={`url(#${id}-bg)`} filter={`url(#${id}-shadow)`} />
      <circle cx="16" cy="16" r="15" fill="none" stroke="#a5b4fc" strokeWidth="0.5" opacity="0.4" />
      <g filter={`url(#${id}-glow)`} stroke="#e0e7ff" strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="11" cy="11" r="4.5" />
        <line x1="14.5" y1="14.5" x2="23" y2="23" strokeWidth="2.2" />
        <line x1="23" y1="23" x2="25" y2="27" strokeWidth="1.5" />
        <line x1="23" y1="23" x2="27" y2="25" strokeWidth="1.5" />
      </g>
      <g filter={`url(#${id}-glow)`}>
        <path d="M22 7 L22.8 9 L25 9 L23.2 10.2 L23.8 12.2 L22 11 L20.2 12.2 L20.8 10.2 L19 9 L21.2 9 Z" fill="#fde68a" stroke="none" />
        <circle cx="26" cy="13" r="0.8" fill="#c7d2fe" />
        <circle cx="19" cy="5.5" r="0.6" fill="#e0e7ff" />
      </g>
    </>
  );
}

function DevOps(id: string): React.ReactElement {
  return (
    <>
      <defs>
        <radialGradient id={`${id}-bg`} cx="30%" cy="30%" r="70%">
          <stop offset="0%" stopColor="#fb923c" />
          <stop offset="100%" stopColor="#c2410c" />
        </radialGradient>
        <filter id={`${id}-shadow`}>
          <feDropShadow dx="0" dy="1" stdDeviation="1.5" floodColor="#7c2d12" floodOpacity="0.4" />
        </filter>
        <filter id={`${id}-glow`}>
          <feGaussianBlur stdDeviation="0.8" result="blur" />
          <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
      </defs>
      <circle cx="16" cy="16" r="15" fill={`url(#${id}-bg)`} filter={`url(#${id}-shadow)`} />
      <circle cx="16" cy="16" r="15" fill="none" stroke="#fed7aa" strokeWidth="0.5" opacity="0.4" />
      <g filter={`url(#${id}-glow)`} stroke="#ffedd5" strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="16" cy="16" r="4" />
        <g strokeWidth="2">
          <line x1="16" y1="8" x2="16" y2="10.5" />
          <line x1="16" y1="21.5" x2="16" y2="24" />
          <line x1="8" y1="16" x2="10.5" y2="16" />
          <line x1="21.5" y1="16" x2="24" y2="16" />
          <line x1="10.3" y1="10.3" x2="12.1" y2="12.1" />
          <line x1="19.9" y1="19.9" x2="21.7" y2="21.7" />
          <line x1="10.3" y1="21.7" x2="12.1" y2="19.9" />
          <line x1="19.9" y1="12.1" x2="21.7" y2="10.3" />
        </g>
      </g>
      <g stroke="#ffedd5" strokeWidth="1.5" fill="none" strokeLinecap="round">
        <path d="M16 5 A11 11 0 0 1 27 16" />
        <polyline points="25.5,12.5 27,16 23.5,15.5" strokeWidth="1.3" />
        <path d="M16 27 A11 11 0 0 1 5 16" />
        <polyline points="6.5,19.5 5,16 8.5,16.5" strokeWidth="1.3" />
      </g>
    </>
  );
}

function Designer(id: string): React.ReactElement {
  return (
    <>
      <defs>
        <radialGradient id={`${id}-bg`} cx="30%" cy="30%" r="70%">
          <stop offset="0%" stopColor="#f472b6" />
          <stop offset="100%" stopColor="#be185d" />
        </radialGradient>
        <filter id={`${id}-shadow`}>
          <feDropShadow dx="0" dy="1" stdDeviation="1.5" floodColor="#831843" floodOpacity="0.4" />
        </filter>
        <filter id={`${id}-glow`}>
          <feGaussianBlur stdDeviation="0.8" result="blur" />
          <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
      </defs>
      <circle cx="16" cy="16" r="15" fill={`url(#${id}-bg)`} filter={`url(#${id}-shadow)`} />
      <circle cx="16" cy="16" r="15" fill="none" stroke="#fbcfe8" strokeWidth="0.5" opacity="0.4" />
      <g filter={`url(#${id}-glow)`} stroke="#fce7f3" strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 25 L14 14 L18 14 L20 25 Z" />
        <path d="M15 14 L16 7 L17 14" strokeWidth="1.5" />
        <circle cx="16" cy="6" r="1.2" fill="#fce7f3" stroke="none" />
        <line x1="16" y1="14" x2="16" y2="21" strokeWidth="0.8" opacity="0.4" />
      </g>
      <g>
        <circle cx="7" cy="10" r="2.2" fill="#fbbf24" opacity="0.85" />
        <circle cx="11" cy="6.5" r="2" fill="#60a5fa" opacity="0.85" />
        <circle cx="21" cy="6.5" r="2" fill="#34d399" opacity="0.85" />
        <circle cx="25" cy="10" r="2.2" fill="#f87171" opacity="0.85" />
      </g>
    </>
  );
}

function Planner(id: string): React.ReactElement {
  return (
    <>
      <defs>
        <radialGradient id={`${id}-bg`} cx="30%" cy="30%" r="70%">
          <stop offset="0%" stopColor="#2dd4bf" />
          <stop offset="100%" stopColor="#0f766e" />
        </radialGradient>
        <filter id={`${id}-shadow`}>
          <feDropShadow dx="0" dy="1" stdDeviation="1.5" floodColor="#134e4a" floodOpacity="0.4" />
        </filter>
        <filter id={`${id}-glow`}>
          <feGaussianBlur stdDeviation="0.8" result="blur" />
          <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
      </defs>
      <circle cx="16" cy="16" r="15" fill={`url(#${id}-bg)`} filter={`url(#${id}-shadow)`} />
      <circle cx="16" cy="16" r="15" fill="none" stroke="#5eead4" strokeWidth="0.5" opacity="0.4" />
      <g filter={`url(#${id}-glow)`} stroke="#ccfbf1" strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round">
        <path d="M16 4 Q23 4 23 11 Q23 18 16 24 Q9 18 9 11 Q9 4 16 4 Z" />
      </g>
      <circle cx="16" cy="11" r="3" fill="#ccfbf1" opacity="0.9" />
      <circle cx="16" cy="11" r="1.2" fill="#0f766e" />
      <g stroke="#ccfbf1" strokeWidth="1.2" strokeLinecap="round" opacity="0.5" strokeDasharray="1.5 2">
        <path d="M16 24 L10 27" />
        <path d="M16 24 L22 27" />
      </g>
      <circle cx="7" cy="22" r="1.2" fill="#ccfbf1" opacity="0.6" />
      <circle cx="25" cy="22" r="1.2" fill="#ccfbf1" opacity="0.6" />
      <circle cx="10" cy="27" r="0.9" fill="#99f6e4" opacity="0.5" />
      <circle cx="22" cy="27" r="0.9" fill="#99f6e4" opacity="0.5" />
    </>
  );
}

function DefaultIcon(id: string): React.ReactElement {
  return (
    <>
      <defs>
        <radialGradient id={`${id}-bg`} cx="30%" cy="30%" r="70%">
          <stop offset="0%" stopColor="#94a3b8" />
          <stop offset="100%" stopColor="#334155" />
        </radialGradient>
        <filter id={`${id}-shadow`}>
          <feDropShadow dx="0" dy="1" stdDeviation="1.5" floodColor="#1e293b" floodOpacity="0.4" />
        </filter>
        <filter id={`${id}-glow`}>
          <feGaussianBlur stdDeviation="0.8" result="blur" />
          <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
      </defs>
      <circle cx="16" cy="16" r="15" fill={`url(#${id}-bg)`} filter={`url(#${id}-shadow)`} />
      <circle cx="16" cy="16" r="15" fill="none" stroke="#cbd5e1" strokeWidth="0.5" opacity="0.4" />
      <g filter={`url(#${id}-glow)`} stroke="#e2e8f0" strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round">
        <polygon points="16,4 28,16 16,28 4,16" />
        <polygon points="16,9 23,16 16,23 9,16" strokeWidth="1" opacity="0.5" />
      </g>
      <circle cx="16" cy="16" r="2" fill="#e2e8f0" opacity="0.6" />
      <g stroke="#e2e8f0" strokeWidth="0.6" opacity="0.3">
        <line x1="16" y1="4" x2="16" y2="28" />
        <line x1="4" y1="16" x2="28" y2="16" />
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
      aria-label={role ? `${role} avatar` : "default avatar"}
    >
      {renderer(uniqueId)}
    </svg>
  );
}
