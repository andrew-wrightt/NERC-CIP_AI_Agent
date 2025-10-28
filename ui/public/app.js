const chatEl = document.getElementById("chat");
const promptEl = document.getElementById("prompt");
const sendBtn = document.getElementById("send");
const modelEl = document.getElementById("model");
const tempEl = document.getElementById("temp");
const maxTokEl = document.getElementById("maxtok");
const statusEl = document.getElementById("status");

// Keep conversation history (OpenAI-style)
const messages = [
  { role: "system", content: "You are a helpful, concise assistant." }
];

// tiny markdown for inline code and bold (safe meaning no links)
function mdLite(s) {
  return String(s || "")
    .replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")
    .replace(/`([^`]+)`/g,"<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g,"<strong>$1</strong>");
}
// loader toggler
function setBusy(b) {
  sendBtn.disabled = b;
  if (statusEl) {
    statusEl.classList.toggle("loading", b);
    statusEl.textContent = b ? "Retrieving context and generating…" : "";
  }
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
    return node; // now returns the article.msg node
  }

  // fallback to your original simple div if template isnt found
  const div = document.createElement("div");
  div.className = `msg ${role === "user" ? "user" : "assistant"}`;
  div.textContent = text;
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
  const contentEl = assistantBubble.querySelector ? (assistantBubble.querySelector(".content") || assistantBubble) : assistantBubble;
  
  // find the avatar in the new bubble and add to the loading class
  const avatarEl = assistantBubble.querySelector(".avatar");
  if (avatarEl) {
    avatarEl.classList.add("loading");
  }

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
      const err = await res.text();
      assistantBubble.textContent = err || "Request failed.";
      return;
    }

    // Read NDJSON stream line-by-line
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

        // Each chunk may contain token(s) under message.content
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

        // Final line signals completion
        if (obj?.done) {
          if (assembled.trim().length === 0) {
            if (contentEl !== assistantBubble) contentEl.textContent = "(no response)";
            else assistantBubble.textContent = "(no response)";
          }
            let sources = obj.sources;
            // local source
            if (!sources || !sources.length) {
            sources = [
              { source: "CIP-005-6.pdf", href: "CIP-005-6.pdf" }  // link to the file
            ];
            }
            
      // --- render Sources UI under this assistant bubble ---
      const citesBox = assistantBubble.querySelector(".cites");
      const sourcesList = assistantBubble.querySelector(".sources");
      if (citesBox && sourcesList) {
        sourcesList.innerHTML = "";
        const flat = Array.isArray(sources[0]) ? sources[0] : sources;
        flat.forEach(s => {
          const label = typeof s === "string" ? s : (s?.source || JSON.stringify(s));
          const href = (typeof s === "object" && s?.href) ? s.href : (label.endsWith(".pdf") ? label : null);
          const li = document.createElement("li");
          if (href) {
            const a = document.createElement("a");
            a.href = href; a.target = "_blank"; a.rel = "noopener";
            a.textContent = label;
            li.appendChild(a);
          } else {
            li.textContent = label;
          }
          sourcesList.appendChild(li);
        });
        citesBox.hidden = false;
        // citesBox.open = true;
      }
}
      }
    }

    // Push the assistant message to conversation history
    messages.push({ role: "assistant", content: assembled || "(no response)" });
  } catch (e) {
    assistantBubble.textContent = e?.message || "Network error.";
  } finally {
    setBusy(false);

    if (avatarEl) {
      avatarEl.classList.remove("loading");
    }
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