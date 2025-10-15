import express from "express";
import fetch from "node-fetch";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";

/**
 * Streaming chat proxy:
 * - Sends stream:true to Ollama
 * - Pipes Ollama's NDJSON stream directly back to the browser
 * - Each line is a JSON object; final one has { done: true }
 */
app.post("/api/chat", async (req, res) => {
  const { model, messages, temperature = 0.7, max_tokens } = req.body;

  // Kick off the request to Ollama with streaming enabled
  const upstream = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: model || "mistral:instruct",
      messages,
      stream: true,
      options: {
        temperature,
        // forwarding max_tokens is optional; Ollama may ignore/clip by context
        ...(Number.isFinite(max_tokens) ? { num_predict: Number(max_tokens) } : {})
      },
      keep_alive: "1h"
    })
  });

  // Pass-through stream (NDJSON)
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("X-Accel-Buffering", "no"); // helpful behind reverse proxies

  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => "");
    res.status(502).end(text || "Upstream error");
    return;
  }

  try {
    for await (const chunk of upstream.body) {
      res.write(chunk); // forward raw NDJSON line(s)
    }
  } catch (e) {
    // swallow mid-stream disconnects
  } finally {
    res.end();
  }
});

app.listen(5173, () => {
  console.log(`UI running on http://localhost:5173`);
});