// =========================
// Admin Panel Frontend JS
// Connects UI to admin API endpoints (#102)
// =========================

const API_BASE = '/api/admin';

// State
let currentUser = null;
let authToken = null;

// DOM Elements
const loginModal = document.getElementById('login-modal');
const dashboard = document.getElementById('dashboard');
const loginForm = document.getElementById('login-form');
const loginError = document.getElementById('login-error');
const logoutBtn = document.getElementById('logout-btn');

const currentUserEl = document.getElementById('current-user');
const userRoleEl = document.getElementById('user-role');

const navBtns = document.querySelectorAll('.nav-btn');
const tabContents = document.querySelectorAll('.tab-content');

const usersTbody = document.getElementById('users-tbody');
const auditTbody = document.getElementById('audit-tbody');

const addUserBtn = document.getElementById('add-user-btn');
const userModal = document.getElementById('user-modal');
const userForm = document.getElementById('user-form');
const userModalTitle = document.getElementById('user-modal-title');
const cancelUserBtn = document.getElementById('cancel-user-btn');
const userError = document.getElementById('user-error');

const deleteModal = document.getElementById('delete-modal');
const deleteUsername = document.getElementById('delete-username');
const cancelDeleteBtn = document.getElementById('cancel-delete-btn');
const confirmDeleteBtn = document.getElementById('confirm-delete-btn');

const auditFilter = document.getElementById('audit-filter');
const refreshAuditBtn = document.getElementById('refresh-audit');

// Stats elements
const statTotalUsers = document.getElementById('stat-total-users');
const statActiveUsers = document.getElementById('stat-active-users');
const statLockedUsers = document.getElementById('stat-locked-users');

// =========================
// Auth Functions
// =========================
async function login(username, password, otp) {
  const res = await fetch(`${API_BASE}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password, otp })
  });

  const data = await res.json();

  if (!res.ok || !data.ok) {
    throw new Error(data.error || 'Login failed');
  }

  authToken = data.token;
  currentUser = data.user;

  sessionStorage.setItem('authToken', authToken);
  sessionStorage.setItem('currentUser', JSON.stringify(currentUser));

  showDashboard();
  return true;
} 

function logout() {
  authToken = null;
  currentUser = null;
  sessionStorage.removeItem('authToken');
  sessionStorage.removeItem('currentUser');
  showLogin();
}

function checkAuth() {
  const storedToken = sessionStorage.getItem('authToken');
  const storedUser = sessionStorage.getItem('currentUser');
  
  if (storedToken && storedUser) {
    authToken = storedToken;
    currentUser = JSON.parse(storedUser);
    showDashboard();
  } else {
    showLogin();
  }
}

function showLogin() {
  loginModal.hidden = false;
  dashboard.hidden = true;
}

function showDashboard() {
  loginModal.hidden = true;
  dashboard.hidden = false;
  
  currentUserEl.textContent = currentUser?.username || 'Unknown';
  userRoleEl.textContent = currentUser?.role || 'unknown';
  userRoleEl.className = `role-badge ${currentUser?.role || ''}`;
  
  // Load initial data
  loadUsers();
  loadAuditLog();
}

// =========================
// API Helper
// =========================
async function apiRequest(endpoint, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    ...options.headers
  };
  
  if (authToken) {
    headers['Authorization'] = `Bearer ${authToken}`;
  }
  
  const res = await fetch(`${API_BASE}${endpoint}`, {
    ...options,
    headers
  });
  
  if (res.status === 401) {
    logout();
    throw new Error('Session expired. Please login again.');
  }
  
  return res;
}

// =========================
// User Management
// =========================
async function loadUsers() {
  try {
    const res = await apiRequest('/users');
    const data = await res.json();
    
    if (!data.ok) throw new Error(data.error);
    
    renderUsers(data.users);
    updateStats(data.users);
  } catch (e) {
    console.error('Load users error:', e);
    usersTbody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:var(--danger)">${e.message}</td></tr>`;
  }
}

function renderUsers(users) {
  if (!users || users.length === 0) {
    usersTbody.innerHTML = '<tr><td colspan="7" style="text-align:center">No users found</td></tr>';
    return;
  }

  usersTbody.innerHTML = users.map(u => `
    <tr data-id="${u.id}">
      <td><strong>${escapeHtml(u.username)}</strong></td>
      <td><span class="role-badge ${u.role}">${u.role}</span></td>
      <td><span class="status-${u.status}">${u.status}</span></td>
      <td>${u.mfaEnabled ? `Enabled${u.mfaEmail ? `<br><small>${escapeHtml(u.mfaEmail)}</small>` : ''}` : 'Disabled'}</td>
      <td>${u.lastLogin ? formatDate(u.lastLogin) : 'Never'}</td>
      <td>${u.failedAttempts || 0}</td>
      <td class="action-btns">
        <button class="btn-edit" onclick="editUser('${u.id}')">Edit</button>
        <button class="btn-edit" onclick="setupMfa('${u.id}', '${escapeHtml(u.username)}')">
          ${u.mfaEnabled ? 'Reset MFA' : 'Setup MFA'}
        </button>
        ${
          u.mfaEnabled
            ? `<button class="btn-secondary" onclick="disableMfa('${u.id}', '${escapeHtml(u.username)}')">Disable MFA</button>`
            : ''
        }
        <button class="btn-delete" onclick="confirmDelete('${u.id}', '${escapeHtml(u.username)}')"
          ${u.id === currentUser?.id ? 'disabled title="Cannot delete yourself"' : ''}>Delete</button>
      </td>
    </tr>
  `).join('');
}

function updateStats(users) {
  const total = users.length;
  const active = users.filter(u => u.status === 'active').length;
  const locked = users.filter(u => u.status === 'locked').length;
  
  statTotalUsers.textContent = total;
  statActiveUsers.textContent = active;
  statLockedUsers.textContent = locked;
}

async function createUser(userData) {
  const res = await apiRequest('/users', {
    method: 'POST',
    body: JSON.stringify(userData)
  });
  
  const data = await res.json();
  if (!res.ok || !data.ok) throw new Error(data.error || 'Failed to create user');
  
  return data;
}

async function updateUser(id, userData) {
  const res = await apiRequest(`/users/${id}`, {
    method: 'PUT',
    body: JSON.stringify(userData)
  });
  
  const data = await res.json();
  if (!res.ok || !data.ok) throw new Error(data.error || 'Failed to update user');
  
  return data;
}

async function deleteUser(id) {
  const res = await apiRequest(`/users/${id}`, {
    method: 'DELETE'
  });
  
  const data = await res.json();
  if (!res.ok || !data.ok) throw new Error(data.error || 'Failed to delete user');
  
  return data;
}

async function setupMfaRequest(id, email) {
  const res = await apiRequest(`/users/${id}/mfa/setup`, {
    method: 'POST',
    body: JSON.stringify({ email })
  });

  const data = await res.json();
  if (!res.ok || !data.ok) throw new Error(data.error || 'Failed to set up MFA');
  return data;
}

async function disableMfaRequest(id) {
  const res = await apiRequest(`/users/${id}/mfa/disable`, {
    method: 'POST'
  });

  const data = await res.json();
  if (!res.ok || !data.ok) throw new Error(data.error || 'Failed to disable MFA');
  return data;
}

// =========================
// Audit Log
// =========================
async function loadAuditLog(filter = '') {
  try {
    const endpoint = filter ? `/audit?event=${filter}` : '/audit';
    const res = await apiRequest(endpoint);
    const data = await res.json();
    
    if (!data.ok) throw new Error(data.error);
    
    renderAuditLog(data.logs);
  } catch (e) {
    console.error('Load audit error:', e);
    auditTbody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:var(--danger)">${e.message}</td></tr>`;
  }
}

function renderAuditLog(logs) {
  if (!logs || logs.length === 0) {
    auditTbody.innerHTML = '<tr><td colspan="6" style="text-align:center">No audit logs found</td></tr>';
    return;
  }
  
  auditTbody.innerHTML = logs.map(log => `
    <tr>
      <td>${formatDate(log.timestamp)}</td>
      <td><span class="event-badge">${log.event}</span></td>
      <td>${escapeHtml(log.username || '-')}</td>
      <td>${escapeHtml(log.target || '-')}</td>
      <td>${escapeHtml(log.details || '-')}</td>
      <td>${log.ipAddress || '-'}</td>
    </tr>
  `).join('');
}

// =========================
// Modal Handlers
// =========================
let editingUserId = null;
let deletingUserId = null;

function showUserModal(isEdit = false, userData = null) {
  userModal.hidden = false;
  userModalTitle.textContent = isEdit ? 'Edit User' : 'Add New User';
  userError.hidden = true;
  
  const passwordField = document.getElementById('password-group');
  const passwordInput = document.getElementById('user-password');
  
  if (isEdit && userData) {
    editingUserId = userData.id;
    document.getElementById('user-id').value = userData.id;
    document.getElementById('user-username').value = userData.username;
    document.getElementById('user-username').disabled = true; // Can't change username
    document.getElementById('user-role-select').value = userData.role;
    document.getElementById('user-status').value = userData.status;
    passwordInput.required = false;
    passwordInput.placeholder = 'Leave blank to keep current';
  } else {
    editingUserId = null;
    userForm.reset();
    document.getElementById('user-username').disabled = false;
    passwordInput.required = true;
    passwordInput.placeholder = '';
  }
}

function hideUserModal() {
  userModal.hidden = true;
  editingUserId = null;
  userForm.reset();
}

window.editUser = async function(id) {
  try {
    const res = await apiRequest(`/users/${id}`);
    const data = await res.json();
    
    if (!data.ok) throw new Error(data.error);
    
    showUserModal(true, data.user);
  } catch (e) {
    alert('Error loading user: ' + e.message);
  }
};

window.setupMfa = async function(id, username) {
  const email = prompt(`Enter the email address to send the MFA QR code for ${username}:`);
  if (!email) return;

  try {
    const result = await setupMfaRequest(id, email.trim());
    alert(result.message || 'MFA setup email sent.');
    loadUsers();
    loadAuditLog();
  } catch (e) {
    alert('MFA setup failed: ' + e.message);
  }
};

window.disableMfa = async function(id, username) {
  if (!confirm(`Disable MFA for ${username}?`)) return;

  try {
    const result = await disableMfaRequest(id);
    alert(result.message || 'MFA disabled.');
    loadUsers();
    loadAuditLog();
  } catch (e) {
    alert('Disable MFA failed: ' + e.message);
  }
};

window.confirmDelete = function(id, username) {
  deletingUserId = id;
  deleteUsername.textContent = username;
  deleteModal.hidden = false;
};

function hideDeleteModal() {
  deleteModal.hidden = true;
  deletingUserId = null;
}

// =========================
// Event Listeners
// =========================

// Login form
loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();

  const username = document.getElementById('login-username').value.trim();
  const password = document.getElementById('login-password').value;
  const otp = document.getElementById('login-otp').value.trim();

  loginError.hidden = true;
  document.getElementById('login-btn').disabled = true;

  try {
    await login(username, password, otp);
  } catch (e) {
    loginError.textContent = e.message;
    loginError.hidden = false;
  } finally {
    document.getElementById('login-btn').disabled = false;
  }
});

// Logout
logoutBtn.addEventListener('click', logout);

// Tab navigation
navBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    const tab = btn.dataset.tab;
    
    navBtns.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    
    tabContents.forEach(t => t.classList.remove('active'));
    document.getElementById(`tab-${tab}`).classList.add('active');
    
    // Refresh data when switching tabs
    if (tab === 'users') loadUsers();
    if (tab === 'audit') loadAuditLog(auditFilter.value);
    if (tab === 'ingestion') { loadWatcherStatus(); }
  });
});

// Add user button
addUserBtn.addEventListener('click', () => showUserModal(false));

// Cancel user modal
cancelUserBtn.addEventListener('click', hideUserModal);

// User form submit
userForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  
  const userData = {
    username: document.getElementById('user-username').value.trim(),
    password: document.getElementById('user-password').value,
    role: document.getElementById('user-role-select').value,
    status: document.getElementById('user-status').value
  };
  
  // Don't send empty password on edit
  if (editingUserId && !userData.password) {
    delete userData.password;
  }
  
  userError.hidden = true;
  
  try {
    if (editingUserId) {
      await updateUser(editingUserId, userData);
    } else {
      await createUser(userData);
    }
    
    hideUserModal();
    loadUsers();
    loadAuditLog(); // Refresh audit log too
  } catch (e) {
    userError.textContent = e.message;
    userError.hidden = false;
  }
});

// Delete confirmation
cancelDeleteBtn.addEventListener('click', hideDeleteModal);

confirmDeleteBtn.addEventListener('click', async () => {
  if (!deletingUserId) return;
  
  confirmDeleteBtn.disabled = true;
  
  try {
    await deleteUser(deletingUserId);
    hideDeleteModal();
    loadUsers();
    loadAuditLog();
  } catch (e) {
    alert('Delete failed: ' + e.message);
  } finally {
    confirmDeleteBtn.disabled = false;
  }
});

// Audit filter
auditFilter.addEventListener('change', () => {
  loadAuditLog(auditFilter.value);
});

refreshAuditBtn.addEventListener('click', () => {
  loadAuditLog(auditFilter.value);
});

// Close modals on escape
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!userModal.hidden) hideUserModal();
    if (!deleteModal.hidden) hideDeleteModal();
  }
});

// =========================
// Utilities
// =========================
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatDate(dateStr) {
  if (!dateStr) return '-';
  const d = new Date(dateStr);
  return d.toLocaleString();
}

// =========================
// #113 — Scraping Pipeline UI
// =========================
const runScrapeBtn = document.getElementById('run-scrape-btn');
const scrapeUrlInput = document.getElementById('scrape-url');
const scrapeStatus = document.getElementById('scrape-status');
const scrapeSpinner = document.getElementById('scrape-spinner');
const scrapeResult = document.getElementById('scrape-result');
const loadManifestBtn = document.getElementById('load-manifest-btn');
const scrapeManifest = document.getElementById('scrape-manifest');

async function runScraper() {
  const url = scrapeUrlInput?.value?.trim() || null;
  if (runScrapeBtn) runScrapeBtn.disabled = true;
  if (scrapeStatus) scrapeStatus.hidden = false;
  if (scrapeSpinner) scrapeSpinner.hidden = false;
  if (scrapeResult) scrapeResult.textContent = 'Running scraping pipeline…';

  try {
    const body = url ? JSON.stringify({ url }) : '{}';
    const res = await fetch('/api/scrape', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`,
      },
      body,
    });

    if (res.status === 401) { logout(); return; }
    const data = await res.json();

    if (!res.ok || !data.ok) {
      scrapeResult.textContent = `Error: ${data.error || 'Scrape failed'}`;
    } else {
      const lines = [
        `Discovered: ${data.discovered ?? '-'}`,
        `Downloaded: ${data.downloaded ?? '-'}`,
        `Unchanged: ${data.unchanged ?? '-'}`,
        `Errors: ${data.errors ?? '-'}`,
      ];
      if (data.ingested?.length > 0) {
        lines.push(`\nIngested into RAG DB:\n  ${data.ingested.join('\n  ')}`);
      }
      scrapeResult.textContent = lines.join('\n');
    }
  } catch (e) {
    scrapeResult.textContent = `Network error: ${e.message}`;
  } finally {
    if (runScrapeBtn) runScrapeBtn.disabled = false;
    if (scrapeSpinner) scrapeSpinner.hidden = true;
  }
}

async function loadManifest() {
  if (scrapeManifest) scrapeManifest.innerHTML = '<p>Loading…</p>';

  try {
    const res = await fetch('/api/scrape/status', {
      headers: { 'Authorization': `Bearer ${authToken}` },
    });
    if (res.status === 401) { logout(); return; }
    const data = await res.json();

    if (!data.ok) {
      scrapeManifest.innerHTML = `<p class="error-msg">${escapeHtml(data.error)}</p>`;
      return;
    }

    if (!data.entries || data.entries.length === 0) {
      scrapeManifest.innerHTML = '<p>No scraped documents tracked yet.</p>';
      return;
    }

    const rows = data.entries.map(e =>
      `<tr>
        <td>${escapeHtml(e.filename || '-')}</td>
        <td>${e.sizeBytes ? `${(e.sizeBytes / 1024).toFixed(0)} KB` : '-'}</td>
        <td>${e.downloadedAt ? formatDate(e.downloadedAt) : '-'}</td>
        <td>${e.lastChecked ? formatDate(e.lastChecked) : '-'}</td>
      </tr>`
    ).join('');

    scrapeManifest.innerHTML = `
      <p>Tracking ${data.totalTracked} document(s)</p>
      <table class="manifest-table">
        <thead><tr><th>File</th><th>Size</th><th>Downloaded</th><th>Last Checked</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  } catch (e) {
    scrapeManifest.innerHTML = `<p class="error-msg">Error: ${escapeHtml(e.message)}</p>`;
  }
}

runScrapeBtn?.addEventListener('click', runScraper);
loadManifestBtn?.addEventListener('click', loadManifest);

// =========================
// #114 — Document Watcher UI
// =========================
const refreshWatcherBtn = document.getElementById('refresh-watcher-btn');
const triggerScanBtn = document.getElementById('trigger-scan-btn');
const watcherRunning = document.getElementById('watcher-running');
const watcherDirs = document.getElementById('watcher-dirs');
const watcherLastScan = document.getElementById('watcher-last-scan');
const watcherScanStatus = document.getElementById('watcher-scan-status');
const watcherScanResult = document.getElementById('watcher-scan-result');
const loadHistoryBtn = document.getElementById('load-history-btn');
const watcherHistory = document.getElementById('watcher-history');

async function loadWatcherStatus() {
  try {
    const res = await fetch('/api/watcher/status', {
      headers: { 'Authorization': `Bearer ${authToken}` },
    });
    if (res.status === 401) { logout(); return; }
    const data = await res.json();

    if (!data.ok) return;

    if (watcherRunning) {
      watcherRunning.textContent = data.running ? 'Active' : 'Stopped';
      watcherRunning.style.color = data.running ? 'var(--success, #22c55e)' : 'var(--danger, #ef4444)';
    }
    if (watcherDirs) watcherDirs.textContent = data.watchDirs?.length ?? 0;
    if (watcherLastScan) {
      watcherLastScan.textContent = data.lastScan?.scannedAt
        ? formatDate(data.lastScan.scannedAt)
        : 'Never';
    }
  } catch (e) {
    console.error('Watcher status error:', e);
  }
}

async function triggerScan() {
  if (triggerScanBtn) triggerScanBtn.disabled = true;
  if (watcherScanStatus) watcherScanStatus.hidden = false;
  if (watcherScanResult) watcherScanResult.textContent = 'Scanning…';

  try {
    const res = await fetch('/api/watcher/scan', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`,
      },
    });
    if (res.status === 401) { logout(); return; }
    const data = await res.json();

    if (!data.ok) {
      watcherScanResult.textContent = `Error: ${data.error}`;
    } else {
      const lines = [
        `Scanned at: ${data.scannedAt || '-'}`,
        `Added: ${data.added?.length ?? 0}`,
        `Modified: ${data.modified?.length ?? 0}`,
        `Removed: ${data.removed?.length ?? 0}`,
        `Unchanged: ${data.unchanged ?? 0}`,
      ];
      if (data.added?.length > 0) {
        lines.push(`\nNew files:\n  ${data.added.map(f => f.filename).join('\n  ')}`);
      }
      if (data.modified?.length > 0) {
        lines.push(`\nModified:\n  ${data.modified.map(f => f.filename).join('\n  ')}`);
      }
      if (data.removed?.length > 0) {
        lines.push(`\nRemoved:\n  ${data.removed.join('\n  ')}`);
      }
      watcherScanResult.textContent = lines.join('\n');
    }

    loadWatcherStatus();
  } catch (e) {
    watcherScanResult.textContent = `Network error: ${e.message}`;
  } finally {
    if (triggerScanBtn) triggerScanBtn.disabled = false;
  }
}

async function loadWatcherHistory() {
  if (watcherHistory) watcherHistory.innerHTML = '<p>Loading…</p>';

  try {
    const res = await fetch('/api/watcher/history?limit=10', {
      headers: { 'Authorization': `Bearer ${authToken}` },
    });
    if (res.status === 401) { logout(); return; }
    const data = await res.json();

    if (!data.ok || !data.history?.length) {
      watcherHistory.innerHTML = '<p>No change history yet.</p>';
      return;
    }

    const rows = data.history.map(h => {
      const changes = (h.added?.length || 0) + (h.modified?.length || 0) + (h.removed?.length || 0);
      return `<tr>
        <td>${formatDate(h.scannedAt)}</td>
        <td>${h.added?.length || 0}</td>
        <td>${h.modified?.length || 0}</td>
        <td>${h.removed?.length || 0}</td>
        <td>${h.unchanged || 0}</td>
        <td>${changes > 0 ? '<span style="color:var(--warning,#f59e0b)">Changes detected</span>' : '<span style="color:var(--success,#22c55e)">No changes</span>'}</td>
      </tr>`;
    }).join('');

    watcherHistory.innerHTML = `
      <table class="manifest-table">
        <thead><tr><th>Scanned At</th><th>Added</th><th>Modified</th><th>Removed</th><th>Unchanged</th><th>Status</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  } catch (e) {
    watcherHistory.innerHTML = `<p class="error-msg">Error: ${escapeHtml(e.message)}</p>`;
  }
}

refreshWatcherBtn?.addEventListener('click', loadWatcherStatus);
triggerScanBtn?.addEventListener('click', triggerScan);
loadHistoryBtn?.addEventListener('click', loadWatcherHistory);

// =========================
// Initialize
// =========================
checkAuth();
