const chatEl   = document.getElementById("chat");
const promptEl = document.getElementById("prompt");
const sendBtn  = document.getElementById("send");
const statusEl = document.getElementById("status");

const uploadBtn   = document.getElementById("upload");
const filePicker  = document.getElementById("filepicker");
const uploadStatusEl = document.getElementById("upload-status");

// Conversation history (OpenAI-style)
const messages = [{ role: "system", content: "You are a helpful, concise assistant." }];

// Tiny markdown: inline code + bold (no links)
function mdLite(s) {
  return String(s || "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
}

function setBusy(b) {
  sendBtn.disabled = b;
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
      // model/temperature/max_tokens removed; server has sane defaults
      body: JSON.stringify({ messages })
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

// Upload handling
async function uploadFiles(files) {
  if (!files || files.length === 0) return;
  uploadBtn.disabled = true;
  uploadStatusEl.textContent = "Uploading and indexing…";

  try {
    const fd = new FormData();
    for (const f of files) fd.append("files", f);

    const res = await fetch("/api/upload", { method: "POST", body: fd });
    const data = await res.json();
    if (!res.ok || !data?.ok) {
      throw new Error(data?.error || "Upload failed");
    }

    const names = (data.indexed || []).map(x => x.file).join(", ");
    uploadStatusEl.textContent = `Indexed: ${names || "files"} (Total chunks: ${data.totalChunks ?? "?"})`;
  } catch (e) {
    uploadStatusEl.textContent = e?.message || "Upload error.";
  } finally {
    uploadBtn.disabled = false;
    filePicker.value = ""; // reset selection
  }
}

// Wire events
promptEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});
sendBtn.addEventListener("click", sendMessage);

uploadBtn.addEventListener("click", () => filePicker.click());
filePicker.addEventListener("change", (e) => uploadFiles(e.target.files));
