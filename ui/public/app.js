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
const messages = [];

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
  messages.length = 0; // Clear all messages
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
  
  userDisplay.textContent = `${currentUser?.username || 'User'} (${currentUser?.role || 'unknown'})`;
  
  if (currentUser?.role === 'admin') {
    adminControls.hidden = false;
  } else {
    adminControls.hidden = true;
  }

  // Show welcome state if chat is empty
  if (messages.length === 0) showWelcome();
}

function showWelcome() {
  if (!chatEl) return;
  chatEl.innerHTML = `
    <div class="welcome">
      <div class="welcome-icon"><img src="/srp-logo.webp" alt="SRP" /></div>
      <h2>NERC-CIP Compliance Assistant</h2>
      <p>Ask questions about NERC-CIP standards, requirements, and compliance documentation. Responses are grounded in your indexed CIP documents.</p>
    </div>
  `;
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

// Use marked.js for full markdown rendering, fallback to basic
function renderMarkdown(s) {
  const text = String(s || "");
  if (typeof marked !== "undefined" && marked.parse) {
    try {
      marked.setOptions({ breaks: true, gfm: true });
      return marked.parse(text);
    } catch { /* fall through */ }
  }
  // Fallback
  return text
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\n/g, "<br>");
}

// Strip Gemma 4 thinking blocks from streamed output
function stripThinking(text) {
  let cleaned = text.replace(/<think>[\s\S]*?<\/think>/g, "");
  cleaned = cleaned.replace(/<think>[\s\S]*$/, "");
  return cleaned.trim();
}

function setBusy(b) {
  if (sendBtn) sendBtn.disabled = b;
  if (!statusEl) return;
  statusEl.classList.toggle("loading", b);
  statusEl.textContent = b ? "Retrieving context and generating…" : "";
}

function addBubble(role, text) {
  // Clear welcome state on first message
  const welcomeEl = chatEl?.querySelector(".welcome");
  if (welcomeEl) welcomeEl.remove();

  const tpl = document.getElementById("msg-tpl");
  if (tpl?.content?.firstElementChild) {
    const node = tpl.content.firstElementChild.cloneNode(true);
    node.classList.add(role === "user" ? "user" : "assistant");

    // Set avatar content
    const avatarEl = node.querySelector(".avatar");
    if (avatarEl) {
      if (role === "user") {
        avatarEl.textContent = currentUser?.username?.[0]?.toUpperCase() || "U";
      } else {
        const img = document.createElement("img");
        img.src = "/srp-logo.webp";
        img.alt = "SRP";
        avatarEl.appendChild(img);
      }
    }

    const contentEl = node.querySelector(".content");
    if (contentEl) {
      if (role === "assistant" && !text) {
        // Show typing dots for empty assistant bubble
        contentEl.innerHTML = '<div class="typing-dots"><span></span><span></span><span></span></div>';
      } else {
        contentEl.innerHTML = renderMarkdown(text || "");
      }
    }

    chatEl.appendChild(node);
    chatEl.scrollTop = chatEl.scrollHeight;
    return node;
  }
  // Fallback
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
          const visible = stripThinking(assembled);
          if (contentEl !== assistantBubble) {
            contentEl.innerHTML = renderMarkdown(visible);
          } else {
            assistantBubble.textContent = visible;
          }
          chatEl.scrollTop = chatEl.scrollHeight;
        }

        if (obj?.done) {
          const finalText = stripThinking(assembled);
          if (finalText.length === 0) {
            contentEl.textContent = "(no response)";
          } else {
            if (contentEl !== assistantBubble) {
              contentEl.innerHTML = renderMarkdown(finalText);
            } else {
              assistantBubble.textContent = finalText;
            }
          }

          // Convert [1], [2], etc. into clickable citation links
          const chunkMap = Array.isArray(obj.chunkMap) ? obj.chunkMap : [];
          if (chunkMap.length > 0 && contentEl) {
            contentEl.innerHTML = contentEl.innerHTML.replace(
              /\[(\d+)\]/g,
              (match, num) => {
                const idx = parseInt(num, 10) - 1;
                const chunk = chunkMap[idx];
                if (chunk?.href) {
                  const pageLabel = chunk.page ? ` p.${chunk.page}` : "";
                  const title = `${chunk.source}${pageLabel}`;
                  return `<a class="cite-link" data-href="${chunk.href}" data-title="${title.replace(/"/g, '&quot;')}" title="${title}">[${num}]</a>`;
                }
                return match;
              }
            );

            // Attach click handlers to citation links
            contentEl.querySelectorAll(".cite-link").forEach((link) => {
              link.addEventListener("click", (e) => {
                e.preventDefault();
                openPreview(link.dataset.href, link.dataset.title);
              });
            });
          }

          // Render source chips
          const citesBox = assistantBubble.querySelector?.(".cites-wrap");
          const sourcesEl = assistantBubble.querySelector?.(".sources");
          const sourcesArr = Array.isArray(obj.sources) ? obj.sources : [];
          if (citesBox && sourcesEl && sourcesArr.length > 0) {
            sourcesEl.innerHTML = "";
            sourcesArr.forEach((s) => {
              const label = typeof s === "string" ? s : (s?.source || JSON.stringify(s));
              const href = (typeof s === "object" && s?.href)
                ? s.href
                : (typeof label === "string" && label.endsWith(".pdf") ? label : null);

              const chip = document.createElement("button");
              chip.className = "source-chip";
              chip.textContent = label.replace(/\s*\(pseudopages\)$/, "");
              chip.addEventListener("click", () => {
                if (href) {
                  openPreview(href, chip.textContent);
                  // Mark active
                  document.querySelectorAll(".source-chip.active").forEach(c => c.classList.remove("active"));
                  chip.classList.add("active");
                } else {
                  window.open(label, "_blank");
                }
              });
              sourcesEl.appendChild(chip);
            });
            citesBox.hidden = false;
          }

          // Latency badge
          const totalMs = performance.now() - startTs;
          lastLatency = { firstTokenMs: firstTokenMs ?? 0, totalMs };
          const metaEl = assistantBubble.querySelector?.(".msg-time");
          if (metaEl) {
            const secs = (totalMs / 1000).toFixed(1);
            metaEl.textContent = `Responded in ${secs}s`;
          }
          console.log(`[Latency] first token: ${Math.round(lastLatency.firstTokenMs)} ms, full response: ${Math.round(lastLatency.totalMs)} ms`);
        }
      }
    }

    messages.push({ role: "assistant", content: stripThinking(assembled) || "(no response)" });
  } catch (e) {
    contentEl.textContent = e?.message || "Network error.";
  } finally {
    setBusy(false);
    avatarEl?.classList.remove("loading");
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
  // Auto-resize textarea
  promptEl.addEventListener("input", () => {
    promptEl.style.height = "auto";
    promptEl.style.height = Math.min(promptEl.scrollHeight, 120) + "px";
  });
}
if (sendBtn) sendBtn.addEventListener("click", sendMessage);


// =========================
// Document Preview Panel
// =========================
const previewPanel = document.getElementById("preview-panel");
const previewIframe = document.getElementById("preview-iframe");
const previewTitle = document.getElementById("preview-title");
const previewClose = document.getElementById("preview-close");

function openPreview(href, title) {
  if (!previewPanel || !previewIframe) return;
  // Force reload even if same base PDF (different page)
  previewIframe.src = "about:blank";
  // Small delay to ensure the blank clears before loading new URL
  setTimeout(() => {
    previewIframe.src = href;
  }, 50);
  if (previewTitle) previewTitle.textContent = title || "Document";
  previewPanel.hidden = false;
}

function closePreview() {
  if (!previewPanel || !previewIframe) return;
  previewPanel.hidden = true;
  previewIframe.src = "about:blank";
  document.querySelectorAll(".source-chip.active").forEach(c => c.classList.remove("active"));
}

previewClose?.addEventListener("click", closePreview);

// =========================
// Feedback Modal
// =========================
const feedbackBtn = document.getElementById('feedback-btn');
const feedbackModal = document.getElementById('feedback-modal');
const feedbackForm = document.getElementById('feedback-form');
const feedbackMessage = document.getElementById('feedback-message');
const feedbackError = document.getElementById('feedback-error');
const feedbackSuccess = document.getElementById('feedback-success');
const feedbackCharCount = document.getElementById('feedback-char-count');
const feedbackModalClose = document.getElementById('feedback-modal-close');
const feedbackCancelBtn = document.getElementById('feedback-cancel-btn');
const starRating = document.getElementById('star-rating');

let selectedRating = null;

function openFeedbackModal() {
  feedbackModal.hidden = false;
  feedbackForm.reset();
  feedbackError.hidden = true;
  feedbackSuccess.hidden = true;
  feedbackCharCount.textContent = '0 / 2000';
  selectedRating = null;
  starRating?.querySelectorAll('.star').forEach(s => s.classList.remove('active'));
  feedbackMessage?.focus();
}

function closeFeedbackModal() {
  feedbackModal.hidden = true;
}

feedbackBtn?.addEventListener('click', openFeedbackModal);
feedbackModalClose?.addEventListener('click', closeFeedbackModal);
feedbackCancelBtn?.addEventListener('click', closeFeedbackModal);

feedbackModal?.addEventListener('click', (e) => {
  if (e.target === feedbackModal) closeFeedbackModal();
});

feedbackMessage?.addEventListener('input', () => {
  const len = feedbackMessage.value.length;
  feedbackCharCount.textContent = `${len} / 2000`;
});

starRating?.addEventListener('click', (e) => {
  const star = e.target.closest('.star');
  if (!star) return;
  selectedRating = parseInt(star.dataset.value, 10);
  starRating.querySelectorAll('.star').forEach(s => {
    s.classList.toggle('active', parseInt(s.dataset.value, 10) <= selectedRating);
  });
});

feedbackForm?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const message = feedbackMessage.value.trim();
  if (!message) return;

  feedbackError.hidden = true;
  feedbackSuccess.hidden = true;
  const submitBtn = document.getElementById('feedback-submit-btn');
  submitBtn.disabled = true;

  try {
    const res = await fetch('/api/admin/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, rating: selectedRating }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || 'Submission failed');

    feedbackSuccess.hidden = false;
    feedbackForm.reset();
    feedbackCharCount.textContent = '0 / 2000';
    selectedRating = null;
    starRating?.querySelectorAll('.star').forEach(s => s.classList.remove('active'));
    setTimeout(closeFeedbackModal, 1800);
  } catch (err) {
    feedbackError.textContent = err.message;
    feedbackError.hidden = false;
  } finally {
    submitBtn.disabled = false;
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && feedbackModal && !feedbackModal.hidden) closeFeedbackModal();
});

// =========================
// Initialize
// =========================
checkAuth();
