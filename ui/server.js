import express from "express";
import fetch from "node-fetch";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs/promises";
import pdfParse from "pdf-parse";
import { createHash } from "crypto"; // <-- for stable cache keys

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";
const CHAT_MODEL = "mistral:instruct";
const EMBED_MODEL = "nomic-embed-text";

// === CACHE: persistent cache for embeddings of indexed documents ===
const CACHE_PATH = path.join(__dirname, ".rag-embed-cache.json");
let embedCache = Object.create(null); // { hash(text) : number[] }

/** Load cache file if present */
async function loadEmbedCache() {
  try {
    const data = await fs.readFile(CACHE_PATH, "utf8");
    const parsed = JSON.parse(data);
    if (parsed && typeof parsed === "object") embedCache = parsed;
    console.log(`[cache] Loaded ${Object.keys(embedCache).length} vectors from ${path.basename(CACHE_PATH)}`);
  } catch {
    console.log("[cache] No existing cache, starting fresh");
  }
}

/** Persist cache atomically to disk */
async function saveEmbedCache() {
  try {
    const tmp = CACHE_PATH + ".tmp";
    await fs.writeFile(tmp, JSON.stringify(embedCache), "utf8");
    // atomic-ish replace
    await fs.rename(tmp, CACHE_PATH);
    console.log(`[cache] Saved ${Object.keys(embedCache).length} vectors`);
  } catch (e) {
    console.warn("[cache] Save failed:", e.message);
  }
}

function hashText(text) {
  return createHash("sha256").update(text).digest("hex");
}

// ---------------------------
// Tiny vector + retrieval lib
// ---------------------------
function dot(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; }
function norm(a) { return Math.sqrt(dot(a, a)); }
function cosineSim(a, b) { const na = norm(a), nb = norm(b); return na && nb ? dot(a, b) / (na * nb) : 0; }

// simple word-ish chunker
function chunkText(txt, targetChars = 1200, overlap = 200) {
  const clean = txt.replace(/\s+/g, " ").trim();
  const chunks = [];
  let i = 0;
  while (i < clean.length) {
    const end = Math.min(clean.length, i + targetChars);
    let chunk = clean.slice(i, end);
    // try to end on sentence boundary
    const lastPeriod = chunk.lastIndexOf(". ");
    if (end < clean.length && lastPeriod > targetChars * 0.6) {
      chunk = chunk.slice(0, lastPeriod + 1);
    }
    chunks.push(chunk);
    i += Math.max(chunk.length - overlap, 1);
  }
  return chunks;
}

// ---------------------------
// Embeddings via Ollama
// ---------------------------
async function embedTextSingle(text) {
  // Ollama reliably supports the single "prompt" form
  const resp = await fetch(`${OLLAMA_URL}/api/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: EMBED_MODEL, prompt: text })
  });

  if (!resp.ok) {
    const msg = await resp.text().catch(() => resp.statusText);
    throw new Error(`Embeddings error: ${msg}`);
  }

  const data = await resp.json();

  // Normalize a vector out of whatever shape we got back
  const vec =
    (Array.isArray(data?.embedding) && data.embedding) ||
    (Array.isArray(data?.embeddings) && data.embeddings[0]) ||
    (Array.isArray(data) && data[0]?.embedding) ||
    null;

  if (!Array.isArray(vec) || vec.length === 0) {
    throw new Error("Embeddings error: empty vector");
  }
  return vec;
}

async function embedTexts(texts) {
  // Run singles in parallel; keeps behavior consistent across Ollama versions
  return Promise.all(texts.map(t => embedTextSingle(t)));
}

/** === CACHE-AWARE: embed list but reuse cached vectors for known texts (for corpus only) */
async function embedTextsWithCache(texts) {
  // Resolve in original order
  const results = new Array(texts.length);
  const misses = [];
  const missIdx = [];

  for (let i = 0; i < texts.length; i++) {
    const t = texts[i] || "";
    const key = hashText(t);
    const cached = embedCache[key];
    if (Array.isArray(cached)) {
      results[i] = cached;
    } else {
      misses.push(t);
      missIdx.push(i);
    }
  }

  if (misses.length) {
    const newVecs = await embedTexts(misses);
    for (let k = 0; k < missIdx.length; k++) {
      const i = missIdx[k];
      const t = texts[i] || "";
      const key = hashText(t);
      const vec = newVecs[k];
      results[i] = vec;
      // Update cache
      embedCache[key] = vec;
    }
  }

  return results;
}

// ---------------------------
// Corpus indexing (PDFs in /public)
// ---------------------------
const corpus = []; // {chunk, source, href, embedding}

async function indexPublicPDFs() {
  corpus.length = 0;
  const publicDir = path.join(__dirname, "public");
  const files = await fs.readdir(publicDir);
  const pdfs = files.filter(f => f.toLowerCase().endsWith(".pdf"));

  for (const pdfName of pdfs) {
    const filePath = path.join(publicDir, pdfName);
    const buf = await fs.readFile(filePath);
    const parsed = await pdfParse(buf);
    const chunks = chunkText(parsed.text || "");
    if (!chunks.length) continue;

    // embed in batches to avoid large payloads
    const batchSize = 32;
    for (let i = 0; i < chunks.length; i += batchSize) {
      const slice = chunks.slice(i, i + batchSize);

      // === use cached embeddings for corpus ===
      const vecs = await embedTextsWithCache(slice);

      for (let j = 0; j < slice.length; j++) {
        corpus.push({
          chunk: slice[j],
          source: `${pdfName} (pseudopages)`,
          href: `/${pdfName}`, // served from /public
          embedding: vecs[j]
        });
      }
    }
    console.log(`Indexed ${pdfName}: ${chunks.length} chunks`);
    // Save cache periodically for long corpora
    await saveEmbedCache();
  }
  console.log(`Total chunks indexed: ${corpus.length}`);
}

// Load cache, then index once on boot
await loadEmbedCache();
await indexPublicPDFs();

// optional: simple endpoint to rebuild index if you add/replace PDFs at runtime
app.post("/api/reindex", async (_req, res) => {
  try {
    await indexPublicPDFs();
    await saveEmbedCache();
    res.json({ ok: true, chunks: corpus.length });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---------------------------
// RAG Chat: retrieve + stream
// ---------------------------
async function retrieveTopK(query, k = 6) {
  if (!corpus.length) return [];
  // NOTE: we do NOT cache query embeddings; only corpus chunks
  const qlist = await embedTexts([query || ""]);
  const qvec = qlist[0];

  if (!Array.isArray(qvec) || qvec.length === 0) {
    console.warn("retrieveTopK: got empty query embedding");
    return [];
  }

  const scored = corpus
    .filter(c => Array.isArray(c.embedding) && c.embedding.length) // safety
    .map((c, idx) => ({ idx, score: cosineSim(qvec, c.embedding) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);

  return scored.map(s => corpus[s.idx]);
}

function buildContextBlock(chunks) {
  const header =
`You are a NERC CIP domain assistant. Answer **only** using the CONTEXT below.
If the answer is not present in the context, say you don't know.
Quote exact requirement IDs and sections when relevant.

CONTEXT BEGIN
`;
  const body = chunks.map((c, i) =>
`[${i+1}] Source: ${c.source}
${c.chunk}
`).join("\n---\n");
  const footer = "\nCONTEXT END\n";
  return header + body + footer;
}

app.post("/api/chat", async (req, res) => {
  const { model = CHAT_MODEL, messages = [], temperature = 0.3, max_tokens } = req.body;

  // last user message (fall back to whole dialog if needed)
  const lastUser = [...messages].reverse().find(m => m.role === "user")?.content || "";

  // RAG retrieval
  let retrieved = [];
  try {
    retrieved = await retrieveTopK(lastUser, 6);
  } catch (e) {
    console.warn("Retrieve error:", e.message);
  }

  const contextMsg = {
    role: "system",
    content: buildContextBlock(retrieved)
  };

  // enforce a system instruction that the model must not hallucinate
  const guardrailsMsg = {
    role: "system",
    content:
      "If the user's request is outside the supplied CONTEXT, reply: 'I don't know based on the provided documents.'"
  };

  // Compose final message list: system guardrails + context + the prior conversation
  const toSend = [guardrailsMsg, contextMsg, ...messages];

  // Kick off the request to Ollama with streaming enabled
  const upstream = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: toSend,
      stream: true,
      options: {
        temperature,
        ...(Number.isFinite(max_tokens) ? { num_predict: Number(max_tokens) } : {})
      },
      keep_alive: "1h"
    })
  });

  // Prepare response as NDJSON stream back to browser
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("X-Accel-Buffering", "no");

  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => "");
    res.status(502).end(text || "Upstream error");
    return;
  }

  // forward chunks and then append our own final JSON line with sources
  try {
    for await (const chunk of upstream.body) {
      res.write(chunk);
    }
  } catch {
    // ignore midstream disconnects
  } finally {
    const sources = retrieved.map((r) => ({
      source: r.source.replace(/\s+\(pseudopages\)$/, ""),
      href: r.href
    }));
    res.write(JSON.stringify({ done: true, sources }) + "\n");
    res.end();
  }
});

app.listen(5173, () => {
  console.log(`UI running on http://localhost:5173`);
});

// Save cache on shutdown signals, best-effort
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, async () => {
    await saveEmbedCache();
    process.exit(0);
  });
}
