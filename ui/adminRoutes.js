// =========================
// Admin API Routes
// Authentication, User Management, Role-Based Access
// Roles: operator (default), admin
// =========================

import express from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';

const router = express.Router();

// =========================
// Configuration
// =========================
const JWT_SECRET = process.env.JWT_SECRET || 'nerc-cip-secret-change-in-production';
const JWT_EXPIRES_IN = '2h'; // Session timeout
const BCRYPT_ROUNDS = 12;
const MAX_LOGIN_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 minutes

// =========================
// In-Memory Database (replace with real DB in production)
// =========================
const users = new Map();
const auditLogs = [];

// Initialize with default admin user
const defaultAdminId = uuidv4();
users.set(defaultAdminId, {
  id: defaultAdminId,
  username: 'admin',
  passwordHash: bcrypt.hashSync('admin123', BCRYPT_ROUNDS),
  role: 'admin',
  status: 'active',
  failedAttempts: 0,
  lockedUntil: null,
  lastLogin: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString()
});

// =========================
// Role Permissions
// =========================
const ROLE_PERMISSIONS = {
  admin: ['chat:use', 'docs:read', 'docs:write', 'docs:delete', 'users:read', 'users:write', 'users:delete', 'audit:read'],
  operator: ['chat:use', 'docs:read']
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
    username,
    target,
    details,
    ipAddress
  };
  auditLogs.unshift(entry);
  
  if (auditLogs.length > 1000) {
    auditLogs.pop();
  }
  
  console.log(`[AUDIT] ${event}: ${username} -> ${target || '-'} | ${details || ''}`);
}

// =========================
// Authentication Middleware
// =========================
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  
  if (!token) {
    return res.status(401).json({ ok: false, error: 'Authentication required' });
  }
  
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = users.get(decoded.userId);
    
    if (!user) {
      return res.status(401).json({ ok: false, error: 'User not found' });
    }
    
    if (user.status !== 'active') {
      return res.status(403).json({ ok: false, error: 'Account is not active' });
    }
    
    req.user = {
      id: user.id,
      username: user.username,
      role: user.role
    };
    
    next();
  } catch (e) {
    if (e.name === 'TokenExpiredError') {
      return res.status(401).json({ ok: false, error: 'Session expired' });
    }
    return res.status(401).json({ ok: false, error: 'Invalid token' });
  }
}

// Role-based access middleware
function requirePermission(permission) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ ok: false, error: 'Authentication required' });
    }
    
    if (!hasPermission(req.user.role, permission)) {
      logAudit('access_denied', req.user.username, permission, `Role: ${req.user.role}`, req.ip);
      return res.status(403).json({ ok: false, error: 'Insufficient permissions' });
    }
    
    next();
  };
}

// =========================
// Password Validation
// =========================
function validatePassword(password) {
  const errors = [];
  
  if (password.length < 8) {
    errors.push('Password must be at least 8 characters');
  }
  if (!/[A-Z]/.test(password)) {
    errors.push('Password must contain an uppercase letter');
  }
  if (!/[a-z]/.test(password)) {
    errors.push('Password must contain a lowercase letter');
  }
  if (!/[0-9]/.test(password)) {
    errors.push('Password must contain a number');
  }
  
  return errors;
}

// =========================
// Routes
// =========================

// Register (public - creates operator account)
router.post('/register', async (req, res) => {
  const { username, password } = req.body;
  const ip = req.ip || req.connection?.remoteAddress || 'unknown';
  
  if (!username || !password) {
    return res.status(400).json({ ok: false, error: 'Username and password required' });
  }
  
  // Validate username
  if (username.length < 3 || username.length > 50) {
    return res.status(400).json({ ok: false, error: 'Username must be 3-50 characters' });
  }
  
  if (!/^[a-zA-Z0-9_]+$/.test(username)) {
    return res.status(400).json({ ok: false, error: 'Username can only contain letters, numbers, and underscores' });
  }
  
  // Check for duplicate username
  for (const u of users.values()) {
    if (u.username.toLowerCase() === username.toLowerCase()) {
      return res.status(400).json({ ok: false, error: 'Username already exists' });
    }
  }
  
  // Validate password
  const passwordErrors = validatePassword(password);
  if (passwordErrors.length > 0) {
    return res.status(400).json({ ok: false, error: passwordErrors.join('. ') });
  }
  
  // Create user as operator (default role)
  const id = uuidv4();
  const newUser = {
    id,
    username,
    passwordHash: await bcrypt.hash(password, BCRYPT_ROUNDS),
    role: 'operator', // Default role for self-registration
    status: 'active',
    failedAttempts: 0,
    lockedUntil: null,
    lastLogin: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  
  users.set(id, newUser);
  
  logAudit('user_registered', username, null, 'Self-registration as operator', ip);
  
  res.status(201).json({
    ok: true,
    message: 'Account created successfully'
  });
});

// Login
router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  const ip = req.ip || req.connection?.remoteAddress || 'unknown';
  
  if (!username || !password) {
    return res.status(400).json({ ok: false, error: 'Username and password required' });
  }
  
  // Find user by username
  let user = null;
  for (const u of users.values()) {
    if (u.username.toLowerCase() === username.toLowerCase()) {
      user = u;
      break;
    }
  }
  
  if (!user) {
    logAudit('login_failed', username, null, 'User not found', ip);
    return res.status(401).json({ ok: false, error: 'Invalid credentials' });
  }
  
  // Check if locked
  if (user.lockedUntil && new Date(user.lockedUntil) > new Date()) {
    const remaining = Math.ceil((new Date(user.lockedUntil) - new Date()) / 60000);
    logAudit('login_blocked', username, null, `Account locked for ${remaining} more minutes`, ip);
    return res.status(403).json({ 
      ok: false, 
      error: `Account locked. Try again in ${remaining} minutes.` 
    });
  }
  
  // Check if account is active
  if (user.status !== 'active') {
    logAudit('login_failed', username, null, `Account status: ${user.status}`, ip);
    return res.status(403).json({ ok: false, error: 'Account is not active' });
  }
  
  // Verify password
  const valid = await bcrypt.compare(password, user.passwordHash);
  
  if (!valid) {
    user.failedAttempts = (user.failedAttempts || 0) + 1;
    
    if (user.failedAttempts >= MAX_LOGIN_ATTEMPTS) {
      user.lockedUntil = new Date(Date.now() + LOCKOUT_DURATION_MS).toISOString();
      user.status = 'locked';
      logAudit('account_locked', username, null, `Exceeded ${MAX_LOGIN_ATTEMPTS} failed attempts`, ip);
    }
    
    logAudit('login_failed', username, null, `Failed attempt ${user.failedAttempts}/${MAX_LOGIN_ATTEMPTS}`, ip);
    return res.status(401).json({ ok: false, error: 'Invalid credentials' });
  }
  
  // Successful login
  user.failedAttempts = 0;
  user.lockedUntil = null;
  user.status = 'active';
  user.lastLogin = new Date().toISOString();
  
  const token = jwt.sign(
    { userId: user.id, username: user.username, role: user.role },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
  
  logAudit('login', username, null, 'Successful login', ip);
  
  res.json({
    ok: true,
    token,
    user: {
      id: user.id,
      username: user.username,
      role: user.role
    }
  });
});

// Get all users (admin only)
router.get('/users', authenticateToken, requirePermission('users:read'), (req, res) => {
  const userList = Array.from(users.values()).map(u => ({
    id: u.id,
    username: u.username,
    role: u.role,
    status: u.status,
    lastLogin: u.lastLogin,
    failedAttempts: u.failedAttempts,
    createdAt: u.createdAt
  }));
  
  res.json({ ok: true, users: userList });
});

// Get single user (admin only)
router.get('/users/:id', authenticateToken, requirePermission('users:read'), (req, res) => {
  const user = users.get(req.params.id);
  
  if (!user) {
    return res.status(404).json({ ok: false, error: 'User not found' });
  }
  
  res.json({
    ok: true,
    user: {
      id: user.id,
      username: user.username,
      role: user.role,
      status: user.status,
      lastLogin: user.lastLogin,
      failedAttempts: user.failedAttempts,
      createdAt: user.createdAt
    }
  });
});

// Create user (admin only)
router.post('/users', authenticateToken, requirePermission('users:write'), async (req, res) => {
  const { username, password, role = 'operator', status = 'active' } = req.body;
  const ip = req.ip || 'unknown';
  
  if (!username || !password) {
    return res.status(400).json({ ok: false, error: 'Username and password are required' });
  }
  
  // Validate username
  if (username.length < 3 || username.length > 50) {
    return res.status(400).json({ ok: false, error: 'Username must be 3-50 characters' });
  }
  
  // Check for duplicate username
  for (const u of users.values()) {
    if (u.username.toLowerCase() === username.toLowerCase()) {
      return res.status(400).json({ ok: false, error: 'Username already exists' });
    }
  }
  
  // Validate password
  const passwordErrors = validatePassword(password);
  if (passwordErrors.length > 0) {
    return res.status(400).json({ ok: false, error: passwordErrors.join('. ') });
  }
  
  // Validate role (only admin and operator allowed)
  if (!['admin', 'operator'].includes(role)) {
    return res.status(400).json({ ok: false, error: 'Invalid role. Must be admin or operator.' });
  }
  
  // Create user
  const id = uuidv4();
  const newUser = {
    id,
    username,
    passwordHash: await bcrypt.hash(password, BCRYPT_ROUNDS),
    role,
    status,
    failedAttempts: 0,
    lockedUntil: null,
    lastLogin: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  
  users.set(id, newUser);
  
  logAudit('user_created', req.user.username, username, `Role: ${role}`, ip);
  
  res.status(201).json({
    ok: true,
    user: {
      id: newUser.id,
      username: newUser.username,
      role: newUser.role,
      status: newUser.status
    }
  });
});

// Update user (admin only)
router.put('/users/:id', authenticateToken, requirePermission('users:write'), async (req, res) => {
  const user = users.get(req.params.id);
  const ip = req.ip || 'unknown';
  
  if (!user) {
    return res.status(404).json({ ok: false, error: 'User not found' });
  }
  
  const { password, role, status } = req.body;
  const changes = [];
  
  // Update password if provided
  if (password) {
    const passwordErrors = validatePassword(password);
    if (passwordErrors.length > 0) {
      return res.status(400).json({ ok: false, error: passwordErrors.join('. ') });
    }
    user.passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    changes.push('password');
  }
  
  // Update role if provided
  if (role && role !== user.role) {
    if (!['admin', 'operator'].includes(role)) {
      return res.status(400).json({ ok: false, error: 'Invalid role. Must be admin or operator.' });
    }
    const oldRole = user.role;
    user.role = role;
    changes.push(`role: ${oldRole} -> ${role}`);
    logAudit('role_changed', req.user.username, user.username, `${oldRole} -> ${role}`, ip);
  }
  
  // Update status if provided
  if (status && status !== user.status) {
    const oldStatus = user.status;
    user.status = status;
    changes.push(`status: ${oldStatus} -> ${status}`);
    
    // Reset lockout if unlocking
    if (status === 'active' && oldStatus === 'locked') {
      user.failedAttempts = 0;
      user.lockedUntil = null;
    }
  }
  
  user.updatedAt = new Date().toISOString();
  
  if (changes.length > 0) {
    logAudit('user_updated', req.user.username, user.username, changes.join(', '), ip);
  }
  
  res.json({
    ok: true,
    user: {
      id: user.id,
      username: user.username,
      role: user.role,
      status: user.status
    }
  });
});

// Delete user (admin only)
router.delete('/users/:id', authenticateToken, requirePermission('users:delete'), (req, res) => {
  const user = users.get(req.params.id);
  const ip = req.ip || 'unknown';
  
  if (!user) {
    return res.status(404).json({ ok: false, error: 'User not found' });
  }
  
  // Prevent self-deletion
  if (user.id === req.user.id) {
    return res.status(400).json({ ok: false, error: 'Cannot delete your own account' });
  }
  
  users.delete(req.params.id);
  
  logAudit('user_deleted', req.user.username, user.username, `Role was: ${user.role}`, ip);
  
  res.json({ ok: true, deleted: user.username });
});

// Get audit logs (admin only)
router.get('/audit', authenticateToken, requirePermission('audit:read'), (req, res) => {
  let logs = auditLogs;
  
  // Filter by event type if specified
  if (req.query.event) {
    logs = logs.filter(l => l.event === req.query.event);
  }
  
  // Limit results
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  logs = logs.slice(0, limit);
  
  res.json({ ok: true, logs });
});

export default router;
export { authenticateToken, requirePermission, logAudit, hasPermission };
