/**
 * Modern SVG icon avatars for each agent role.
 * Sleek rounded-rectangle cards with gradient backgrounds,
 * radial glow overlays, and subtle drop-shadow filtered icons.
 * viewBox 0 0 32 32
 */
import React from "react";

interface PixelAvatarProps {
  role: string | null;
  size?: number;
  className?: string;
}

type RoleRenderer = (id: string) => React.ReactElement;

function defs(
  id: string,
  c1: string,
  c2: string,
  glowColor: string,
  glowOpacity = 0.25,
): React.ReactElement {
  return (
    <defs>
      <linearGradient id={`${id}-bg`} x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stopColor={c1} />
        <stop offset="100%" stopColor={c2} />
      </linearGradient>
      <radialGradient id={`${id}-glow`} cx="50%" cy="38%" r="60%">
        <stop offset="0%" stopColor={glowColor} stopOpacity={glowOpacity} />
        <stop offset="100%" stopColor={c1} stopOpacity={0} />
      </radialGradient>
      <filter id={`${id}-f`}>
        <feGaussianBlur stdDeviation="0.7" result="b" />
        <feMerge>
          <feMergeNode in="b" />
          <feMergeNode in="SourceGraphic" />
        </feMerge>
      </filter>
    </defs>
  );
}

function bg(id: string): React.ReactElement {
  return (
    <>
      <rect x="1" y="1" width="30" height="30" rx="8" fill={`url(#${id}-bg)`} />
      <rect x="1" y="1" width="30" height="30" rx="8" fill={`url(#${id}-glow)`} />
    </>
  );
}

function LeadEngineer(id: string): React.ReactElement {
  return (
    <>
      {defs(id, "#4f8eff", "#7c5cfc", "#a5b4fc", 0.3)}
      {bg(id)}
      <g filter={`url(#${id}-f)`} stroke="#e0e7ff" strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round">
        <path d="M10.5 9 L8 11.5 L8 14 L6 16 L8 18 L8 20.5 L10.5 23" />
        <path d="M21.5 9 L24 11.5 L24 14 L26 16 L24 18 L24 20.5 L21.5 23" />
        <path d="M15.2 10 L13 16.5 L17 15 L14.8 22" strokeWidth="2" stroke="#fbbf24" />
      </g>
    </>
  );
}

function Tester(id: string): React.ReactElement {
  return (
    <>
      {defs(id, "#34d399", "#059669", "#a7f3d0", 0.28)}
      {bg(id)}
      <g filter={`url(#${id}-f)`} stroke="#d1fae5" strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="13.5" cy="13" r="5.5" />
        <line x1="17.8" y1="17.2" x2="24.5" y2="23.5" strokeWidth="2.2" />
        <polyline points="10.5,13 12.5,15.5 17,10.5" strokeWidth="1.8" stroke="#bbf7d0" />
      </g>
    </>
  );
}

function CodeReviewer(id: string): React.ReactElement {
  return (
    <>
      {defs(id, "#c084fc", "#7c3aed", "#e9d5ff", 0.22)}
      {bg(id)}
      <g filter={`url(#${id}-f)`} stroke="#ede9fe" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round">
        <path d="M5 14.5 Q16 7 27 14.5 Q16 22 5 14.5 Z" />
        <circle cx="16" cy="14.5" r="3" fill="#ede9fe" stroke="none" />
        <circle cx="16" cy="14.5" r="1.4" fill="#7c3aed" stroke="none" />
        <line x1="7.5" y1="23.5" x2="13.5" y2="23.5" strokeWidth="1.2" opacity="0.4" />
        <line x1="9.5" y1="26" x2="17.5" y2="26" strokeWidth="1.2" opacity="0.3" />
        <line x1="17.5" y1="23.5" x2="24.5" y2="23.5" strokeWidth="1.2" opacity="0.4" />
      </g>
    </>
  );
}

function Architect(id: string): React.ReactElement {
  return (
    <>
      {defs(id, "#fbbf24", "#d97706", "#fef3c7", 0.3)}
      {bg(id)}
      <g filter={`url(#${id}-f)`} stroke="#fef9c3" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round">
        <polygon points="16,5 5.5,25.5 26.5,25.5" />
        <line x1="10.8" y1="15.2" x2="21.2" y2="15.2" strokeWidth="0.9" opacity="0.5" />
        <line x1="8.2" y1="20.5" x2="23.8" y2="20.5" strokeWidth="0.9" opacity="0.5" />
        <line x1="16" y1="5" x2="16" y2="25.5" strokeWidth="0.9" opacity="0.35" />
        <circle cx="16" cy="15.2" r="1.4" fill="#fef9c3" fillOpacity={0.6} stroke="none" />
      </g>
    </>
  );
}

function SecurityReviewer(id: string): React.ReactElement {
  return (
    <>
      {defs(id, "#f87171", "#b91c1c", "#fecaca", 0.25)}
      {bg(id)}
      <g filter={`url(#${id}-f)`} stroke="#fee2e2" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round">
        <path d="M16 4 L25 8.5 L25 15.5 Q25 24 16 27.5 Q7 24 7 15.5 L7 8.5 Z" />
        <rect x="13" y="16" width="6" height="4.8" rx="1.2" fill="#fee2e2" stroke="none" />
        <path d="M14.2 16 L14.2 14 Q14.2 11 16 11 Q17.8 11 17.8 14 L17.8 16" strokeWidth="1.5" />
        <circle cx="16" cy="18" r="0.8" fill="#b91c1c" stroke="none" />
      </g>
    </>
  );
}

function Researcher(id: string): React.ReactElement {
  return (
    <>
      {defs(id, "#818cf8", "#4338ca", "#c7d2fe", 0.3)}
      {bg(id)}
      <g filter={`url(#${id}-f)`} stroke="#e0e7ff" strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="10" cy="10" r="4.5" />
        <line x1="13.5" y1="13.5" x2="22" y2="22" strokeWidth="2.2" />
        <line x1="22" y1="22" x2="24" y2="26.5" strokeWidth="1.4" />
        <line x1="22" y1="22" x2="26.5" y2="24" strokeWidth="1.4" />
        <circle cx="22" cy="7" r="1.2" fill="#e0e7ff" stroke="none" />
        <circle cx="26" cy="11" r="0.8" fill="#c7d2fe" stroke="none" />
        <circle cx="19" cy="5" r="0.6" fill="#c7d2fe" stroke="none" />
        <path d="M22 5.8 L22 8.2 M20.8 7 L23.2 7" strokeWidth="0.8" stroke="#e0e7ff" />
      </g>
    </>
  );
}

function DevOps(id: string): React.ReactElement {
  return (
    <>
      {defs(id, "#fb923c", "#dc2626", "#fed7aa", 0.22)}
      {bg(id)}
      <g filter={`url(#${id}-f)`} stroke="#ffedd5" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="16" cy="16" r="4" />
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
      {defs(id, "#f472b6", "#be185d", "#fbcfe8", 0.25)}
      {bg(id)}
      <g filter={`url(#${id}-f)`} stroke="#fce7f3" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round">
        <path d="M10.5 24.5 L13.5 13.5 L18.5 13.5 L21.5 24.5 Z" />
        <path d="M15 13.5 L16 7 L17 13.5" strokeWidth="1.4" />
        <line x1="16" y1="13.5" x2="16" y2="20" strokeWidth="0.8" opacity="0.4" />
        <circle cx="7.5" cy="9.5" r="2.2" fill="#fbbf24" stroke="none" opacity={0.9} />
        <circle cx="12" cy="6" r="2" fill="#60a5fa" stroke="none" opacity={0.9} />
        <circle cx="20" cy="6" r="2" fill="#34d399" stroke="none" opacity={0.9} />
        <circle cx="24.5" cy="9.5" r="2.2" fill="#fb7185" stroke="none" opacity={0.9} />
      </g>
    </>
  );
}

function Planner(id: string): React.ReactElement {
  return (
    <>
      {defs(id, "#2dd4bf", "#0d9488", "#99f6e4", 0.25)}
      {bg(id)}
      <g filter={`url(#${id}-f)`} stroke="#ccfbf1" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round">
        <path d="M16 4.5 Q23 4.5 23 11 Q23 17.5 16 23.5 Q9 17.5 9 11 Q9 4.5 16 4.5 Z" />
        <circle cx="16" cy="11" r="2.8" fill="#ccfbf1" stroke="none" />
        <circle cx="7" cy="20" r="1.2" fill="#ccfbf1" stroke="none" />
        <circle cx="10" cy="26" r="0.9" fill="#99f6e4" stroke="none" />
        <circle cx="22" cy="26" r="0.9" fill="#99f6e4" stroke="none" />
        <circle cx="25" cy="20" r="1.2" fill="#ccfbf1" stroke="none" />
        <path d="M7 20 Q8.5 23 10 26" strokeWidth="0.9" opacity="0.4" strokeDasharray="1.5 1.5" />
        <path d="M22 26 Q23.5 23 25 20" strokeWidth="0.9" opacity="0.4" strokeDasharray="1.5 1.5" />
      </g>
    </>
  );
}

function DefaultIcon(id: string): React.ReactElement {
  return (
    <>
      {defs(id, "#94a3b8", "#475569", "#e2e8f0", 0.2)}
      {bg(id)}
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
