const chatEl   = document.getElementById("chat");
const promptEl = document.getElementById("prompt");
const sendBtn  = document.getElementById("send");
const statusEl = document.getElementById("status");
const uploadBtn   = document.getElementById("upload");
const filePicker  = document.getElementById("filepicker");
const uploadStatusEl = document.getElementById("upload-status");

// conversation history
const messages = [{ role: "system", content: "You are a helpful, concise assistant." }];

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

async function refreshUploads() {
  try {
    const res = await fetch("/api/uploads");
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
          const r = await fetch(`/api/uploads/${encodeURIComponent(storedAs)}`, { method: "DELETE" });
          const j = await r.json();
          if (!r.ok || !j?.ok) {
            alert(j?.error || "Delete failed");
          } else {
            li.remove();
            const s = document.getElementById("upload-status");
            if (s) s.textContent = `Deleted ${filename} (${j.removedChunks} chunks removed)`;
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

async function sendMessage() {
  const content = promptEl.value.trim();
  if (!content) return;

  promptEl.value = "";
  setBusy(true);

  // user bubble
  addBubble("user", content);
  messages.push({ role: "user", content });

  // assistant bubble (stream target)
  const assistantBubble = addBubble("assistant", "");
  const contentEl = assistantBubble.querySelector?.(".content") || assistantBubble;

  // spinner on avatar
  const avatarEl = assistantBubble.querySelector?.(".avatar");
  avatarEl?.classList.add("loading");

  let assembled = "";

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages }) // model/temperature/max_tokens removed; server has defaults
    });

    if (!res.ok || !res.body) {
      const err = await res.text().catch(() => "");
      contentEl.textContent = err || "Request failed.";
      return;
    }

    // Stream NDJSON
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
        }
      }
    }

    messages.push({ role: "assistant", content: assembled || "(no response)" });
  } catch (e) {
    contentEl.textContent = e?.message || "Network error.";
  } finally {
    setBusy(false);
    avatarEl?.classList.remove("loading");
  }
}

// Single, definitive upload function (no duplicates!)
async function uploadFiles(files) {
  if (!files || files.length === 0) return;
  if (uploadBtn) uploadBtn.disabled = true;
  if (uploadStatusEl) uploadStatusEl.textContent = "Uploading and indexing…";

  try {
    const fd = new FormData();
    for (const f of files) fd.append("files", f);

    const res = await fetch("/api/upload", { method: "POST", body: fd });
    const data = await res.json();
    if (!res.ok || !data?.ok) throw new Error(data?.error || "Upload failed");

    const names = (data.indexed || []).map(x => x.file).join(", ");
    if (uploadStatusEl) uploadStatusEl.textContent =
      `Indexed: ${names || "files"} (Total chunks: ${data.totalChunks ?? "?"})`;

    // refresh file manager list
    refreshUploads();
  } catch (e) {
    if (uploadStatusEl) uploadStatusEl.textContent = e?.message || "Upload error.";
    console.error("uploadFiles error:", e);
  } finally {
    if (uploadBtn) uploadBtn.disabled = false;
    if (filePicker) filePicker.value = ""; // reset selection
  }
}

// Wire events (guard for missing elements just in case)
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

// File manager opens -> refresh
const mgr = document.getElementById("mgr");
mgr?.addEventListener("toggle", () => {
  if (mgr.open) refreshUploads();
});
