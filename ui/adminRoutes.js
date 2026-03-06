// ui/adminRoutes.js
// =========================
// Admin API Routes (SQLite-backed)
// Authentication, User Management, Role-Based Access
// Roles: operator (default), admin
// =========================

import express from "express";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { v4 as uuidv4 } from "uuid";
import Database from "better-sqlite3";
import path from "path";
import fsSync from "fs";
import nodemailer from "nodemailer";
import QRCode from "qrcode";
import { authenticator } from "otplib";

const router = express.Router();

// =========================
// Configuration
// =========================
const JWT_SECRET = process.env.JWT_SECRET || "nerc-cip-secret-change-in-production";
const JWT_EXPIRES_IN = "2h";
const BCRYPT_ROUNDS = 12;
const MAX_LOGIN_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000;

// Email / MFA config
const SMTP_HOST = process.env.SMTP_HOST || "";
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_SECURE = String(process.env.SMTP_SECURE || "false").toLowerCase() === "true";
const SMTP_USER = process.env.SMTP_USER || "";
const SMTP_PASS = process.env.SMTP_PASS || "";
const SMTP_FROM = process.env.SMTP_FROM || SMTP_USER || "no-reply@localhost";
const MFA_ISSUER = process.env.MFA_ISSUER || "NERC-CIP AI Agent";

authenticator.options = {
  window: 1,
};

// =========================
// SQLite DB
// =========================
const DATA_DIR = path.join(process.cwd(), "data");
if (!fsSync.existsSync(DATA_DIR)) fsSync.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, "auth.sqlite");
const db = new Database(DB_PATH);

db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'operator',
  status TEXT NOT NULL DEFAULT 'active',
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  last_login TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  timestamp TEXT NOT NULL,
  event TEXT NOT NULL,
  username TEXT,
  target TEXT,
  details TEXT,
  ip_address TEXT
);

CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_logs(timestamp);
`);

function ensureColumn(tableName, columnName, alterSql) {
  const cols = db.prepare(`PRAGMA table_info(${tableName})`).all();
  const exists = cols.some((c) => c.name === columnName);
  if (!exists) db.exec(alterSql);
}

ensureColumn("users", "mfa_enabled", `ALTER TABLE users ADD COLUMN mfa_enabled INTEGER NOT NULL DEFAULT 0`);
ensureColumn("users", "mfa_secret", `ALTER TABLE users ADD COLUMN mfa_secret TEXT`);
ensureColumn("users", "mfa_email", `ALTER TABLE users ADD COLUMN mfa_email TEXT`);
ensureColumn("users", "mfa_created_at", `ALTER TABLE users ADD COLUMN mfa_created_at TEXT`);

const stmtGetUserById = db.prepare(`SELECT * FROM users WHERE id = ?`);
const stmtGetUserByUsernameCI = db.prepare(
  `SELECT * FROM users WHERE LOWER(username) = LOWER(?) LIMIT 1`
);

const stmtInsertUser = db.prepare(`
  INSERT INTO users (
    id, username, password_hash, role, status, failed_attempts, locked_until,
    last_login, created_at, updated_at, mfa_enabled, mfa_secret, mfa_email, mfa_created_at
  )
  VALUES (
    @id, @username, @password_hash, @role, @status, @failed_attempts, @locked_until,
    @last_login, @created_at, @updated_at, @mfa_enabled, @mfa_secret, @mfa_email, @mfa_created_at
  )
`);

const stmtUpdateUserAuthFields = db.prepare(`
  UPDATE users
  SET password_hash = COALESCE(@password_hash, password_hash),
      role = COALESCE(@role, role),
      status = COALESCE(@status, status),
      failed_attempts = COALESCE(@failed_attempts, failed_attempts),
      locked_until = COALESCE(@locked_until, locked_until),
      last_login = COALESCE(@last_login, last_login),
      updated_at = @updated_at
  WHERE id = @id
`);

const stmtUpdateUserMfa = db.prepare(`
  UPDATE users
  SET mfa_enabled = @mfa_enabled,
      mfa_secret = @mfa_secret,
      mfa_email = @mfa_email,
      mfa_created_at = @mfa_created_at,
      updated_at = @updated_at
  WHERE id = @id
`);

const stmtDeleteUser = db.prepare(`DELETE FROM users WHERE id = ?`);

const stmtListUsers = db.prepare(`
  SELECT id, username, role, status, last_login, failed_attempts, created_at,
         mfa_enabled, mfa_email, mfa_created_at
  FROM users
  ORDER BY created_at DESC
`);

const stmtInsertAudit = db.prepare(`
  INSERT INTO audit_logs (id, timestamp, event, username, target, details, ip_address)
  VALUES (@id, @timestamp, @event, @username, @target, @details, @ip_address)
`);

const stmtListAudit = db.prepare(`
  SELECT id, timestamp, event, username, target, details, ip_address
  FROM audit_logs
  ORDER BY timestamp DESC
  LIMIT ?
`);

function ensureDefaultAdmin() {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM users WHERE role = 'admin'`).get();
  if ((row?.n || 0) > 0) return;

  const id = uuidv4();
  const now = new Date().toISOString();
  const passwordHash = bcrypt.hashSync("admin123", BCRYPT_ROUNDS);

  stmtInsertUser.run({
    id,
    username: "admin",
    password_hash: passwordHash,
    role: "admin",
    status: "active",
    failed_attempts: 0,
    locked_until: null,
    last_login: null,
    created_at: now,
    updated_at: now,
    mfa_enabled: 0,
    mfa_secret: null,
    mfa_email: null,
    mfa_created_at: null,
  });

  console.log("[auth] Seeded default admin user: admin / admin123 (change in production)");
}
ensureDefaultAdmin();

// =========================
// Role Permissions
// =========================
const ROLE_PERMISSIONS = {
  admin: [
    "chat:use",
    "docs:read",
    "docs:write",
    "docs:delete",
    "users:read",
    "users:write",
    "users:delete",
    "audit:read",
  ],
  operator: ["chat:use", "docs:read"],
};

function hasPermission(role, permission) {
  const perms = ROLE_PERMISSIONS[role] || [];
  return perms.includes(permission);
}

// =========================
// Audit Logging
// =========================
function logAudit(event, username, target, details, ipAddress) {
  const entry = {
    id: uuidv4(),
    timestamp: new Date().toISOString(),
    event,
    username: username || null,
    target: target || null,
    details: details || null,
    ip_address: ipAddress || null,
  };

  try {
    stmtInsertAudit.run(entry);
  } catch (e) {
    console.warn("[audit] insert failed:", e.message);
  }

  console.log(`[AUDIT] ${event}: ${username || "-"} -> ${target || "-"} | ${details || ""}`);
}

// =========================
// Email helper
// =========================
function getMailer() {
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    throw new Error("SMTP is not configured. Set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, and SMTP_FROM.");
  }

  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_SECURE,
    auth: {
      user: SMTP_USER,
      pass: SMTP_PASS,
    },
  });
}

 async function sendMfaQrEmail({ to, username, otpUri, secret }) {
  const transporter = getMailer();

  // Generate PNG buffer instead of data URL
  const qrBuffer = await QRCode.toBuffer(otpUri, {
    type: "png",
    width: 280,
    margin: 2,
  });

  await transporter.sendMail({
    from: SMTP_FROM,
    to,
    subject: `${MFA_ISSUER} MFA setup`,
    html: `
      <div style="font-family: Arial, sans-serif; line-height: 1.5;">
        <h2>${MFA_ISSUER} MFA Setup</h2>
        <p>Hello ${username},</p>
        <p>Scan the QR code below with your authenticator app.</p>
        <p>Supported free apps include Google Authenticator, Microsoft Authenticator, and FreeOTP.</p>

        <p><strong>MFA QR Code</strong></p>
        <p>
          <img src="cid:mfaqr" alt="MFA QR Code" width="280" height="280" style="display:block;border:1px solid #ddd;" />
        </p>

        <p>If scanning does not work, use this manual setup key:</p>
        <pre style="padding: 12px; background: #f4f4f4; border-radius: 6px;">${secret}</pre>

        <p>Or use this OTP URI in a compatible tool:</p>
        <pre style="padding: 12px; background: #f4f4f4; border-radius: 6px; white-space: pre-wrap;">${otpUri}</pre>
      </div>
    `,
    attachments: [
      {
        filename: "mfa-qr.png",
        content: qrBuffer,
        cid: "mfaqr",
        contentType: "image/png",
      },
    ],
  });
}

// =========================
// Authentication Middleware
// =========================
function authenticateToken(req, res, next) {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];

  if (!token) {
    return res.status(401).json({ ok: false, error: "Authentication required" });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = stmtGetUserById.get(decoded.userId);

    if (!user) {
      return res.status(401).json({ ok: false, error: "User not found" });
    }

    if (user.status !== "active") {
      return res.status(403).json({ ok: false, error: "Account is not active" });
    }

    req.user = {
      id: user.id,
      username: user.username,
      role: user.role,
    };

    next();
  } catch (e) {
    if (e.name === "TokenExpiredError") {
      return res.status(401).json({ ok: false, error: "Session expired" });
    }
    return res.status(401).json({ ok: false, error: "Invalid token" });
  }
}

function requirePermission(permission) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ ok: false, error: "Authentication required" });
    }

    if (!hasPermission(req.user.role, permission)) {
      logAudit("access_denied", req.user.username, permission, `Role: ${req.user.role}`, req.ip);
      return res.status(403).json({ ok: false, error: "Insufficient permissions" });
    }

    next();
  };
}

// =========================
// Password Validation
// =========================
function validatePassword(password) {
  const errors = [];
  if ((password || "").length < 8) errors.push("Password must be at least 8 characters");
  if (!/[A-Z]/.test(password)) errors.push("Password must contain an uppercase letter");
  if (!/[a-z]/.test(password)) errors.push("Password must contain a lowercase letter");
  if (!/[0-9]/.test(password)) errors.push("Password must contain a number");
  return errors;
}

// =========================
// Routes
// =========================

router.post("/register", async (req, res) => {
  const { username, password } = req.body;
  const ip = req.ip || req.connection?.remoteAddress || "unknown";

  if (!username || !password) {
    return res.status(400).json({ ok: false, error: "Username and password required" });
  }

  if (username.length < 3 || username.length > 50) {
    return res.status(400).json({ ok: false, error: "Username must be 3-50 characters" });
  }
  if (!/^[a-zA-Z0-9_]+$/.test(username)) {
    return res
      .status(400)
      .json({ ok: false, error: "Username can only contain letters, numbers, and underscores" });
  }

  const existing = stmtGetUserByUsernameCI.get(username);
  if (existing) {
    return res.status(400).json({ ok: false, error: "Username already exists" });
  }

  const passwordErrors = validatePassword(password);
  if (passwordErrors.length > 0) {
    return res.status(400).json({ ok: false, error: passwordErrors.join(". ") });
  }

  const id = uuidv4();
  const now = new Date().toISOString();
  const newUser = {
    id,
    username,
    password_hash: await bcrypt.hash(password, BCRYPT_ROUNDS),
    role: "operator",
    status: "active",
    failed_attempts: 0,
    locked_until: null,
    last_login: null,
    created_at: now,
    updated_at: now,
    mfa_enabled: 0,
    mfa_secret: null,
    mfa_email: null,
    mfa_created_at: null,
  };

  stmtInsertUser.run(newUser);
  logAudit("user_registered", username, null, "Self-registration as operator", ip);

  res.status(201).json({ ok: true, message: "Account created successfully" });
});

// Login with optional OTP
router.post("/login", async (req, res) => {
  const { username, password, otp } = req.body;
  const ip = req.ip || req.connection?.remoteAddress || "unknown";

  if (!username || !password) {
    return res.status(400).json({ ok: false, error: "Username and password required" });
  }

  const user = stmtGetUserByUsernameCI.get(username);
  if (!user) {
    logAudit("login_failed", username, null, "User not found", ip);
    return res.status(401).json({ ok: false, error: "Invalid credentials" });
  }

  if (user.locked_until && new Date(user.locked_until) > new Date()) {
    const remaining = Math.ceil((new Date(user.locked_until) - new Date()) / 60000);
    logAudit("login_blocked", username, null, `Account locked for ${remaining} more minutes`, ip);
    return res.status(403).json({ ok: false, error: `Account locked. Try again in ${remaining} minutes.` });
  }

  if (user.status !== "active") {
    logAudit("login_failed", username, null, `Account status: ${user.status}`, ip);
    return res.status(403).json({ ok: false, error: "Account is not active" });
  }

  const validPassword = await bcrypt.compare(password, user.password_hash);

  if (!validPassword) {
    const failedAttempts = (user.failed_attempts || 0) + 1;
    let lockedUntil = user.locked_until;
    let status = user.status;

    if (failedAttempts >= MAX_LOGIN_ATTEMPTS) {
      lockedUntil = new Date(Date.now() + LOCKOUT_DURATION_MS).toISOString();
      status = "locked";
      logAudit("account_locked", username, null, `Exceeded ${MAX_LOGIN_ATTEMPTS} failed attempts`, ip);
    }

    stmtUpdateUserAuthFields.run({
      id: user.id,
      failed_attempts: failedAttempts,
      locked_until: lockedUntil,
      status,
      updated_at: new Date().toISOString(),
      password_hash: null,
      role: null,
      last_login: null,
    });

    logAudit("login_failed", username, null, `Failed attempt ${failedAttempts}/${MAX_LOGIN_ATTEMPTS}`, ip);
    return res.status(401).json({ ok: false, error: "Invalid credentials" });
  }

  if (Number(user.mfa_enabled) === 1) {
    if (!otp || !/^\d{6}$/.test(String(otp))) {
      logAudit("login_failed", username, null, "Missing or invalid OTP format", ip);
      return res.status(401).json({ ok: false, error: "OTP code is required" });
    }

    const validOtp = authenticator.verify({
      token: String(otp),
      secret: user.mfa_secret || "",
    });

    if (!validOtp) {
      logAudit("login_failed", username, null, "Invalid OTP", ip);
      return res.status(401).json({ ok: false, error: "Invalid credentials" });
    }
  }

  const now = new Date().toISOString();
  stmtUpdateUserAuthFields.run({
    id: user.id,
    failed_attempts: 0,
    locked_until: null,
    status: "active",
    last_login: now,
    updated_at: now,
    password_hash: null,
    role: null,
  });

  const token = jwt.sign(
    { userId: user.id, username: user.username, role: user.role },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );

  logAudit("login", username, null, Number(user.mfa_enabled) === 1 ? "Successful login with MFA" : "Successful login", ip);

  res.json({
    ok: true,
    token,
    user: { id: user.id, username: user.username, role: user.role, mfaEnabled: Number(user.mfa_enabled) === 1 },
  });
});

// Get all users (admin only)
router.get("/users", authenticateToken, requirePermission("users:read"), (_req, res) => {
  const userList = stmtListUsers.all().map((u) => ({
    id: u.id,
    username: u.username,
    role: u.role,
    status: u.status,
    lastLogin: u.last_login,
    failedAttempts: u.failed_attempts,
    createdAt: u.created_at,
    mfaEnabled: Number(u.mfa_enabled) === 1,
    mfaEmail: u.mfa_email || "",
    mfaCreatedAt: u.mfa_created_at || null,
  }));
  res.json({ ok: true, users: userList });
});

// Get single user (admin only)
router.get("/users/:id", authenticateToken, requirePermission("users:read"), (req, res) => {
  const user = stmtGetUserById.get(req.params.id);
  if (!user) return res.status(404).json({ ok: false, error: "User not found" });

  res.json({
    ok: true,
    user: {
      id: user.id,
      username: user.username,
      role: user.role,
      status: user.status,
      lastLogin: user.last_login,
      failedAttempts: user.failed_attempts,
      createdAt: user.created_at,
      mfaEnabled: Number(user.mfa_enabled) === 1,
      mfaEmail: user.mfa_email || "",
      mfaCreatedAt: user.mfa_created_at || null,
    },
  });
});

// Create user (admin only)
router.post("/users", authenticateToken, requirePermission("users:write"), async (req, res) => {
  const { username, password, role = "operator", status = "active" } = req.body;
  const ip = req.ip || "unknown";

  if (!username || !password) {
    return res.status(400).json({ ok: false, error: "Username and password are required" });
  }

  if (username.length < 3 || username.length > 50) {
    return res.status(400).json({ ok: false, error: "Username must be 3-50 characters" });
  }

  const existing = stmtGetUserByUsernameCI.get(username);
  if (existing) return res.status(400).json({ ok: false, error: "Username already exists" });

  const passwordErrors = validatePassword(password);
  if (passwordErrors.length > 0) {
    return res.status(400).json({ ok: false, error: passwordErrors.join(". ") });
  }

  if (!["admin", "operator"].includes(role)) {
    return res.status(400).json({ ok: false, error: "Invalid role. Must be admin or operator." });
  }

  const id = uuidv4();
  const now = new Date().toISOString();

  stmtInsertUser.run({
    id,
    username,
    password_hash: await bcrypt.hash(password, BCRYPT_ROUNDS),
    role,
    status,
    failed_attempts: 0,
    locked_until: null,
    last_login: null,
    created_at: now,
    updated_at: now,
    mfa_enabled: 0,
    mfa_secret: null,
    mfa_email: null,
    mfa_created_at: null,
  });

  logAudit("user_created", req.user.username, username, `Role: ${role}`, ip);

  res.status(201).json({
    ok: true,
    user: { id, username, role, status, mfaEnabled: false },
  });
});

// Update user (admin only)
router.put("/users/:id", authenticateToken, requirePermission("users:write"), async (req, res) => {
  const user = stmtGetUserById.get(req.params.id);
  const ip = req.ip || "unknown";

  if (!user) return res.status(404).json({ ok: false, error: "User not found" });

  const { password, role, status } = req.body;
  const changes = [];

  let newPasswordHash = null;
  if (password) {
    const passwordErrors = validatePassword(password);
    if (passwordErrors.length > 0) {
      return res.status(400).json({ ok: false, error: passwordErrors.join(". ") });
    }
    newPasswordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    changes.push("password");
  }

  let newRole = null;
  if (role && role !== user.role) {
    if (!["admin", "operator"].includes(role)) {
      return res.status(400).json({ ok: false, error: "Invalid role. Must be admin or operator." });
    }
    newRole = role;
    changes.push(`role: ${user.role} -> ${role}`);
    logAudit("role_changed", req.user.username, user.username, `${user.role} -> ${role}`, ip);
  }

  let newStatus = null;
  if (status && status !== user.status) {
    newStatus = status;
    changes.push(`status: ${user.status} -> ${status}`);
  }

  let failedAttempts = null;
  let lockedUntil = null;
  if (newStatus === "active" && user.status === "locked") {
    failedAttempts = 0;
    lockedUntil = null;
  }

  stmtUpdateUserAuthFields.run({
    id: user.id,
    password_hash: newPasswordHash,
    role: newRole,
    status: newStatus,
    failed_attempts: failedAttempts,
    locked_until: lockedUntil,
    last_login: null,
    updated_at: new Date().toISOString(),
  });

  if (changes.length > 0) {
    logAudit("user_updated", req.user.username, user.username, changes.join(", "), ip);
  }

  const updated = stmtGetUserById.get(user.id);
  res.json({
    ok: true,
    user: {
      id: updated.id,
      username: updated.username,
      role: updated.role,
      status: updated.status,
      mfaEnabled: Number(updated.mfa_enabled) === 1,
      mfaEmail: updated.mfa_email || "",
    },
  });
});

// Setup MFA and email QR code
router.post("/users/:id/mfa/setup", authenticateToken, requirePermission("users:write"), async (req, res) => {
  const user = stmtGetUserById.get(req.params.id);
  const ip = req.ip || "unknown";
  const email = String(req.body?.email || "").trim();

  if (!user) return res.status(404).json({ ok: false, error: "User not found" });

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ ok: false, error: "Valid email is required" });
  }

  try {
    const secret = authenticator.generateSecret();
    const otpUri = authenticator.keyuri(user.username, MFA_ISSUER, secret);

    await sendMfaQrEmail({
      to: email,
      username: user.username,
      otpUri,
      secret,
    });

    const now = new Date().toISOString();
    stmtUpdateUserMfa.run({
      id: user.id,
      mfa_enabled: 1,
      mfa_secret: secret,
      mfa_email: email,
      mfa_created_at: now,
      updated_at: now,
    });

    logAudit("mfa_enabled", req.user.username, user.username, `MFA setup email sent to ${email}`, ip);

    return res.json({
      ok: true,
      message: `MFA setup email sent to ${email}`,
    });
  } catch (e) {
    console.error("MFA setup error:", e);
    return res.status(500).json({ ok: false, error: e.message || "Failed to set up MFA" });
  }
});

// Disable MFA
router.post("/users/:id/mfa/disable", authenticateToken, requirePermission("users:write"), (req, res) => {
  const user = stmtGetUserById.get(req.params.id);
  const ip = req.ip || "unknown";

  if (!user) return res.status(404).json({ ok: false, error: "User not found" });

  const now = new Date().toISOString();
  stmtUpdateUserMfa.run({
    id: user.id,
    mfa_enabled: 0,
    mfa_secret: null,
    mfa_email: null,
    mfa_created_at: null,
    updated_at: now,
  });

  logAudit("mfa_disabled", req.user.username, user.username, "MFA disabled", ip);

  return res.json({ ok: true, message: "MFA disabled" });
});

// Delete user (admin only)
router.delete("/users/:id", authenticateToken, requirePermission("users:delete"), (req, res) => {
  const user = stmtGetUserById.get(req.params.id);
  const ip = req.ip || "unknown";

  if (!user) return res.status(404).json({ ok: false, error: "User not found" });
  if (user.id === req.user.id) return res.status(400).json({ ok: false, error: "Cannot delete your own account" });

  stmtDeleteUser.run(user.id);
  logAudit("user_deleted", req.user.username, user.username, `Role was: ${user.role}`, ip);
  res.json({ ok: true, deleted: user.username });
});

// Get audit logs (admin only)
router.get("/audit", authenticateToken, requirePermission("audit:read"), (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  const logs = stmtListAudit.all(limit).map((log) => ({
    ...log,
    ipAddress: log.ip_address,
  }));
  res.json({ ok: true, logs });
});

export default router;
export { authenticateToken, requirePermission, logAudit, hasPermission };