/**
 * Modern SVG icon avatars for each agent role.
 * Linear/Notion-inspired minimal flat design with gradients and glow effects.
 * Each icon uses abstract geometric symbols to represent the role.
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
        <linearGradient id={`${id}-bg`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#4f46e5" />
          <stop offset="100%" stopColor="#7c3aed" />
        </linearGradient>
        <filter id={`${id}-glow`}>
          <feGaussianBlur stdDeviation="1.5" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      <rect width="32" height="32" rx="8" fill={`url(#${id}-bg)`} />
      <g stroke="#fff" strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round" opacity="0.9">
        <path d="M10 9 L7 12 L7 16 L5.5 17 L7 18 L7 22 L10 25" />
        <path d="M22 9 L25 12 L25 16 L26.5 17 L25 18 L25 22 L22 25" />
      </g>
      <g filter={`url(#${id}-glow)`}>
        <path d="M14 10.5 L12.5 17 L15.5 16 L14 23.5" stroke="#fbbf24" strokeWidth="2.2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      </g>
    </>
  );
}

function Tester(id: string): React.ReactElement {
  return (
    <>
      <defs>
        <linearGradient id={`${id}-bg`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#059669" />
          <stop offset="100%" stopColor="#10b981" />
        </linearGradient>
        <filter id={`${id}-glow`}>
          <feGaussianBlur stdDeviation="1.2" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      <rect width="32" height="32" rx="8" fill={`url(#${id}-bg)`} />
      <g stroke="#fff" strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round" opacity="0.85">
        <circle cx="13" cy="13" r="6" />
        <line x1="17.5" y1="17.5" x2="25" y2="25" strokeWidth="2.4" />
      </g>
      <g filter={`url(#${id}-glow)`}>
        <polyline points="10,13.5 12.5,16 16.5,11" stroke="#bbf7d0" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      </g>
    </>
  );
}

function CodeReviewer(id: string): React.ReactElement {
  return (
    <>
      <defs>
        <linearGradient id={`${id}-bg`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#7c3aed" />
          <stop offset="100%" stopColor="#a855f7" />
        </linearGradient>
        <radialGradient id={`${id}-iris`} cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#c4b5fd" />
          <stop offset="100%" stopColor="#7c3aed" />
        </radialGradient>
        <filter id={`${id}-glow`}>
          <feGaussianBlur stdDeviation="1" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      <rect width="32" height="32" rx="8" fill={`url(#${id}-bg)`} />
      <g stroke="#fff" strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round" opacity="0.9">
        <path d="M4.5 16 Q16 8 27.5 16 Q16 24 4.5 16 Z" />
      </g>
      <g filter={`url(#${id}-glow)`}>
        <circle cx="16" cy="16" r="3.5" fill="rgba(255,255,255,0.95)" stroke="none" />
        <circle cx="16" cy="16" r="2" fill={`url(#${id}-iris)`} stroke="none" />
        <circle cx="15" cy="15" r="0.7" fill="#fff" stroke="none" />
      </g>
      <g stroke="#fff" strokeWidth="1" fill="none" opacity="0.35">
        <line x1="7" y1="25" x2="14" y2="25" />
        <line x1="16" y1="25" x2="25" y2="25" />
        <line x1="9" y1="27.5" x2="20" y2="27.5" />
      </g>
    </>
  );
}

function Architect(id: string): React.ReactElement {
  return (
    <>
      <defs>
        <linearGradient id={`${id}-bg`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#d97706" />
          <stop offset="100%" stopColor="#f59e0b" />
        </linearGradient>
        <linearGradient id={`${id}-tri`} x1="0.5" y1="0" x2="0.5" y2="1">
          <stop offset="0%" stopColor="rgba(255,255,255,0.95)" />
          <stop offset="100%" stopColor="rgba(255,255,255,0.5)" />
        </linearGradient>
        <filter id={`${id}-glow`}>
          <feGaussianBlur stdDeviation="1" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      <rect width="32" height="32" rx="8" fill={`url(#${id}-bg)`} />
      <g filter={`url(#${id}-glow)`}>
        <polygon points="16,5 27,26 5,26" stroke={`url(#${id}-tri)`} strokeWidth="1.8" fill="none" strokeLinejoin="round" />
      </g>
      <g stroke="#fff" strokeWidth="0.8" fill="none" opacity="0.3">
        <line x1="10.5" y1="15.5" x2="21.5" y2="15.5" />
        <line x1="8" y1="20.5" x2="24" y2="20.5" />
        <line x1="16" y1="5" x2="16" y2="26" />
      </g>
      <circle cx="16" cy="15.5" r="1.5" fill="rgba(255,255,255,0.7)" stroke="none" />
    </>
  );
}

function SecurityReviewer(id: string): React.ReactElement {
  return (
    <>
      <defs>
        <linearGradient id={`${id}-bg`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#dc2626" />
          <stop offset="100%" stopColor="#ef4444" />
        </linearGradient>
        <linearGradient id={`${id}-shield`} x1="0.5" y1="0" x2="0.5" y2="1">
          <stop offset="0%" stopColor="rgba(255,255,255,0.95)" />
          <stop offset="100%" stopColor="rgba(255,255,255,0.6)" />
        </linearGradient>
        <filter id={`${id}-glow`}>
          <feGaussianBlur stdDeviation="1.2" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      <rect width="32" height="32" rx="8" fill={`url(#${id}-bg)`} />
      <g filter={`url(#${id}-glow)`}>
        <path d="M16 4 L25 8.5 L25 15.5 Q25 23.5 16 27.5 Q7 23.5 7 15.5 L7 8.5 Z" stroke={`url(#${id}-shield)`} strokeWidth="1.8" fill="none" strokeLinejoin="round" />
      </g>
      <g>
        <rect x="13" y="15" width="6" height="5.5" rx="1.2" fill="rgba(255,255,255,0.9)" stroke="none" />
        <path d="M14 15 L14 13 Q14 10.5 16 10.5 Q18 10.5 18 13 L18 15" stroke="#fff" strokeWidth="1.6" fill="none" strokeLinecap="round" />
        <circle cx="16" cy="17.5" r="0.9" fill="#dc2626" stroke="none" />
        <line x1="16" y1="17.5" x2="16" y2="19" stroke="#dc2626" strokeWidth="0.8" strokeLinecap="round" />
      </g>
    </>
  );
}

function Researcher(id: string): React.ReactElement {
  return (
    <>
      <defs>
        <linearGradient id={`${id}-bg`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#4338ca" />
          <stop offset="100%" stopColor="#6366f1" />
        </linearGradient>
        <filter id={`${id}-glow`}>
          <feGaussianBlur stdDeviation="1.5" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      <rect width="32" height="32" rx="8" fill={`url(#${id}-bg)`} />
      <g stroke="#fff" strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round" opacity="0.85">
        <circle cx="12" cy="14" r="5" />
        <line x1="12" y1="19" x2="12" y2="27" strokeWidth="2" />
        <line x1="9" y1="23" x2="15" y2="23" strokeWidth="1.5" />
      </g>
      <g filter={`url(#${id}-glow)`}>
        <circle cx="21" cy="7" r="1.5" fill="#fbbf24" stroke="none" />
        <circle cx="25" cy="11" r="1" fill="#fbbf24" stroke="none" opacity="0.7" />
        <circle cx="18" cy="5" r="0.8" fill="#fbbf24" stroke="none" opacity="0.5" />
        <circle cx="27" cy="7" r="0.6" fill="#fbbf24" stroke="none" opacity="0.4" />
      </g>
    </>
  );
}

function DevOps(id: string): React.ReactElement {
  return (
    <>
      <defs>
        <linearGradient id={`${id}-bg`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#ea580c" />
          <stop offset="100%" stopColor="#f97316" />
        </linearGradient>
        <filter id={`${id}-glow`}>
          <feGaussianBlur stdDeviation="1" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      <rect width="32" height="32" rx="8" fill={`url(#${id}-bg)`} />
      <g filter={`url(#${id}-glow)`}>
        <circle cx="16" cy="16" r="4.5" stroke="#fff" strokeWidth="1.8" fill="none" />
        <g stroke="#fff" strokeWidth="1.4" fill="none">
          <line x1="16" y1="10" x2="16" y2="7" />
          <line x1="16" y1="22" x2="16" y2="25" />
          <line x1="10" y1="16" x2="7" y2="16" />
          <line x1="22" y1="16" x2="25" y2="16" />
          <line x1="11.8" y1="11.8" x2="9.7" y2="9.7" />
          <line x1="20.2" y1="20.2" x2="22.3" y2="22.3" />
        </g>
      </g>
      <g stroke="#fff" strokeWidth="1.5" fill="none" strokeLinecap="round" opacity="0.7">
        <path d="M5.5 10 A12 12 0 0 1 22 5.5" />
        <polyline points="20,4 22,5.5 20.5,7.5" strokeWidth="1.3" />
        <path d="M26.5 22 A12 12 0 0 1 10 26.5" />
        <polyline points="11.5,25 10,26.5 11.5,28" strokeWidth="1.3" />
      </g>
    </>
  );
}

function Designer(id: string): React.ReactElement {
  return (
    <>
      <defs>
        <linearGradient id={`${id}-bg`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#db2777" />
          <stop offset="100%" stopColor="#ec4899" />
        </linearGradient>
        <filter id={`${id}-glow`}>
          <feGaussianBlur stdDeviation="1" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      <rect width="32" height="32" rx="8" fill={`url(#${id}-bg)`} />
      <g stroke="#fff" strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round" opacity="0.85">
        <path d="M10 26 L13 14 L19 14 L22 26 Z" />
        <path d="M14.5 14 L16 7 L17.5 14" strokeWidth="1.6" />
        <line x1="16" y1="14" x2="16" y2="22" strokeWidth="0.8" opacity="0.35" />
      </g>
      <g filter={`url(#${id}-glow)`}>
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
      <defs>
        <linearGradient id={`${id}-bg`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#0d9488" />
          <stop offset="100%" stopColor="#14b8a6" />
        </linearGradient>
        <filter id={`${id}-glow`}>
          <feGaussianBlur stdDeviation="1.2" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      <rect width="32" height="32" rx="8" fill={`url(#${id}-bg)`} />
      <g filter={`url(#${id}-glow)`}>
        <path d="M16 4 Q23 4 23 11 Q23 18 16 24 Q9 18 9 11 Q9 4 16 4 Z" stroke="#fff" strokeWidth="1.8" fill="none" strokeLinejoin="round" />
        <circle cx="16" cy="11" r="3" fill="rgba(255,255,255,0.9)" stroke="none" />
      </g>
      <g stroke="#fff" strokeWidth="1" fill="none" opacity="0.5" strokeLinecap="round">
        <circle cx="6.5" cy="21" r="1.3" fill="rgba(255,255,255,0.5)" stroke="none" />
        <circle cx="9.5" cy="27" r="1" fill="rgba(255,255,255,0.3)" stroke="none" />
        <circle cx="25.5" cy="21" r="1.3" fill="rgba(255,255,255,0.5)" stroke="none" />
        <circle cx="22.5" cy="27" r="1" fill="rgba(255,255,255,0.3)" stroke="none" />
        <path d="M6.5 21 Q8 25 9.5 27" />
        <path d="M22.5 27 Q24 25 25.5 21" />
      </g>
    </>
  );
}

function DefaultIcon(id: string): React.ReactElement {
  return (
    <>
      <defs>
        <linearGradient id={`${id}-bg`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#475569" />
          <stop offset="100%" stopColor="#64748b" />
        </linearGradient>
        <linearGradient id={`${id}-dia`} x1="0.5" y1="0" x2="0.5" y2="1">
          <stop offset="0%" stopColor="rgba(255,255,255,0.9)" />
          <stop offset="100%" stopColor="rgba(255,255,255,0.4)" />
        </linearGradient>
        <filter id={`${id}-glow`}>
          <feGaussianBlur stdDeviation="1.2" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      <rect width="32" height="32" rx="8" fill={`url(#${id}-bg)`} />
      <g filter={`url(#${id}-glow)`}>
        <polygon points="16,4 28,16 16,28 4,16" stroke={`url(#${id}-dia)`} strokeWidth="1.8" fill="none" strokeLinejoin="round" />
      </g>
      <g stroke="#fff" strokeWidth="0.8" fill="none" opacity="0.3">
        <line x1="16" y1="4" x2="16" y2="28" />
        <line x1="4" y1="16" x2="28" y2="16" />
      </g>
      <polygon points="16,10 22,16 16,22 10,16" stroke="#fff" strokeWidth="1" fill="none" opacity="0.4" strokeLinejoin="round" />
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
