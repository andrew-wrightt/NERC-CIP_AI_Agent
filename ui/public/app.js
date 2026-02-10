const chatEl   = document.getElementById("chat");
const promptEl = document.getElementById("prompt");
const sendBtn  = document.getElementById("send");
const statusEl = document.getElementById("status");
const uploadBtn   = document.getElementById("upload");
const filePicker  = document.getElementById("filepicker");
const uploadStatusEl = document.getElementById("upload-status");

// ===== Auth UI elements (from index.html additions) =====
const loginOverlay = document.getElementById("login-overlay");
const loginNotice  = document.getElementById("login-notice");
const loginError   = document.getElementById("login-error");
const loginUser    = document.getElementById("login-username");
const loginPass    = document.getElementById("login-password");
const login2fa     = document.getElementById("login-2fa"); // placeholder only
const loginSubmit  = document.getElementById("login-submit");

const authUserLabel = document.getElementById("auth-user");
const logoutBtn     = document.getElementById("logout");

let currentUser = null;

// conversation history
const messages = [{ role: "system", content: "You are a helpful, concise assistant." }];

// store last latency for #47
let lastLatency = {
  firstTokenMs: 0,
  totalMs: 0,
};

// theme logic
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

// Tiny markdown: inline code + bold (no links)
function mdLite(s) {
  return String(s || "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
}

function setBusy(b) {
  if (sendBtn) sendBtn.disabled = b || !currentUser;
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
    return node; // article.msg node
  }
  // Fallback
  const div = document.createElement("div");
  div.className = `msg ${role === "user" ? "user" : "assistant"}`;
  div.textContent = text || "";
  chatEl.appendChild(div);
  chatEl.scrollTop = chatEl.scrollHeight;
  return div;
}

// ===== Auth helpers =====
function setAuthedUI(enabled) {
  // Optional blur/disable layer if you added the CSS hook
  document.body.classList.toggle("auth-locked", !enabled);

  // Disable interactive bits while logged out
  if (sendBtn) sendBtn.disabled = !enabled;
  if (promptEl) promptEl.disabled = !enabled;
  if (uploadBtn) uploadBtn.disabled = !enabled;
  if (filePicker) filePicker.disabled = !enabled;

  const mgr = document.getElementById("mgr");
  if (mgr) mgr.style.display = enabled ? "" : "none";
}

function showLogin(message = "") {
  currentUser = null;

  if (loginNotice) loginNotice.textContent = message || "";
  if (loginError) loginError.textContent = "";
  if (loginOverlay) loginOverlay.hidden = false;

  if (authUserLabel) authUserLabel.hidden = true;
  if (logoutBtn) logoutBtn.hidden = true;

  setAuthedUI(false);
}

function showLoggedIn() {
  if (loginOverlay) loginOverlay.hidden = true;

  if (authUserLabel) {
    authUserLabel.textContent = `Logged in as ${currentUser?.username || "?"}`;
    authUserLabel.hidden = false;
  }
  if (logoutBtn) logoutBtn.hidden = false;

  setAuthedUI(true);
}

async function authMe() {
  const res = await fetch("/api/auth/me");
  const data = await res.json().catch(() => ({}));
  currentUser = data.user || null;
  return currentUser;
}

// Use this for protected routes only.
// If the server replies 401, it will open the login overlay.
async function authedFetch(url, options = {}) {
  const res = await fetch(url, options);
  if (res.status === 401) {
    showLogin("Please log in to continue.");
    throw new Error("Unauthorized");
  }
  return res;
}

async function doLogin() {
  if (!loginUser || !loginPass || !loginSubmit) return;

  if (loginError) loginError.textContent = "";
  if (loginNotice) loginNotice.textContent = "";

  const username = (loginUser.value || "").trim();
  const password = loginPass.value || "";

  if (!username || !password) {
    if (loginError) loginError.textContent = "Please enter username and password.";
    return;
  }

  loginSubmit.disabled = true;
  loginSubmit.textContent = "Logging in...";

  try {
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username,
        password,
        // Placeholder only for now:
        // secondFactor: (login2fa?.value || "").trim()
      }),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (loginError) loginError.textContent = data?.error || `Login failed (${res.status})`;
      return;
    }

    currentUser = data.user || null;
    showLoggedIn();

    // Refresh uploads list when user logs in
    refreshUploads().catch(() => {});
  } catch {
    if (loginError) loginError.textContent = "Login request failed. Check server/network.";
  } finally {
    loginSubmit.disabled = false;
    loginSubmit.textContent = "Log in";
  }
}

async function doLogout() {
  try {
    await fetch("/api/auth/logout", { method: "POST" });
  } catch {}
  showLogin("Logged out.");
}

// Wire auth buttons
loginSubmit?.addEventListener("click", doLogin);
logoutBtn?.addEventListener("click", doLogout);
loginPass?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") doLogin();
});

// ===== Your existing functions (with protected fetches switched) =====
async function refreshUploads() {
  try {
    const res = await authedFetch("/api/uploads");
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
          const r = await authedFetch(`/api/uploads/${encodeURIComponent(storedAs)}`, { method: "DELETE" });
          const j = await r.json();
          if (!r.ok || !j?.ok) {
            alert(j?.error || "Delete failed");
          } else {
            li.remove();
            const s = document.getElementById("upload-status");
            if (s) s.textContent = `Deleted ${filename} (${j.removedChunks} chunks removed)`;
          }
        } catch (e) {
          // authedFetch handles 401 by showing login
          if (e?.message !== "Unauthorized") alert(e?.message || "Delete error");
        } finally {
          del.disabled = false;
        }
      });

      li.appendChild(left);
      li.appendChild(del);
      listEl.appendChild(li);
    });
  } catch (e) {
    // authedFetch will show login on 401; otherwise log
    if (e?.message !== "Unauthorized") console.error("refreshUploads error:", e);
  }
}

async function sendMessage() {
  if (!currentUser) {
    showLogin("Please log in to chat.");
    return;
  }

  const content = promptEl.value.trim();
  if (!content) return;

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
    const res = await authedFetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages })
    });

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
          if (firstTokenMs === null) firstTokenMs = performance.now() - startTs;

          assembled += piece;
          if (contentEl !== assistantBubble) {
            contentEl.innerHTML = mdLite(assembled);
          } else {
            assistantBubble.textContent = assembled;
          }
          chatEl.scrollTop = chatEl.scrollHeight;
        }

        if (obj?.done) {
          if (assembled.trim().length === 0) contentEl.textContent = "(no response)";

          const citesBox   = assistantBubble.querySelector?.(".cites");
          const sourcesEl  = assistantBubble.querySelector?.(".sources");
          const sourcesArr = Array.isArray(obj.sources) ? obj.sources : [];
          if (citesBox && sourcesEl && sourcesArr.length > 0) {
            sourcesEl.innerHTML = "";
            sourcesArr.forEach((s) => {
              const label = typeof s === "string" ? s : (s?.source || JSON.stringify(s));
              const href  = (typeof s === "object" && s?.href)
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

          console.log(
            `[Latency] first token: ${Math.round(lastLatency.firstTokenMs)} ms,` +
            ` full response: ${Math.round(lastLatency.totalMs)} ms`
          );
        }
      }
    }

    messages.push({ role: "assistant", content: assembled || "(no response)" });
  } catch (e) {
    if (e?.message === "Unauthorized") {
      contentEl.textContent = "Please log in again.";
    } else {
      contentEl.textContent = e?.message || "Network error.";
    }
  } finally {
    setBusy(false);
    avatarEl?.classList.remove("loading");

    if (statusEl && lastLatency.totalMs) {
      const seconds = (lastLatency.totalMs / 1000).toFixed(1);
      statusEl.textContent = `Finished in ${seconds} seconds…`;
    }
  }
}

// Single, definitive upload function (protected)
async function uploadFiles(files) {
  if (!currentUser) {
    showLogin("Please log in to upload files.");
    return;
  }
  if (!files || files.length === 0) return;

  if (uploadBtn) uploadBtn.disabled = true;
  if (uploadStatusEl) uploadStatusEl.textContent = "Uploading and indexing…";

  try {
    const fd = new FormData();
    for (const f of files) fd.append("files", f);

    const res = await authedFetch("/api/upload", { method: "POST", body: fd });
    const data = await res.json();
    if (!res.ok || !data?.ok) throw new Error(data?.error || "Upload failed");

    const names = (data.indexed || []).map(x => x.file).join(", ");
    if (uploadStatusEl) uploadStatusEl.textContent =
      `Indexed: ${names || "files"} (Total chunks: ${data.totalChunks ?? "?"})`;

    refreshUploads();
  } catch (e) {
    if (e?.message === "Unauthorized") {
      if (uploadStatusEl) uploadStatusEl.textContent = "Please log in again.";
    } else {
      if (uploadStatusEl) uploadStatusEl.textContent = e?.message || "Upload error.";
      console.error("uploadFiles error:", e);
    }
  } finally {
    if (uploadBtn) uploadBtn.disabled = false;
    if (filePicker) filePicker.value = "";
  }
}

// Wire events
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

// File manager opens -> refresh (protected)
const mgr = document.getElementById("mgr");
mgr?.addEventListener("toggle", () => {
  if (mgr.open) refreshUploads();
});

// ===== Boot: redirect to login if not logged in =====
(async function boot() {
  try {
    const me = await authMe();
    if (!me) {
      showLogin();
    } else {
      showLoggedIn();
      // Optional: pre-load uploads list
      // refreshUploads();
    }
  } catch {
    showLogin("Could not reach server. Is the container running?");
  }
})();
