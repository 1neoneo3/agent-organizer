/**
 * Modern SVG icon avatars for each agent role.
 * Linear/Notion-inspired minimal flat design with subtle gradients.
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
          <stop offset="0%" stopColor="#3b82f6" />
          <stop offset="100%" stopColor="#8b5cf6" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="8" fill={`url(#${id}-bg)`} />
      <g stroke="#fff" strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round" opacity="0.95">
        <path d="M9 11 L7 13.5 L7 16 L5.5 17 L7 18 L7 20.5 L9 23" />
        <path d="M23 11 L25 13.5 L25 16 L26.5 17 L25 18 L25 20.5 L23 23" />
        <path d="M17 10 L15 24" strokeWidth="1.4" opacity="0.5" />
        <path d="M14 12 L12.5 17.5 L15 17 L13.5 22" strokeWidth="2" stroke="#fbbf24" />
      </g>
    </>
  );
}

function Tester(id: string): React.ReactElement {
  return (
    <>
      <defs>
        <linearGradient id={`${id}-bg`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#10b981" />
          <stop offset="100%" stopColor="#059669" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="8" fill={`url(#${id}-bg)`} />
      <g stroke="#fff" strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round" opacity="0.95">
        <circle cx="14" cy="14" r="5.5" />
        <line x1="18.2" y1="18.2" x2="24" y2="24" strokeWidth="2.2" />
        <polyline points="11,14.5 13,16.5 17.5,12" strokeWidth="1.8" stroke="#bbf7d0" />
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
      </defs>
      <rect width="32" height="32" rx="8" fill={`url(#${id}-bg)`} />
      <g stroke="#fff" strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round" opacity="0.95">
        <path d="M5 16 Q16 9 27 16 Q16 23 5 16 Z" />
        <circle cx="16" cy="16" r="3.2" fill="rgba(255,255,255,0.9)" stroke="none" />
        <circle cx="16" cy="16" r="1.6" fill="#7c3aed" stroke="none" />
        <line x1="8" y1="25" x2="13" y2="25" strokeWidth="1.2" opacity="0.45" />
        <line x1="15" y1="25" x2="24" y2="25" strokeWidth="1.2" opacity="0.45" />
        <line x1="10" y1="27.5" x2="18" y2="27.5" strokeWidth="1.2" opacity="0.3" />
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
      </defs>
      <rect width="32" height="32" rx="8" fill={`url(#${id}-bg)`} />
      <g stroke="#fff" strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round" opacity="0.95">
        <polygon points="16,5 26,25 6,25" />
        <line x1="11" y1="15" x2="21" y2="15" strokeWidth="1" opacity="0.4" />
        <line x1="8.5" y1="20" x2="23.5" y2="20" strokeWidth="1" opacity="0.4" />
        <line x1="16" y1="5" x2="16" y2="25" strokeWidth="1" opacity="0.4" />
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
          <stop offset="100%" stopColor="#dc2626" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="8" fill={`url(#${id}-bg)`} />
      <g stroke="#fff" strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round" opacity="0.95">
        <path d="M16 4.5 L24.5 8.5 L24.5 15 Q24.5 23.5 16 27 Q7.5 23.5 7.5 15 L7.5 8.5 Z" />
        <rect x="13" y="15.5" width="6" height="5" rx="1" fill="rgba(255,255,255,0.85)" stroke="none" />
        <path d="M14.2 15.5 L14.2 13.5 Q14.2 11 16 11 Q17.8 11 17.8 13.5 L17.8 15.5" strokeWidth="1.5" />
        <circle cx="16" cy="18" r="0.8" fill="#dc2626" stroke="none" />
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
      </defs>
      <rect width="32" height="32" rx="8" fill={`url(#${id}-bg)`} />
      <g stroke="#fff" strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round" opacity="0.95">
        <circle cx="10" cy="10" r="4.5" />
        <line x1="13.5" y1="13.5" x2="22" y2="22" strokeWidth="2" />
        <line x1="22" y1="22" x2="24" y2="27" strokeWidth="1.5" />
        <line x1="22" y1="22" x2="27" y2="24" strokeWidth="1.5" />
        <circle cx="22" cy="8" r="1.2" fill="#fff" stroke="none" opacity="0.8" />
        <circle cx="26" cy="12" r="0.8" fill="#fff" stroke="none" opacity="0.5" />
        <circle cx="19" cy="5.5" r="0.6" fill="#fff" stroke="none" opacity="0.5" />
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
      </defs>
      <rect width="32" height="32" rx="8" fill={`url(#${id}-bg)`} />
      <g stroke="#fff" strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round" opacity="0.95">
        <circle cx="16" cy="16" r="4" />
        <circle cx="16" cy="16" r="7.5" strokeDasharray="3.5 2.5" />
        <path d="M16 5.5 A10.5 10.5 0 0 1 26.5 16" />
        <polyline points="24.5,13 26.5,16 23.5,16" strokeWidth="1.5" />
        <path d="M16 26.5 A10.5 10.5 0 0 1 5.5 16" />
        <polyline points="7.5,19 5.5,16 8.5,16" strokeWidth="1.5" />
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
      </defs>
      <rect width="32" height="32" rx="8" fill={`url(#${id}-bg)`} />
      <g stroke="#fff" strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round" opacity="0.95">
        <path d="M10 25 L13 14 L19 14 L22 25 Z" />
        <path d="M14.5 14 L16 7.5 L17.5 14" strokeWidth="1.5" />
        <line x1="16" y1="14" x2="16" y2="21" strokeWidth="1" opacity="0.4" />
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
      </defs>
      <rect width="32" height="32" rx="8" fill={`url(#${id}-bg)`} />
      <g stroke="#fff" strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round" opacity="0.95">
        <path d="M16 4.5 Q22.5 4.5 22.5 11 Q22.5 17 16 23.5 Q9.5 17 9.5 11 Q9.5 4.5 16 4.5 Z" />
        <circle cx="16" cy="11" r="2.8" fill="rgba(255,255,255,0.85)" stroke="none" />
        <circle cx="7" cy="21" r="1.2" fill="#fff" stroke="none" opacity="0.6" />
        <circle cx="10" cy="26" r="1" fill="#fff" stroke="none" opacity="0.4" />
        <circle cx="22" cy="26" r="1" fill="#fff" stroke="none" opacity="0.4" />
        <circle cx="25" cy="21" r="1.2" fill="#fff" stroke="none" opacity="0.6" />
        <path d="M7 21 Q10 24 10 26" strokeWidth="1" opacity="0.35" />
        <path d="M22 26 Q25 24 25 21" strokeWidth="1" opacity="0.35" />
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
      </defs>
      <rect width="32" height="32" rx="8" fill={`url(#${id}-bg)`} />
      <g stroke="#fff" strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round" opacity="0.95">
        <polygon points="16,4.5 27.5,16 16,27.5 4.5,16" />
        <line x1="16" y1="4.5" x2="16" y2="27.5" strokeWidth="1" opacity="0.35" />
        <line x1="4.5" y1="16" x2="27.5" y2="16" strokeWidth="1" opacity="0.35" />
        <polygon points="16,10 22,16 16,22 10,16" strokeWidth="1" opacity="0.45" />
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
