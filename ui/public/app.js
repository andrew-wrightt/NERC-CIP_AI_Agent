const chatEl   = document.getElementById("chat");
const promptEl = document.getElementById("prompt");
const sendBtn  = document.getElementById("send");
const modelEl  = document.getElementById("model");
const tempEl   = document.getElementById("temp");
const maxTokEl = document.getElementById("maxtok");
const statusEl = document.getElementById("status");

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

  // Fallback basic div
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

  // UI prep
  promptEl.value = "";
  setBusy(true);

  // Render user bubble immediately
  addBubble("user", content);
  messages.push({ role: "user", content });

  // Create assistant bubble we will stream into
  const assistantBubble = addBubble("assistant", "");
  const contentEl = assistantBubble.querySelector?.(".content") || assistantBubble;

  // Show spinner on avatar
  const avatarEl = assistantBubble.querySelector?.(".avatar");
  avatarEl?.classList.add("loading");

  let assembled = "";

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: modelEl.value,
        messages,
        temperature: Number(tempEl.value),
        max_tokens: Number(maxTokEl.value)
      })
    });

    if (!res.ok || !res.body) {
      const err = await res.text().catch(() => "");
      contentEl.textContent = err || "Request failed.";
      return;
    }

    // Stream NDJSON line-by-line
    const reader = res.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Split on newlines; keep last partial in buffer
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim()) continue;

        let obj;
        try {
          obj = JSON.parse(line);
        } catch {
          continue;
        }

        // Streamed tokens
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

        // Completion lines
        if (obj?.done) {
          if (assembled.trim().length === 0) {
            contentEl.textContent = "(no response)";
          }

          // Render sources only if provided as an array
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

    // Save assistant turn
    messages.push({ role: "assistant", content: assembled || "(no response)" });
  } catch (e) {
    contentEl.textContent = e?.message || "Network error.";
  } finally {
    setBusy(false);
    avatarEl?.classList.remove("loading");
  }
}

// Enter = send, Shift+Enter = newline
promptEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

sendBtn.addEventListener("click", sendMessage);