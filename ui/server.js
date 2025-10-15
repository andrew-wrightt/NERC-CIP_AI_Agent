import express from "express";
import fetch from "node-fetch";
import path from "path";
import { fileURLToPath } from "url";

// convert URL to file in order to access things in public folder 
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// create express server, allow it to parse JSON reqs, set up backend using public folder 
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// sends requests to ollama server/localhost port
const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";

// define POST route (api/chat), get model, message history, and temperature from browser
// forward request to Ollama API, parse response and return text to UI
app.post("/api/chat", async (req, res) => {
  const { model, messages, temperature = 0.7 } = req.body;
  try {
    const r = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: model || "mistral:instruct",
        messages,
        stream: false,
        options: { temperature }
      })
    });
    const data = await r.json();
    const text = data?.message?.content ?? "";
    res.json({ reply: text });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// start express server on port 5173, sends log message to validate successful deployment
app.listen(5173, () => {
  console.log(`UI running on http://localhost:5173`);
});
