import { createHash, timingSafeEqual, randomBytes } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { SESSION_AUTH_TOKEN } from "../config/runtime.js";

const SESSION_COOKIE_NAME = "ao_session";

const CSRF_TOKEN = createHash("sha256")
  .update(`csrf:${SESSION_AUTH_TOKEN}`, "utf8")
  .digest("hex");

export function getCsrfToken(): string {
  return CSRF_TOKEN;
}

function safeSecretEquals(input: string, expected: string): boolean {
  const a = Buffer.from(input, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function cookieToken(req: Request): string | undefined {
  const raw = req.headers.cookie ?? "";
  const match = raw.match(new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`));
  return match ? decodeURIComponent(match[1]) : undefined;
}

function bearerToken(req: Request): string | undefined {
  const auth = req.headers.authorization ?? "";
  if (auth.startsWith("Bearer ")) return auth.slice(7);
  return undefined;
}

export function isAuthenticated(req: Request): boolean {
  const bearer = bearerToken(req);
  if (bearer && safeSecretEquals(bearer, SESSION_AUTH_TOKEN)) return true;
  const cookie = cookieToken(req);
  if (cookie && safeSecretEquals(cookie, SESSION_AUTH_TOKEN)) return true;
  return false;
}

export function issueSessionCookie(req: Request, res: Response): void {
  if (cookieToken(req) === SESSION_AUTH_TOKEN) return;
  const parts = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(SESSION_AUTH_TOKEN)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
  ];
  res.append("Set-Cookie", parts.join("; "));
}

function csrfTokenFromRequest(req: Request): string | undefined {
  return (req.headers["x-csrf-token"] as string) ?? undefined;
}

function shouldRequireCsrf(req: Request): boolean {
  const method = (req.method ?? "GET").toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return false;
  return !bearerToken(req);
}

function hasValidCsrfToken(req: Request): boolean {
  const token = csrfTokenFromRequest(req);
  if (!token) return false;
  return safeSecretEquals(token, CSRF_TOKEN);
}

const PUBLIC_PATHS = new Set(["/health", "/auth/session"]);

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (PUBLIC_PATHS.has(req.path)) {
    next();
    return;
  }

  if (!isAuthenticated(req)) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  if (shouldRequireCsrf(req) && !hasValidCsrfToken(req)) {
    res.status(403).json({ error: "invalid_csrf" });
    return;
  }

  next();
}
