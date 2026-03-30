import Database from "better-sqlite3";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import type { Task, TaskMessage, TaskArtifact, TaskDetail, TaskStatus, Edge, EdgeType, EdgePermissions, ConnectionRequest } from "./types.js";
import { logger } from "./logger.js";

// ── Database Setup ──────────────────────────────────────────────

const DATA_DIR = process.env.SWARM_DATA_DIR || path.join(os.homedir(), ".swarm-channel");
const DB_PATH = path.join(DATA_DIR, "swarm.db");

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// ── Schema ──────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    context_id TEXT,
    from_agent TEXT NOT NULL,
    to_agent TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'submitted',
    title TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT,
    ttl_seconds INTEGER DEFAULT 604800,
    retry_count INTEGER DEFAULT 0,
    metadata TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_tasks_to_agent ON tasks(to_agent);
  CREATE INDEX IF NOT EXISTS idx_tasks_from_agent ON tasks(from_agent);
  CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
  CREATE INDEX IF NOT EXISTS idx_tasks_context_id ON tasks(context_id);

  CREATE TABLE IF NOT EXISTS task_messages (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_task_messages_task_id ON task_messages(task_id);

  CREATE TABLE IF NOT EXISTS task_artifacts (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    mime_type TEXT DEFAULT 'text/plain',
    data TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_task_artifacts_task_id ON task_artifacts(task_id);

  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    target TEXT,
    details TEXT,
    ip TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_log(timestamp);
  CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log(actor);

  CREATE TABLE IF NOT EXISTS edges (
    id TEXT PRIMARY KEY,
    from_agent TEXT NOT NULL,
    to_agent TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'peer',
    permissions TEXT,
    created_at TEXT NOT NULL,
    created_by TEXT NOT NULL,
    UNIQUE(from_agent, to_agent)
  );

  CREATE INDEX IF NOT EXISTS idx_edges_from ON edges(from_agent);
  CREATE INDEX IF NOT EXISTS idx_edges_to ON edges(to_agent);
  CREATE INDEX IF NOT EXISTS idx_edges_type ON edges(type);

  CREATE TABLE IF NOT EXISTS connection_requests (
    id TEXT PRIMARY KEY,
    from_agent TEXT NOT NULL,
    to_agent TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'peer',
    reason TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL,
    responded_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_connreq_from ON connection_requests(from_agent);
  CREATE INDEX IF NOT EXISTS idx_connreq_to ON connection_requests(to_agent);
  CREATE INDEX IF NOT EXISTS idx_connreq_status ON connection_requests(status);
`);

// ── Row → Object Mappers ────────────────────────────────────────

function rowToTask(row: any): Task {
  return {
    id: row.id,
    contextId: row.context_id,
    fromAgent: row.from_agent,
    toAgent: row.to_agent,
    status: row.status as TaskStatus,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    ttlSeconds: row.ttl_seconds,
    retryCount: row.retry_count,
    metadata: row.metadata ? JSON.parse(row.metadata) : null,
  };
}

function rowToMessage(row: any): TaskMessage {
  return {
    id: row.id,
    taskId: row.task_id,
    role: row.role,
    agentId: row.agent_id,
    content: row.content,
    createdAt: row.created_at,
  };
}

function rowToArtifact(row: any): TaskArtifact {
  return {
    id: row.id,
    taskId: row.task_id,
    name: row.name,
    mimeType: row.mime_type,
    data: row.data,
    createdAt: row.created_at,
  };
}

// ── Prepared Statements ─────────────────────────────────────────

const stmts = {
  insertTask: db.prepare(`
    INSERT INTO tasks (id, context_id, from_agent, to_agent, status, title, created_at, updated_at, ttl_seconds, metadata)
    VALUES (?, ?, ?, ?, 'submitted', ?, ?, ?, ?, ?)
  `),

  getTask: db.prepare(`SELECT * FROM tasks WHERE id = ?`),

  updateStatus: db.prepare(`
    UPDATE tasks SET status = ?, updated_at = ?, completed_at = CASE WHEN ? IN ('completed','failed','canceled') THEN ? ELSE completed_at END
    WHERE id = ?
  `),

  incrementRetry: db.prepare(`UPDATE tasks SET retry_count = retry_count + 1, updated_at = ? WHERE id = ?`),

  deleteTask: db.prepare(`DELETE FROM tasks WHERE id = ?`),

  insertMessage: db.prepare(`
    INSERT INTO task_messages (id, task_id, role, agent_id, content, created_at) VALUES (?, ?, ?, ?, ?, ?)
  `),

  getMessages: db.prepare(`SELECT * FROM task_messages WHERE task_id = ? ORDER BY created_at ASC`),

  insertArtifact: db.prepare(`
    INSERT INTO task_artifacts (id, task_id, name, mime_type, data, created_at) VALUES (?, ?, ?, ?, ?, ?)
  `),

  getArtifacts: db.prepare(`SELECT * FROM task_artifacts WHERE task_id = ? ORDER BY created_at ASC`),

  pendingForAgent: db.prepare(`SELECT * FROM tasks WHERE to_agent = ? AND status = 'submitted' ORDER BY created_at ASC`),

  cleanupExpired: db.prepare(`
    DELETE FROM tasks WHERE status IN ('completed','failed','canceled')
      AND updated_at < datetime('now', '-' || ttl_seconds || ' seconds')
  `),
};

// ── CRUD Functions ──────────────────────────────────────────────

export function createTask(opts: {
  fromAgent: string;
  toAgent: string;
  title?: string;
  contextId?: string;
  ttlSeconds?: number;
  metadata?: Record<string, unknown>;
}): Task {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  stmts.insertTask.run(
    id,
    opts.contextId ?? null,
    opts.fromAgent,
    opts.toAgent,
    opts.title ?? null,
    now,
    now,
    opts.ttlSeconds ?? 604800,
    opts.metadata ? JSON.stringify(opts.metadata) : null,
  );

  return getTask(id)!;
}

export function getTask(id: string): Task | null {
  const row = stmts.getTask.get(id);
  return row ? rowToTask(row) : null;
}

export function getTaskDetail(id: string): TaskDetail | null {
  const task = getTask(id);
  if (!task) return null;
  return {
    ...task,
    messages: getTaskMessages(id),
    artifacts: getTaskArtifacts(id),
  };
}

export function updateTaskStatus(id: string, status: TaskStatus): Task | null {
  const now = new Date().toISOString();
  stmts.updateStatus.run(status, now, status, now, id);
  return getTask(id);
}

export function incrementRetryCount(id: string): void {
  stmts.incrementRetry.run(new Date().toISOString(), id);
}

export function deleteTask(id: string): boolean {
  const result = stmts.deleteTask.run(id);
  return result.changes > 0;
}

// ── Messages ────────────────────────────────────────────────────

export function addTaskMessage(opts: {
  taskId: string;
  role: "sender" | "receiver";
  agentId: string;
  content: string;
}): TaskMessage {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  stmts.insertMessage.run(id, opts.taskId, opts.role, opts.agentId, opts.content, now);

  // Touch task updated_at
  db.prepare(`UPDATE tasks SET updated_at = ? WHERE id = ?`).run(now, opts.taskId);

  return { id, taskId: opts.taskId, role: opts.role, agentId: opts.agentId, content: opts.content, createdAt: now };
}

export function getTaskMessages(taskId: string): TaskMessage[] {
  return stmts.getMessages.all(taskId).map(rowToMessage);
}

// ── Artifacts ───────────────────────────────────────────────────

export function addTaskArtifact(opts: {
  taskId: string;
  name: string;
  mimeType?: string;
  data: string;
}): TaskArtifact {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  stmts.insertArtifact.run(id, opts.taskId, opts.name, opts.mimeType ?? "text/plain", opts.data, now);

  db.prepare(`UPDATE tasks SET updated_at = ? WHERE id = ?`).run(now, opts.taskId);

  return { id, taskId: opts.taskId, name: opts.name, mimeType: opts.mimeType ?? "text/plain", data: opts.data, createdAt: now };
}

export function getTaskArtifacts(taskId: string): TaskArtifact[] {
  return stmts.getArtifacts.all(taskId).map(rowToArtifact);
}

// ── Queries ─────────────────────────────────────────────────────

export function listTasks(filters: {
  toAgent?: string;
  fromAgent?: string;
  status?: TaskStatus;
  contextId?: string;
}): Task[] {
  const conditions: string[] = [];
  const params: any[] = [];

  if (filters.toAgent) { conditions.push("to_agent = ?"); params.push(filters.toAgent); }
  if (filters.fromAgent) { conditions.push("from_agent = ?"); params.push(filters.fromAgent); }
  if (filters.status) { conditions.push("status = ?"); params.push(filters.status); }
  if (filters.contextId) { conditions.push("context_id = ?"); params.push(filters.contextId); }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = db.prepare(`SELECT * FROM tasks ${where} ORDER BY created_at DESC LIMIT 100`).all(...params);
  return rows.map(rowToTask);
}

export function getPendingTasksForAgent(agentId: string): Task[] {
  return stmts.pendingForAgent.all(agentId).map(rowToTask);
}

// ── Cleanup ─────────────────────────────────────────────────────

export function cleanupExpiredTasks(): number {
  const result = stmts.cleanupExpired.run();
  return result.changes;
}

// Run cleanup every hour
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
let cleanupTimer: ReturnType<typeof setInterval> | null = null;

export function startCleanupTimer(): void {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(() => {
    const deleted = cleanupExpiredTasks();
    if (deleted > 0) logger.info({ event: "tasks_cleanup", deleted });
  }, CLEANUP_INTERVAL_MS);
}

export function stopCleanupTimer(): void {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}

/** Task metrics for /metrics endpoint */
export function getTaskMetrics(): { total: number; byStatus: Record<string, number> } {
  const rows = db.prepare(`SELECT status, COUNT(*) as count FROM tasks GROUP BY status`).all() as { status: string; count: number }[];
  const byStatus: Record<string, number> = {};
  let total = 0;
  for (const row of rows) {
    byStatus[row.status] = row.count;
    total += row.count;
  }
  return { total, byStatus };
}

// ── Edges (SQLite-backed) ───────────────────────────────────────

const edgeStmts = {
  insert: db.prepare(`INSERT OR IGNORE INTO edges (id, from_agent, to_agent, type, permissions, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)`),
  remove: db.prepare(`DELETE FROM edges WHERE (from_agent = ? AND to_agent = ?) OR (from_agent = ? AND to_agent = ?)`),
  getAll: db.prepare(`SELECT * FROM edges`),
  getByType: db.prepare(`SELECT * FROM edges WHERE type = ?`),
  getForAgent: db.prepare(`SELECT * FROM edges WHERE from_agent = ? OR to_agent = ?`),
  exists: db.prepare(`SELECT 1 FROM edges WHERE (from_agent = ? AND to_agent = ?) OR (from_agent = ? AND to_agent = ?)`),
  removeForAgent: db.prepare(`DELETE FROM edges WHERE from_agent = ? OR to_agent = ?`),
};

function rowToEdge(row: any): Edge {
  return {
    id: row.id,
    fromAgent: row.from_agent,
    toAgent: row.to_agent,
    type: row.type as EdgeType,
    permissions: row.permissions ? JSON.parse(row.permissions) : null,
    createdAt: row.created_at,
    createdBy: row.created_by,
  };
}

export function dbAddEdge(from: string, to: string, type: EdgeType = "peer", permissions?: EdgePermissions, createdBy: string = "__admin__"): Edge | null {
  const existing = edgeStmts.exists.get(from, to, to, from);
  if (existing) return null;
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  edgeStmts.insert.run(id, from, to, type, permissions ? JSON.stringify(permissions) : null, now, createdBy);
  return { id, fromAgent: from, toAgent: to, type, permissions: permissions ?? null, createdAt: now, createdBy };
}

export function dbRemoveEdge(from: string, to: string): boolean {
  const result = edgeStmts.remove.run(from, to, to, from);
  return result.changes > 0;
}

export function dbRemoveEdgesForAgent(agentId: string): number {
  const result = edgeStmts.removeForAgent.run(agentId, agentId);
  return result.changes;
}

export function dbGetEdges(typeFilter?: EdgeType): Edge[] {
  const rows = typeFilter ? edgeStmts.getByType.all(typeFilter) : edgeStmts.getAll.all();
  return rows.map(rowToEdge);
}

export function dbGetEdgesForAgent(agentId: string): Edge[] {
  return edgeStmts.getForAgent.all(agentId, agentId).map(rowToEdge);
}

/** Load all edges for adjacency cache rebuild */
export function dbLoadAllEdgePairs(): [string, string][] {
  const rows = edgeStmts.getAll.all() as any[];
  return rows.map((r) => [r.from_agent, r.to_agent]);
}

// ── Connection Requests ─────────────────────────────────────────

const connReqStmts = {
  insert: db.prepare(`INSERT INTO connection_requests (id, from_agent, to_agent, type, reason, status, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)`),
  get: db.prepare(`SELECT * FROM connection_requests WHERE id = ?`),
  updateStatus: db.prepare(`UPDATE connection_requests SET status = ?, responded_at = ? WHERE id = ?`),
  pending: db.prepare(`SELECT * FROM connection_requests WHERE (from_agent = ? OR to_agent = ?) AND status = 'pending' ORDER BY created_at DESC`),
  expireOld: db.prepare(`UPDATE connection_requests SET status = 'expired' WHERE status = 'pending' AND created_at < datetime('now', '-7 days')`),
};

function rowToConnReq(row: any): ConnectionRequest {
  return {
    id: row.id,
    fromAgent: row.from_agent,
    toAgent: row.to_agent,
    type: row.type as EdgeType,
    reason: row.reason,
    status: row.status,
    createdAt: row.created_at,
    respondedAt: row.responded_at,
  };
}

export function createConnectionRequest(from: string, to: string, type: EdgeType = "peer", reason?: string): ConnectionRequest {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  connReqStmts.insert.run(id, from, to, type, reason ?? null, now);
  return { id, fromAgent: from, toAgent: to, type, reason: reason ?? null, status: "pending", createdAt: now, respondedAt: null };
}

export function getConnectionRequest(id: string): ConnectionRequest | null {
  const row = connReqStmts.get.get(id);
  return row ? rowToConnReq(row) : null;
}

export function respondConnectionRequest(id: string, status: "accepted" | "declined"): ConnectionRequest | null {
  const now = new Date().toISOString();
  connReqStmts.updateStatus.run(status, now, id);
  return getConnectionRequest(id);
}

export function getPendingRequests(agentId: string): ConnectionRequest[] {
  return connReqStmts.pending.all(agentId, agentId).map(rowToConnReq);
}

export function expireOldRequests(): number {
  const result = connReqStmts.expireOld.run();
  return result.changes;
}

// ── Audit Log ───────────────────────────────────────────────────

const insertAuditStmt = db.prepare(`
  INSERT INTO audit_log (timestamp, actor, action, target, details, ip) VALUES (?, ?, ?, ?, ?, ?)
`);

export function logAudit(actor: string, action: string, target?: string, details?: Record<string, unknown>, ip?: string): void {
  insertAuditStmt.run(new Date().toISOString(), actor, action, target ?? null, details ? JSON.stringify(details) : null, ip ?? null);
}

export interface AuditEntry {
  id: number;
  timestamp: string;
  actor: string;
  action: string;
  target: string | null;
  details: Record<string, unknown> | null;
  ip: string | null;
}

export function queryAuditLog(opts: { after?: string; actor?: string; action?: string; limit?: number }): AuditEntry[] {
  const conditions: string[] = [];
  const params: any[] = [];
  if (opts.after) { conditions.push("timestamp > ?"); params.push(opts.after); }
  if (opts.actor) { conditions.push("actor = ?"); params.push(opts.actor); }
  if (opts.action) { conditions.push("action = ?"); params.push(opts.action); }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = Math.min(opts.limit ?? 100, 1000);
  const rows = db.prepare(`SELECT * FROM audit_log ${where} ORDER BY id DESC LIMIT ?`).all(...params, limit) as any[];
  return rows.map((r) => ({
    id: r.id,
    timestamp: r.timestamp,
    actor: r.actor,
    action: r.action,
    target: r.target,
    details: r.details ? JSON.parse(r.details) : null,
    ip: r.ip,
  }));
}

// ── DB Integrity ────────────────────────────────────────────────

export function checkDbIntegrity(): string {
  const result = db.pragma("integrity_check") as { integrity_check: string }[];
  return result[0]?.integrity_check ?? "unknown";
}

export function backupDb(): void {
  try {
    const backupPath = DB_PATH + ".backup";
    db.backup(backupPath);
    logger.info({ event: "db_backup", path: backupPath });
  } catch (err) {
    logger.error({ err }, "Database backup failed");
  }
}

/** Check database health */
export function checkDbHealth(): boolean {
  try {
    db.prepare("SELECT 1").get();
    return true;
  } catch {
    return false;
  }
}

/** Close database (for graceful shutdown) */
export function closeDb(): void {
  stopCleanupTimer();
  db.close();
}
