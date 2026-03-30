import type { Request, Response, NextFunction } from "express";
import { findAgentByKey, validateAdminKey } from "./auth.js";

// ── Auth Mode ───────────────────────────────────────────────────

export type AuthMode = "off" | "warn" | "enforce";

export function getAuthMode(): AuthMode {
  const mode = process.env.SWARM_AUTH_MODE || "off";
  if (mode === "warn" || mode === "enforce") return mode;
  return "off";
}

// ── Augmented Request ───────────────────────────────────────────

export interface AuthInfo {
  id: string;       // agent ID or "__admin__"
  isAdmin: boolean;
}

declare global {
  namespace Express {
    interface Request {
      authAgent?: AuthInfo;
    }
  }
}

// ── Token Extraction ────────────────────────────────────────────

function extractBearerToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return null;
  return header.slice(7);
}

// ── Middleware ───────────────────────────────────────────────────

/**
 * Authenticate: extract Bearer token, resolve to agent or admin.
 * Always runs — sets req.authAgent if valid token present.
 * Does NOT reject — downstream guards decide based on auth mode.
 */
export function authenticate(req: Request, _res: Response, next: NextFunction): void {
  const token = extractBearerToken(req);
  if (!token) {
    next();
    return;
  }

  // Check admin key first
  if (validateAdminKey(token)) {
    req.authAgent = { id: "__admin__", isAdmin: true };
    next();
    return;
  }

  // Check agent key
  const agentId = findAgentByKey(token);
  if (agentId) {
    req.authAgent = { id: agentId, isAdmin: false };
  }

  next();
}

/**
 * Require any valid authentication (agent or admin).
 * Behavior depends on SWARM_AUTH_MODE.
 */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const mode = getAuthMode();
  if (mode === "off") { next(); return; }

  if (req.authAgent) { next(); return; }

  if (mode === "warn") {
    console.warn(`[auth:warn] Unauthenticated request: ${req.method} ${req.path}`);
    next();
    return;
  }

  // enforce
  res.status(401).json({ error: "Authentication required. Provide Authorization: Bearer <apiKey>" });
}

/**
 * Require admin authentication.
 */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const mode = getAuthMode();
  if (mode === "off") { next(); return; }

  if (req.authAgent?.isAdmin) { next(); return; }

  if (mode === "warn") {
    console.warn(`[auth:warn] Non-admin request to admin endpoint: ${req.method} ${req.path}`);
    next();
    return;
  }

  if (!req.authAgent) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  res.status(403).json({ error: "Admin access required" });
}

/**
 * Require that the authenticated agent matches the :paramName route param, or is admin.
 */
export function requireSelfOrAdmin(paramName: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const mode = getAuthMode();
    if (mode === "off") { next(); return; }

    if (req.authAgent?.isAdmin) { next(); return; }
    if (req.authAgent && req.authAgent.id === req.params[paramName]) { next(); return; }

    if (mode === "warn") {
      console.warn(`[auth:warn] Agent ${req.authAgent?.id ?? "unknown"} accessing ${req.params[paramName]}'s resource: ${req.method} ${req.path}`);
      next();
      return;
    }

    if (!req.authAgent) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    res.status(403).json({ error: "You can only access your own resources" });
  };
}

/**
 * Require that req.body.from matches the authenticated agent's ID (anti-spoofing).
 */
export function requireSenderMatch(req: Request, res: Response, next: NextFunction): void {
  const mode = getAuthMode();
  if (mode === "off") { next(); return; }

  // Admin can send on behalf of anyone
  if (req.authAgent?.isAdmin) { next(); return; }

  if (req.authAgent && req.body?.from === req.authAgent.id) { next(); return; }

  if (mode === "warn") {
    console.warn(`[auth:warn] Sender mismatch: auth=${req.authAgent?.id ?? "none"}, from=${req.body?.from}`);
    next();
    return;
  }

  if (!req.authAgent) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  res.status(403).json({ error: `Sender mismatch: authenticated as "${req.authAgent.id}" but from="${req.body?.from}"` });
}
