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
async function login(username, password) {
  try {
    const res = await fetch(`${API_BASE}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    
    const data = await res.json();
    
    if (!res.ok || !data.ok) {
      throw new Error(data.error || 'Login failed');
    }
    
    authToken = data.token;
    currentUser = data.user;
    
    // Store in session
    sessionStorage.setItem('authToken', authToken);
    sessionStorage.setItem('currentUser', JSON.stringify(currentUser));
    
    showDashboard();
    return true;
  } catch (e) {
    throw e;
  }
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
    usersTbody.innerHTML = '<tr><td colspan="6" style="text-align:center">No users found</td></tr>';
    return;
  }
  
  usersTbody.innerHTML = users.map(u => `
    <tr data-id="${u.id}">
      <td><strong>${escapeHtml(u.username)}</strong></td>
      <td><span class="role-badge ${u.role}">${u.role}</span></td>
      <td><span class="status-${u.status}">${u.status}</span></td>
      <td>${u.lastLogin ? formatDate(u.lastLogin) : 'Never'}</td>
      <td>${u.failedAttempts || 0}</td>
      <td class="action-btns">
        <button class="btn-edit" onclick="editUser('${u.id}')">Edit</button>
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
  
  loginError.hidden = true;
  document.getElementById('login-btn').disabled = true;
  
  try {
    await login(username, password);
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
// Initialize
// =========================
checkAuth();
