import express from "express";
import fetch from "node-fetch";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs/promises";
import pdfParse from "pdf-parse";
import { createHash } from "crypto";
import multer from "multer";
import adminRoutes, { authenticateToken, requirePermission } from "./adminRoutes.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());

// ---- Static folders ----
const PUBLIC_DIR  = path.join(__dirname, "public");
const UPLOAD_DIR  = path.join(__dirname, "uploads");
await fs.mkdir(PUBLIC_DIR, { recursive: true });
await fs.mkdir(UPLOAD_DIR, { recursive: true });

app.use(express.static(PUBLIC_DIR));
app.use("/uploads", express.static(UPLOAD_DIR));

// ---- Admin API Routes ----
app.use("/api/admin", adminRoutes);

// ---- Config ----
const OLLAMA_URL  = process.env.OLLAMA_URL || "http://localhost:11434";
const CHAT_MODEL  = "mistral:instruct";
const EMBED_MODEL = "nomic-embed-text";

// ===============================
// RETRIEVAL CONFIGURATION
// ===============================
const RETRIEVAL_CONFIG = {
  // Chunking - larger chunks = more context preserved
  CHUNK_SIZE: 1500,
  CHUNK_OVERLAP: 500,
  
  // How many results to return
  TOP_K: 12,
  
  // Hybrid search balance
  VECTOR_WEIGHT: 0.6,    // Semantic understanding
  BM25_WEIGHT: 0.4,      // Keyword matching
  RRF_K: 60,             // Standard RRF constant
};

// === CACHE ===
const CACHE_DIR = path.join(__dirname, "cache");
await fs.mkdir(CACHE_DIR, { recursive: true });
const CACHE_PATH = path.join(CACHE_DIR, "rag-embed-cache.json");
let embedCache = Object.create(null);

function hashText(text) {
  return createHash("sha256").update(text).digest("hex");
}

async function loadEmbedCache() {
  try {
    const data = await fs.readFile(CACHE_PATH, "utf8");
    const parsed = JSON.parse(data);
    if (parsed && typeof parsed === "object") embedCache = parsed;
    console.log(`[cache] Loaded ${Object.keys(embedCache).length} cached vectors`);
  } catch {
    console.log("[cache] No existing cache, starting fresh");
  }
}

async function saveEmbedCache() {
  try {
    const tmp = CACHE_PATH + ".tmp";
    await fs.writeFile(tmp, JSON.stringify(embedCache), "utf8");
    await fs.rename(tmp, CACHE_PATH);
    console.log(`[cache] Saved ${Object.keys(embedCache).length} vectors`);
  } catch (e) {
    console.warn("[cache] Save failed:", e.message);
  }
}

// ============================
// Vector math
// ============================
function dot(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; }
function norm(a) { return Math.sqrt(dot(a, a)); }
function cosineSim(a, b) { const na = norm(a), nb = norm(b); return na && nb ? dot(a, b) / (na * nb) : 0; }

// ============================
// BM25 Index
// ============================
class BM25Index {
  constructor(k1 = 1.5, b = 0.75) {
    this.k1 = k1;
    this.b = b;
    this.documents = [];
    this.docFreq = new Map();
    this.avgDocLength = 0;
    this.totalDocs = 0;
  }

  tokenize(text) {
    return (text || "").toLowerCase().replace(/[^a-z0-9\-]/g, " ").split(/\s+/).filter(t => t.length > 1);
  }

  addDocument(text, idx) {
    const tokens = this.tokenize(text);
    const termFreq = new Map();
    for (const token of tokens) {
      termFreq.set(token, (termFreq.get(token) || 0) + 1);
    }
    this.documents.push({ idx, termFreq, length: tokens.length });
    for (const term of termFreq.keys()) {
      this.docFreq.set(term, (this.docFreq.get(term) || 0) + 1);
    }
    this.totalDocs++;
    this.avgDocLength = this.documents.reduce((sum, d) => sum + d.length, 0) / this.totalDocs;
  }

  search(query, topK = 10) {
    const queryTokens = this.tokenize(query);
    const scores = [];
    for (const doc of this.documents) {
      let score = 0;
      for (const term of queryTokens) {
        const tf = doc.termFreq.get(term) || 0;
        if (tf === 0) continue;
        const df = this.docFreq.get(term) || 0;
        const idf = Math.log((this.totalDocs - df + 0.5) / (df + 0.5) + 1);
        const numerator = tf * (this.k1 + 1);
        const denominator = tf + this.k1 * (1 - this.b + this.b * (doc.length / this.avgDocLength));
        score += idf * (numerator / denominator);
      }
      if (score > 0) scores.push({ idx: doc.idx, score });
    }
    return scores.sort((a, b) => b.score - a.score).slice(0, topK);
  }

  clear() {
    this.documents = [];
    this.docFreq.clear();
    this.avgDocLength = 0;
    this.totalDocs = 0;
  }
}

const bm25Index = new BM25Index();

// ============================
// Smart Chunking
// ============================
function smartChunk(text, filename, chunkSize = 1500, overlap = 500) {
  // Get document identifier from filename
  const docId = filename.replace(/\.[^/.]+$/, "");
  
  // Clean text but preserve paragraph structure
  const clean = text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t]+/g, ' ').trim();
  
  const chunks = [];
  let i = 0;
  
  while (i < clean.length) {
    let end = Math.min(clean.length, i + chunkSize);
    let chunkText = clean.slice(i, end);
    
    // Try to end at paragraph or sentence boundary
    if (end < clean.length) {
      const lastPara = chunkText.lastIndexOf('\n\n');
      if (lastPara > chunkSize * 0.6) {
        chunkText = chunkText.slice(0, lastPara);
      } else {
        const lastSentence = Math.max(
          chunkText.lastIndexOf('. '),
          chunkText.lastIndexOf('.\n'),
          chunkText.lastIndexOf('? '),
          chunkText.lastIndexOf('! ')
        );
        if (lastSentence > chunkSize * 0.5) {
          chunkText = chunkText.slice(0, lastSentence + 1);
        }
      }
    }
    
    // Add document context prefix
    const finalChunk = `[${docId}]\n${chunkText.trim()}`;
    
    if (finalChunk.length > 50) {
      chunks.push({ text: finalChunk, docId });
    }
    
    i += Math.max(chunkText.length - overlap, 100);
  }
  
  return chunks;
}

// ============================
// Ollama embeddings
// ============================
async function embedTextSingle(text) {
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
  const vec = data?.embedding || data?.embeddings?.[0] || data?.[0]?.embedding || null;

  if (!Array.isArray(vec) || vec.length === 0) {
    throw new Error("Embeddings error: empty vector");
  }
  return vec;
}

async function embedTexts(texts) {
  return Promise.all(texts.map(t => embedTextSingle(t)));
}

async function embedTextsWithCache(texts) {
  const results = new Array(texts.length);
  const misses = [];
  const missIdx = [];

  for (let i = 0; i < texts.length; i++) {
    const key = hashText(texts[i] || "");
    if (Array.isArray(embedCache[key])) {
      results[i] = embedCache[key];
    } else {
      misses.push(texts[i]);
      missIdx.push(i);
    }
  }

  if (misses.length) {
    const newVecs = await embedTexts(misses);
    for (let k = 0; k < missIdx.length; k++) {
      const i = missIdx[k];
      const key = hashText(texts[i] || "");
      results[i] = newVecs[k];
      embedCache[key] = newVecs[k];
    }
  }

  return results;
}

// ===================
// Corpus
// ===================
const corpus = [];
const standardMap = Object.create(null);

function registerStandardFromFilename(pdfName) {
  const m = pdfName.match(/CIP[-\s]?(\d{1,3})[-\s]?(\d+)/i);
  if (!m) return null;
  const num = String(m[1]).padStart(3, "0");
  const versionNum = parseInt(m[2], 10);
  const base = `CIP-${num}`;
  const versioned = `${base}-${versionNum}`;
  if (!standardMap[base]) {
    standardMap[base] = { versions: [versioned], latest: versioned, latestVersion: versionNum };
  } else {
    if (!standardMap[base].versions.includes(versioned)) standardMap[base].versions.push(versioned);
    if (versionNum > standardMap[base].latestVersion) {
      standardMap[base].latest = versioned;
      standardMap[base].latestVersion = versionNum;
    }
  }
  return { base, versioned };
}

function listUploadedFromCorpus() {
  const byStored = new Map();
  for (const c of corpus) {
    if (c?.meta?.origin !== "upload") continue;
    const { filename, storedAs } = c.meta || {};
    if (!storedAs || !filename) continue;
    if (!byStored.has(storedAs)) {
      byStored.set(storedAs, { filename, storedAs, href: `/uploads/${storedAs}`, count: 0 });
    }
    byStored.get(storedAs).count++;
  }
  return Array.from(byStored.values());
}

function removeUploadFromCorpus(storedAs) {
  let removed = 0;
  for (let i = corpus.length - 1; i >= 0; i--) {
    if (corpus[i]?.meta?.origin === "upload" && corpus[i]?.meta?.storedAs === storedAs) {
      corpus.splice(i, 1);
      removed++;
    }
  }
  rebuildBM25Index();
  return removed;
}

function rebuildBM25Index() {
  bm25Index.clear();
  for (let i = 0; i < corpus.length; i++) {
    bm25Index.addDocument(corpus[i].chunk, i);
  }
  console.log(`[bm25] Index ready: ${corpus.length} chunks`);
}

// ============================
// Indexing
// ============================
async function indexPublicPDFs() {
  await loadEmbedCache();
  const publicFiles = await fs.readdir(PUBLIC_DIR);
  const pdfs = publicFiles.filter(f => f.toLowerCase().endsWith(".pdf"));

  // Clear public entries
  for (let i = corpus.length - 1; i >= 0; i--) {
    if (corpus[i]?.meta?.origin === "public") corpus.splice(i, 1);
  }

  for (const pdfFile of pdfs) {
    const buf = await fs.readFile(path.join(PUBLIC_DIR, pdfFile));
    let parsed;
    try {
      parsed = await pdfParse(buf, { max: 0 });
    } catch (err) {
      console.warn(`Skipping ${pdfFile}: ${err.message}`);
      continue;
    }

    registerStandardFromFilename(pdfFile);

    const chunks = smartChunk(parsed.text, pdfFile, RETRIEVAL_CONFIG.CHUNK_SIZE, RETRIEVAL_CONFIG.CHUNK_OVERLAP);
    const vecs = await embedTextsWithCache(chunks.map(c => c.text));

    for (let i = 0; i < chunks.length; i++) {
      corpus.push({
        chunk: chunks[i].text,
        source: pdfFile,
        href: `/${pdfFile}`,
        embedding: vecs[i],
        meta: { filename: pdfFile, origin: "public", docId: chunks[i].docId, chunkIndex: i }
      });
    }

    console.log(`Indexed ${pdfFile}: ${chunks.length} chunks`);
  }

  rebuildBM25Index();
  await saveEmbedCache();
}

indexPublicPDFs().catch(console.error);

// ============================
// Hybrid Retrieval with RRF
// ============================
async function retrieve(query, k = RETRIEVAL_CONFIG.TOP_K) {
  if (!corpus.length) return [];
  
  // Vector search
  const [qvec] = await embedTexts([query]);
  const vectorScores = corpus
    .map((c, idx) => ({ idx, score: Array.isArray(c.embedding) ? cosineSim(qvec, c.embedding) : 0 }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k * 2);
  
  // BM25 search
  const bm25Results = bm25Index.search(query, k * 2);
  
  // Reciprocal Rank Fusion
  const scores = new Map();
  const rrfK = RETRIEVAL_CONFIG.RRF_K;
  
  vectorScores.forEach((r, rank) => {
    scores.set(r.idx, (scores.get(r.idx) || 0) + (1 / (rrfK + rank + 1)) * RETRIEVAL_CONFIG.VECTOR_WEIGHT);
  });
  
  bm25Results.forEach((r, rank) => {
    scores.set(r.idx, (scores.get(r.idx) || 0) + (1 / (rrfK + rank + 1)) * RETRIEVAL_CONFIG.BM25_WEIGHT);
  });
  
  const fused = Array.from(scores.entries())
    .map(([idx, score]) => ({ idx, score }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
  
  console.log(`[retrieval] "${query.substring(0, 50)}..." → ${fused.length} results`);
  
  return fused.map(r => corpus[r.idx]);
}

// ============================
// Upload handling
// ============================
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase() || ".pdf";
      cb(null, createHash("md5").update(file.originalname + Date.now()).digest("hex") + ext);
    }
  }),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    cb(null, [".pdf", ".txt", ".md"].includes(path.extname(file.originalname).toLowerCase()));
  }
});

app.post("/api/upload", authenticateToken, requirePermission('docs:write'), upload.array("files", 20), async (req, res) => {
  const files = req.files || [];
  const results = [];

  try {
    for (const f of files) {
      const buf = await fs.readFile(path.join(UPLOAD_DIR, f.filename));
      registerStandardFromFilename(f.originalname);

      if (f.originalname.toLowerCase().endsWith(".pdf")) {
        let parsed;
        try { parsed = await pdfParse(buf, { max: 0 }); }
        catch (e) { console.warn(`PDF parse error: ${e.message}`); continue; }

        const chunks = smartChunk(parsed.text, f.originalname, RETRIEVAL_CONFIG.CHUNK_SIZE, RETRIEVAL_CONFIG.CHUNK_OVERLAP);
        const vecs = await embedTextsWithCache(chunks.map(c => c.text));

        for (let i = 0; i < chunks.length; i++) {
          corpus.push({
            chunk: chunks[i].text,
            source: f.originalname,
            href: `/uploads/${f.filename}`,
            embedding: vecs[i],
            meta: { filename: f.originalname, storedAs: f.filename, origin: "upload", docId: chunks[i].docId, chunkIndex: i }
          });
        }
      }

      results.push({ file: f.originalname });
      console.log(`Uploaded ${f.originalname}`);
    }

    rebuildBM25Index();
    await saveEmbedCache();
    res.json({ ok: true, indexed: results, totalChunks: corpus.length });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/api/uploads", async (_req, res) => {
  res.json({ ok: true, uploads: listUploadedFromCorpus() });
});

app.delete("/api/uploads/:storedAs", authenticateToken, requirePermission('docs:delete'), async (req, res) => {
  try {
    const storedAs = req.params.storedAs;
    if (!/^[a-f0-9]{32,64}\.(pdf|txt|md)$/i.test(storedAs)) {
      return res.status(400).json({ ok: false, error: "Invalid file id" });
    }
    const found = listUploadedFromCorpus().find(x => x.storedAs === storedAs);
    if (!found) return res.status(404).json({ ok: false, error: "Not found" });

    const removed = removeUploadFromCorpus(storedAs);
    try { await fs.unlink(path.join(UPLOAD_DIR, storedAs)); } catch {}
    await saveEmbedCache();
    res.json({ ok: true, removedChunks: removed });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/api/reindex", async (_req, res) => {
  try {
    await indexPublicPDFs();
    res.json({ ok: true, chunks: corpus.length });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ============================
// Retrieval Test API
// ============================
app.get("/api/retrieval/config", (_req, res) => {
  res.json({ ok: true, config: RETRIEVAL_CONFIG });
});

app.post("/api/retrieval/test", async (req, res) => {
  try {
    const { query } = req.body;
    if (!query) return res.status(400).json({ ok: false, error: "Query required" });
    
    const results = await retrieve(query);
    const sources = results.map((r, i) => ({
      rank: i + 1,
      source: r.source,
      href: r.href,
      chunkPreview: r.chunk?.substring(0, 300) + "..."
    }));
    
    res.json({ ok: true, query, resultsCount: results.length, sources });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ============================
// Chat
// ============================
function buildContext(chunks) {
  const header = `You are an expert assistant for NERC-CIP compliance documents.
Answer using ONLY the context below. If the answer isn't in the context, say "I don't know based on the provided documents."

CONTEXT:
`;
  const body = chunks.map((c, i) => `[${i + 1}] ${c.source}\n${c.chunk}`).join("\n\n---\n\n");
  return header + body;
}

app.post("/api/chat", authenticateToken, async (req, res) => {
  const { model = CHAT_MODEL, messages = [], temperature = 0.3, max_tokens } = req.body;
  const lastUser = [...messages].reverse().find(m => m.role === "user")?.content || "";

  let retrieved = [];
  try { retrieved = await retrieve(lastUser, RETRIEVAL_CONFIG.TOP_K); }
  catch (e) { console.warn("Retrieve error:", e.message); }

  const toSend = [{ role: "system", content: buildContext(retrieved) }, ...messages];

  const upstream = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model, messages: toSend, stream: true,
      options: { temperature, ...(Number.isFinite(max_tokens) ? { num_predict: max_tokens } : {}) },
      keep_alive: "1h"
    })
  });

  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");

  if (!upstream.ok || !upstream.body) {
    return res.status(502).end(await upstream.text().catch(() => "Upstream error"));
  }

  try { for await (const chunk of upstream.body) res.write(chunk); }
  catch {}
  finally {
    const seen = new Set();
    const sources = [];
    for (const r of retrieved) {
      if (!r || seen.has(r.source)) continue;
      seen.add(r.source);
      sources.push({ source: r.source, href: r.href });
    }
    res.write(JSON.stringify({ done: true, sources }) + "\n");
    res.end();
  }
});

// ============================
// Start
// ============================
app.listen(5173, () => console.log(`Running on http://localhost:5173`));

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, async () => { await saveEmbedCache(); process.exit(0); });
}
