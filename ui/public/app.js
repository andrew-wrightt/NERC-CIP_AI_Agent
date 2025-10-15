// constants for chat, prompt, send, model, temperature, and max tokens
const chatEl = document.getElementById("chat");
const promptEl = document.getElementById("prompt");
const sendBtn = document.getElementById("send");
const modelEl = document.getElementById("model");
const tempEl = document.getElementById("temp");
const maxTokEl = document.getElementById("maxtok");

// set the 'personality' of the agent. basically a prompt for the style of answers
const messages = [
  { role: "system", content: "You are a helpful, concise assistant." }
];

// function to create each chat bubble (both agent and user)
function addBubble(role, text) {
  const div = document.createElement("div");
  div.className = `msg ${role === "user" ? "user" : "assistant"}`;
  div.textContent = text;
  chatEl.appendChild(div);
  chatEl.scrollTop = chatEl.scrollHeight;
}

// handling of sending prompt to backend -> retrieving response to display
async function sendMessage() {
  const content = promptEl.value.trim();
  if (!content) return;
  promptEl.value = "";
  addBubble("user", content);
  messages.push({ role: "user", content });

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

  const data = await res.json();
  const reply = data.reply || data.error || "(no response)";
  addBubble("assistant", reply);
  messages.push({ role: "assistant", content: reply });
}

// adds functionality to hit 'Enter' to send prompt as well as 'Send' button
promptEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});
