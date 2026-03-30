import crypto from "node:crypto";
import fs from "node:fs/promises";
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const DATA_DIR = process.env.SWARM_DATA_DIR || path.join(os.homedir(), ".swarm-channel");
const KEYS_FILE = path.join(DATA_DIR, "keys.json");
const ADMIN_KEY_FILE = path.join(DATA_DIR, "admin.key");

function ensureDir(): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

// ── Key Storage ─────────────────────────────────────────────────

// Forward: agentId → SHA-256 hash
// Reverse: hash → agentId (for O(1) lookup by key)
let keysByAgent = new Map<string, string>();
let agentByHash = new Map<string, string>();

function loadKeys(): void {
  try {
    const data = JSON.parse(readFileSync(KEYS_FILE, "utf-8"));
    keysByAgent = new Map(Object.entries(data));
    agentByHash = new Map();
    for (const [agentId, hash] of keysByAgent) {
      agentByHash.set(hash, agentId);
    }
  } catch {
    keysByAgent = new Map();
    agentByHash = new Map();
  }
}

async function saveKeys(): Promise<void> {
  ensureDir();
  const tmp = KEYS_FILE + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(Object.fromEntries(keysByAgent), null, 2), "utf-8");
  await fs.rename(tmp, KEYS_FILE);
}

loadKeys();

// ── Key Generation ──────────────────────────────────────────────

export function generateApiKey(): string {
  return `swarm_ak_${crypto.randomBytes(32).toString("hex")}`;
}

export function hashKey(rawKey: string): string {
  return crypto.createHash("sha256").update(rawKey).digest("hex");
}

// ── Key Management ──────────────────────────────────────────────

export async function storeKey(agentId: string, rawKey: string): Promise<void> {
  const hash = hashKey(rawKey);
  keysByAgent.set(agentId, hash);
  agentByHash.set(hash, agentId);
  await saveKeys();
}

export async function removeKey(agentId: string): Promise<void> {
  const hash = keysByAgent.get(agentId);
  if (hash) agentByHash.delete(hash);
  keysByAgent.delete(agentId);
  await saveKeys();
}

export async function remapKey(oldId: string, newId: string): Promise<void> {
  const hash = keysByAgent.get(oldId);
  if (hash) {
    keysByAgent.delete(oldId);
    keysByAgent.set(newId, hash);
    agentByHash.set(hash, newId);
    await saveKeys();
  }
}

export function validateKey(agentId: string, rawKey: string): boolean {
  const stored = keysByAgent.get(agentId);
  if (!stored) return false;
  const incoming = hashKey(rawKey);
  if (stored.length !== incoming.length) return false;
  return crypto.timingSafeEqual(Buffer.from(stored, "hex"), Buffer.from(incoming, "hex"));
}

export function hasKey(agentId: string): boolean {
  return keysByAgent.has(agentId);
}

/** O(1) lookup: find which agentId owns this key */
export function findAgentByKey(rawKey: string): string | null {
  const hash = hashKey(rawKey);
  return agentByHash.get(hash) ?? null;
}

// ── Admin Key ───────────────────────────────────────────────────

let adminKeyHash: string | null = null;

/** Initialize admin key. Returns raw key on first run (print once), null if already exists. */
export function initAdminKey(): string | null {
  ensureDir();

  if (existsSync(ADMIN_KEY_FILE)) {
    adminKeyHash = readFileSync(ADMIN_KEY_FILE, "utf-8").trim();
    return null;
  }

  // First start — generate and persist admin key hash
  const rawKey = `swarm_admin_${crypto.randomBytes(32).toString("hex")}`;
  adminKeyHash = hashKey(rawKey);
  const tmp = ADMIN_KEY_FILE + ".tmp";
  writeFileSync(tmp, adminKeyHash, "utf-8");
  renameSync(tmp, ADMIN_KEY_FILE);
  return rawKey;
}

export function validateAdminKey(rawKey: string): boolean {
  if (!adminKeyHash) return false;
  const incoming = hashKey(rawKey);
  if (adminKeyHash.length !== incoming.length) return false;
  return crypto.timingSafeEqual(Buffer.from(adminKeyHash, "hex"), Buffer.from(incoming, "hex"));
}

/** Rotate admin key. Returns new raw key (shown once). */
export function rotateAdminKey(): string {
  const rawKey = `swarm_admin_${crypto.randomBytes(32).toString("hex")}`;
  adminKeyHash = hashKey(rawKey);
  ensureDir();
  const tmp = ADMIN_KEY_FILE + ".tmp";
  writeFileSync(tmp, adminKeyHash, "utf-8");
  renameSync(tmp, ADMIN_KEY_FILE);
  return rawKey;
}
