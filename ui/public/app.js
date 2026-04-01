// =========================
// NERC-CIP AI Agent - Main App JS
// With Authentication & Role-Based Access
// =========================

const API_BASE = '/api/admin';

// =========================
// State
// =========================
let currentUser = null;
let authToken = null;
const messages = [{ role: "system", content: "You are a helpful, concise assistant." }];

// =========================
// DOM Elements - Auth
// =========================
const authScreen = document.getElementById('auth-screen');
const mainApp = document.getElementById('main-app');
const loginForm = document.getElementById('login-form');
const registerForm = document.getElementById('register-form');
const loginError = document.getElementById('login-error');
const registerError = document.getElementById('register-error');
const registerSuccess = document.getElementById('register-success');
const showRegisterLink = document.getElementById('show-register');
const showLoginLink = document.getElementById('show-login');
const logoutBtn = document.getElementById('logout-btn');
const userDisplay = document.getElementById('user-display');
const adminControls = document.getElementById('admin-controls');

// =========================
// DOM Elements - Chat
// =========================
const chatEl = document.getElementById("chat");
const promptEl = document.getElementById("prompt");
const sendBtn = document.getElementById("send");
const statusEl = document.getElementById("status");
const uploadBtn = document.getElementById("upload");
const filePicker = document.getElementById("filepicker");
const uploadStatusEl = document.getElementById("upload-status");

// =========================
// Theme Logic
// =========================
const themeToggle = document.getElementById("theme-toggle");

function setTheme(mode) {
  document.documentElement.setAttribute("data-theme", mode);
  try { localStorage.setItem("theme", mode); } catch {}
}

(function initTheme() {
  const saved = (() => { try { return localStorage.getItem("theme"); } catch { return null; } })();
  const prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  const mode = saved || (prefersDark ? "dark" : "light");
  setTheme(mode);
  if (themeToggle) themeToggle.checked = mode === "dark";
})();

if (themeToggle) {
  themeToggle.addEventListener("change", () => {
    setTheme(themeToggle.checked ? "dark" : "light");
  });
}

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

  showMainApp();
}

async function register(username, password) {
  const res = await fetch(`${API_BASE}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  });
  
  const data = await res.json();
  
  if (!res.ok || !data.ok) {
    throw new Error(data.error || 'Registration failed');
  }
  
  return data;
}

function logout() {
  authToken = null;
  currentUser = null;
  sessionStorage.removeItem('authToken');
  sessionStorage.removeItem('currentUser');
  
  // Clear chat
  messages.length = 1; // Keep system message
  if (chatEl) chatEl.innerHTML = '';
  
  showAuthScreen();
}

function checkAuth() {
  const storedToken = sessionStorage.getItem('authToken');
  const storedUser = sessionStorage.getItem('currentUser');
  
  if (storedToken && storedUser) {
    authToken = storedToken;
    currentUser = JSON.parse(storedUser);
    showMainApp();
  } else {
    showAuthScreen();
  }
}

function showAuthScreen() {
  authScreen.hidden = false;
  mainApp.hidden = true;
  loginForm.hidden = false;
  registerForm.hidden = true;
}

function showMainApp() {
  authScreen.hidden = true;
  mainApp.hidden = false;
  
  // Update user display
  userDisplay.textContent = `${currentUser?.username || 'User'} (${currentUser?.role || 'unknown'})`;
  
  // Show admin controls only for admins
  if (currentUser?.role === 'admin') {
    adminControls.hidden = false;
    refreshUploads();
  } else {
    adminControls.hidden = true;
  }
}

// =========================
// Auth Event Listeners
// =========================
showRegisterLink?.addEventListener('click', (e) => {
  e.preventDefault();
  loginForm.hidden = true;
  registerForm.hidden = false;
  loginError.hidden = true;
  registerError.hidden = true;
  registerSuccess.hidden = true;
});

showLoginLink?.addEventListener('click', (e) => {
  e.preventDefault();
  loginForm.hidden = false;
  registerForm.hidden = true;
  loginError.hidden = true;
  registerError.hidden = true;
  registerSuccess.hidden = true;
});

loginForm?.addEventListener('submit', async (e) => {
  e.preventDefault();

  const username = document.getElementById('login-username').value.trim();
  const password = document.getElementById('login-password').value;
  const otp = document.getElementById('login-otp').value.trim();

  loginError.hidden = true;

  try {
    await login(username, password, otp);
  } catch (err) {
    loginError.textContent = err.message;
    loginError.hidden = false;
  }
});

registerForm?.addEventListener('submit', async (e) => {
  e.preventDefault();
  
  const username = document.getElementById('register-username').value.trim();
  const password = document.getElementById('register-password').value;
  const confirm = document.getElementById('register-confirm').value;
  
  registerError.hidden = true;
  registerSuccess.hidden = true;
  
  if (password !== confirm) {
    registerError.textContent = 'Passwords do not match';
    registerError.hidden = false;
    return;
  }
  
  try {
    await register(username, password);
    registerSuccess.textContent = 'Account created! You can now sign in.';
    registerSuccess.hidden = false;
    registerForm.reset();
    
    // Switch to login after 2 seconds
    setTimeout(() => {
      loginForm.hidden = false;
      registerForm.hidden = true;
      registerSuccess.hidden = true;
    }, 2000);
  } catch (err) {
    registerError.textContent = err.message;
    registerError.hidden = false;
  }
});

logoutBtn?.addEventListener('click', logout);

// =========================
// Chat Functions
// =========================
let lastLatency = { firstTokenMs: 0, totalMs: 0 };

function mdLite(s) {
  return String(s || "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
}

function setBusy(b) {
  if (sendBtn) sendBtn.disabled = b;
  if (!statusEl) return;
  statusEl.classList.toggle("loading", b);
  statusEl.textContent = b ? "Retrieving context and generating…" : "";
}

function addBubble(role, text) {
  const tpl = document.getElementById("msg-tpl");
  if (tpl?.content?.firstElementChild) {
    const node = tpl.content.firstElementChild.cloneNode(true);
    node.classList.add(role === "user" ? "user" : "assistant");
    const contentEl = node.querySelector(".content");
    if (contentEl) contentEl.innerHTML = mdLite(text || "");
    chatEl.appendChild(node);
    chatEl.scrollTop = chatEl.scrollHeight;
    return node;
  }
  const div = document.createElement("div");
  div.className = `msg ${role === "user" ? "user" : "assistant"}`;
  div.textContent = text || "";
  chatEl.appendChild(div);
  chatEl.scrollTop = chatEl.scrollHeight;
  return div;
}

async function sendMessage() {
  const content = promptEl.value.trim();
  if (!content) return;
  
  if (!authToken) {
    alert('Please log in to use the chat.');
    return;
  }

  const startTs = performance.now();
  let firstTokenMs = null;

  promptEl.value = "";
  setBusy(true);

  addBubble("user", content);
  messages.push({ role: "user", content });

  const assistantBubble = addBubble("assistant", "");
  const contentEl = assistantBubble.querySelector?.(".content") || assistantBubble;
  const avatarEl = assistantBubble.querySelector?.(".avatar");
  avatarEl?.classList.add("loading");

  let assembled = "";

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { 
        "Content-Type": "application/json",
        "Authorization": `Bearer ${authToken}`
      },
      body: JSON.stringify({ messages })
    });

    if (res.status === 401) {
      logout();
      alert('Session expired. Please log in again.');
      return;
    }

    if (!res.ok || !res.body) {
      const err = await res.text().catch(() => "");
      contentEl.textContent = err || "Request failed.";
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim()) continue;
        let obj;
        try { obj = JSON.parse(line); } catch { continue; }

        const piece = obj?.message?.content ?? "";
        if (piece) {
          if (firstTokenMs === null) {
            firstTokenMs = performance.now() - startTs;
          }

          assembled += piece;
          if (contentEl !== assistantBubble) {
            contentEl.innerHTML = mdLite(assembled);
          } else {
            assistantBubble.textContent = assembled;
          }
          chatEl.scrollTop = chatEl.scrollHeight;
        }

        if (obj?.done) {
          if (assembled.trim().length === 0) {
            contentEl.textContent = "(no response)";
          }
          const citesBox = assistantBubble.querySelector?.(".cites");
          const sourcesEl = assistantBubble.querySelector?.(".sources");
          const sourcesArr = Array.isArray(obj.sources) ? obj.sources : [];
          if (citesBox && sourcesEl && sourcesArr.length > 0) {
            sourcesEl.innerHTML = "";
            sourcesArr.forEach((s) => {
              const label = typeof s === "string" ? s : (s?.source || JSON.stringify(s));
              const href = (typeof s === "object" && s?.href)
                ? s.href
                : (typeof label === "string" && label.endsWith(".pdf") ? label : null);

              const li = document.createElement("li");
              if (href) {
                const a = document.createElement("a");
                a.href = href; a.target = "_blank"; a.rel = "noopener";
                a.textContent = label;
                li.appendChild(a);
              } else {
                li.textContent = label;
              }
              sourcesEl.appendChild(li);
            });
            citesBox.hidden = false;
          }

          const totalMs = performance.now() - startTs;
          lastLatency = { firstTokenMs: firstTokenMs ?? 0, totalMs };
          console.log(`[Latency] first token: ${Math.round(lastLatency.firstTokenMs)} ms, full response: ${Math.round(lastLatency.totalMs)} ms`);
        }
      }
    }

    messages.push({ role: "assistant", content: assembled || "(no response)" });
  } catch (e) {
    contentEl.textContent = e?.message || "Network error.";
  } finally {
    setBusy(false);
    avatarEl?.classList.remove("loading");

    if (statusEl && lastLatency.totalMs) {
      const seconds = (lastLatency.totalMs / 1000).toFixed(1);
      statusEl.textContent = `Finished in ${seconds} seconds…`;
    }
  }
}

// =========================
// Upload Functions (Admin Only)
// =========================
async function refreshUploads() {
  if (currentUser?.role !== 'admin') return;
  
  try {
    const res = await fetch("/api/uploads", {
      headers: { "Authorization": `Bearer ${authToken}` }
    });
    const data = await res.json();
    const listEl = document.getElementById("uploads-list");
    if (!listEl) return;

    listEl.innerHTML = "";
    if (!data?.ok || !Array.isArray(data.uploads) || data.uploads.length === 0) {
      const li = document.createElement("li");
      li.textContent = "No uploaded files yet.";
      listEl.appendChild(li);
      return;
    }

    data.uploads.forEach(({ filename, storedAs, pages, href }) => {
      const li = document.createElement("li");

      const left = document.createElement("div");
      left.className = "meta";
      const a = document.createElement("a");
      a.textContent = filename;
      a.href = href;
      a.target = "_blank";
      a.rel = "noopener";
      left.appendChild(a);
      if (pages != null) {
        left.appendChild(document.createTextNode(`  ·  ${pages} page(s)`));
      }

      const del = document.createElement("button");
      del.textContent = "Delete";
      del.addEventListener("click", async () => {
        if (!confirm(`Delete "${filename}" from uploads and index?`)) return;
        del.disabled = true;
        try {
          const r = await fetch(`/api/uploads/${encodeURIComponent(storedAs)}`, { 
            method: "DELETE",
            headers: { "Authorization": `Bearer ${authToken}` }
          });
          const j = await r.json();
          if (!r.ok || !j?.ok) {
            alert(j?.error || "Delete failed");
          } else {
            li.remove();
            if (uploadStatusEl) uploadStatusEl.textContent = `Deleted ${filename} (${j.removedChunks} chunks removed)`;
          }
        } catch (e) {
          alert(e?.message || "Delete error");
        } finally {
          del.disabled = false;
        }
      });

      li.appendChild(left);
      li.appendChild(del);
      listEl.appendChild(li);
    });
  } catch (e) {
    console.error("refreshUploads error:", e);
  }
}

async function uploadFiles(files) {
  if (!files || files.length === 0) return;
  if (currentUser?.role !== 'admin') {
    alert('Only admins can upload files.');
    return;
  }
  
  if (uploadBtn) uploadBtn.disabled = true;
  if (uploadStatusEl) uploadStatusEl.textContent = "Uploading and indexing…";

  try {
    const fd = new FormData();
    for (const f of files) fd.append("files", f);

    const res = await fetch("/api/upload", { 
      method: "POST", 
      body: fd,
      headers: { "Authorization": `Bearer ${authToken}` }
    });
    const data = await res.json();
    
    if (res.status === 403) {
      throw new Error('Only admins can upload files');
    }
    if (!res.ok || !data?.ok) throw new Error(data?.error || "Upload failed");

    const names = (data.indexed || []).map(x => x.file).join(", ");
    if (uploadStatusEl) uploadStatusEl.textContent =
      `Indexed: ${names || "files"} (Total chunks: ${data.totalChunks ?? "?"})`;

    refreshUploads();
  } catch (e) {
    if (uploadStatusEl) uploadStatusEl.textContent = e?.message || "Upload error.";
    console.error("uploadFiles error:", e);
  } finally {
    if (uploadBtn) uploadBtn.disabled = false;
    if (filePicker) filePicker.value = "";
  }
}

// =========================
// Event Listeners - Chat
// =========================
if (promptEl) {
  promptEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });
}
if (sendBtn) sendBtn.addEventListener("click", sendMessage);

if (uploadBtn && filePicker) {
  uploadBtn.addEventListener("click", () => filePicker.click());
  filePicker.addEventListener("change", (e) => uploadFiles(e.target.files));
}

const mgr = document.getElementById("mgr");
mgr?.addEventListener("toggle", () => {
  if (mgr.open) refreshUploads();
});

// =========================
// Initialize
// =========================
checkAuth();
