import bcrypt from "bcrypt";
import { db } from "../db.js";

const SALT_ROUNDS = 12;

function normalizeUsername(username) {
  return String(username || "").trim().toLowerCase();
}

export function createUser({ username, password, role = "student" }) {
  const normalized = normalizeUsername(username);
  if (!normalized) throw new Error("username required");
  if (!password || String(password).length < 8) throw new Error("password must be at least 8 characters");

  const passwordHash = bcrypt.hashSync(String(password), SALT_ROUNDS);

  const stmt = db.prepare(`
    INSERT INTO users (username, password_hash, role)
    VALUES (?, ?, ?)
  `);

  const info = stmt.run(normalized, passwordHash, role);
  return { id: info.lastInsertRowid, username: normalized, role };
}

export function findUserByUsername(username) {
  const normalized = normalizeUsername(username);
  return db.prepare(`SELECT * FROM users WHERE username = ?`).get(normalized);
}

export function verifyPassword(password, passwordHash) {
  return bcrypt.compareSync(String(password), String(passwordHash));
}

export function touchLastLogin(userId) {
  db.prepare(`UPDATE users SET last_login_at = datetime('now') WHERE id = ?`).run(userId);
}
