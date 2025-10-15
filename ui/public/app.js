const chatEl = document.getElementById("chat");
const promptEl = document.getElementById("prompt");
const sendBtn = document.getElementById("send");
const modelEl = document.getElementById("model");
const tempEl = document.getElementById("temp");
const maxTokEl = document.getElementById("maxtok");

// Keep conversation history (OpenAI-style)
const messages = [
  { role: "system", content: "You are a helpful, concise assistant." }
];

function addBubble(role, text) {
  const div = document.createElement("div");
  div.className = `msg ${role === "user" ? "user" : "assistant"}`;
  div.textContent = text;
  chatEl.appendChild(div);
  chatEl.scrollTop = chatEl.scrollHeight;
  return div; // return element so we can live-update it
}

async function sendMessage() {
  const content = promptEl.value.trim();
  if (!content) return;

  // UI prep
  promptEl.value = "";
  sendBtn.disabled = true;

  // Render user bubble immediately
  addBubble("user", content);
  messages.push({ role: "user", content });

  // Create assistant bubble we will stream into
  const assistantBubble = addBubble("assistant", "");
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
          assistantBubble.textContent = assembled;
          chatEl.scrollTop = chatEl.scrollHeight;
        }

        // Final line signals completion
        if (obj?.done) {
          if (assembled.trim().length === 0) {
            assistantBubble.textContent = "(no response)";
          }
        }
      }
    }

    // Push the assistant message to conversation history
    messages.push({ role: "assistant", content: assembled || "(no response)" });
  } catch (e) {
    assistantBubble.textContent = e?.message || "Network error.";
  } finally {
    sendBtn.disabled = false;
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