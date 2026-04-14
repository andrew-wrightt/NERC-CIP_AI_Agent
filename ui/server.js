// ui/server.js
import express from "express";
import fetch from "node-fetch";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs/promises";
import fsSync from "fs";
import pdfParse from "pdf-parse";
// Admin / Auth
import session from "express-session";
import SQLiteStoreFactory from "connect-sqlite3";
import { authRouter } from "./auth/auth.routes.js";
import adminRoutes, { authenticateToken, requirePermission } from "./adminRoutes.js";

// RAG DB (documents/standards/chunks/embeddings)
import { openRagDb } from "./ragdb.js";

// #113 Scraping pipeline + #114 Document change watcher
import { Scraper } from "./scraper.js";
import { DocumentWatcher } from "./watcher.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());

// ---- Static folders ----
const PUBLIC_DIR = path.join(__dirname, "public");
const UPLOAD_DIR = path.join(__dirname, "uploads");
const SCRAPED_DIR = path.join(__dirname, "scraped");
await fs.mkdir(PUBLIC_DIR, { recursive: true });
await fs.mkdir(UPLOAD_DIR, { recursive: true });
await fs.mkdir(SCRAPED_DIR, { recursive: true });

app.use(express.static(PUBLIC_DIR));
app.use("/uploads", express.static(UPLOAD_DIR));

// ---- Persistent data dir for sessions + sqlite ----
// This is relative to where node runs (ui/), matches db.js using process.cwd()/data
const DATA_DIR = path.join(process.cwd(), "data");
if (!fsSync.existsSync(DATA_DIR)) fsSync.mkdirSync(DATA_DIR, { recursive: true });

// ---- Sessions (persistent) ----
const SQLiteStore = SQLiteStoreFactory(session);

app.set("trust proxy", 1);

app.use(
  session({
    name: "sid",
    secret: process.env.SESSION_SECRET || "dev_only_change_me",
    resave: false,
    saveUninitialized: false,
    store: new SQLiteStore({
      dir: DATA_DIR,
      db: "sessions.sqlite",
    }),
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 1000 * 60 * 60 * 8, // 8 hours
    },
  })
);

// ---- Auth routes (public) ----
app.use("/api/auth", authRouter);

// ---- Admin API Routes ----
app.use("/api/admin", adminRoutes);

// ---- Config ----
const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";
const CHAT_MODEL = "gemma4:e4b";
const EMBED_MODEL = "nomic-embed-text";

// ===============================
// Open RAG SQLite
// ===============================
const rag = openRagDb();
console.log(`[ragdb] Using ${rag.DB_PATH}`);

// Server-local prepared statements for things ragdb.js doesn’t expose directly
const stmt = {
  // corpus stats by source_label
  corpusBySource: rag.db.prepare(`
    SELECT source_label AS source, COUNT(*) AS n
    FROM chunks
    GROUP BY source_label
    ORDER BY n DESC
  `),

  // chunk candidates (broad) - adjust LIMIT if you grow large
  fetchChunkCandidates: rag.db.prepare(`
    SELECT c.text, c.text_hash, c.source_label, c.href, c.page
    FROM chunks c
    LIMIT ?
  `),

  // chunk candidates filtered by standard base if user asks CIP-###
  fetchChunksForStandardBase: rag.db.prepare(`
    SELECT c.text, c.text_hash, c.source_label, c.href, c.page
    FROM chunks c
    JOIN documents d ON d.id = c.doc_id
    WHERE d.standard_base = ?
    LIMIT ?
  `),

};

// Bulk embedding lookup (uses ragdb helper)
function getEmbeddingsBulk(model, hashes) {
  return rag.getEmbeddingsBulk(model, hashes);
}

// ============================
// Tiny vector math + chunking
// ============================
function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}
function norm(a) {
  return Math.sqrt(dot(a, a));
}
function cosineSim(a, b) {
  const na = norm(a),
    nb = norm(b);
  return na && nb ? dot(a, b) / (na * nb) : 0;
}

// Header-friendly chunking (a bit smaller + more overlap)
function chunkText(txt, targetChars = 1000, overlap = 300) {
  const clean = (txt || "").replace(/\s+/g, " ").trim();
  const chunks = [];
  let i = 0;
  while (i < clean.length) {
    const end = Math.min(clean.length, i + targetChars);
    let chunk = clean.slice(i, end);

    // Prefer ending after Purpose:/period/semicolon if available
    const lastStop = Math.max(
      chunk.lastIndexOf(". "),
      chunk.lastIndexOf("; "),
      chunk.toLowerCase().lastIndexOf("purpose:")
    );
    if (end < clean.length && lastStop > targetChars * 0.5) {
      chunk = chunk.slice(0, lastStop + 1);
    }

    if (chunk.trim()) chunks.push(chunk);
    i += Math.max(chunk.length - overlap, 1);
  }
  return chunks;
}

// ===================
// Ollama embeddings
// ===================
async function embedTextSingle(text) {
  const resp = await fetch(`${OLLAMA_URL}/api/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: EMBED_MODEL, prompt: text }),
  });

  if (!resp.ok) {
    const msg = await resp.text().catch(() => resp.statusText);
    throw new Error(`Embeddings error: ${msg}`);
  }

  const data = await resp.json();
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

// Cache-aware embedding for texts using SQLite embeddings table
async function embedTextsWithDbCache(texts) {
  const results = new Array(texts.length);
  const misses = [];
  const missIdx = [];
  const missHashes = [];

  for (let i = 0; i < texts.length; i++) {
    const t = texts[i] || "";
    const h = rag.sha256Text(t);
    const cached = rag.getEmbeddingVector(h, EMBED_MODEL);
    if (Array.isArray(cached)) {
      results[i] = cached;
    } else {
      misses.push(t);
      missIdx.push(i);
      missHashes.push(h);
    }
  }

  if (misses.length) {
    const newVecs = await Promise.all(misses.map((t) => embedTextSingle(t)));
    for (let k = 0; k < missIdx.length; k++) {
      const i = missIdx[k];
      const h = missHashes[k];
      const vec = newVecs[k];
      results[i] = vec;
      rag.putEmbeddingVector(h, EMBED_MODEL, vec);
    }
  }

  return results;
}

// ===================
// Index public PDFs into SQLite
// ===================
async function indexPublicPDFs({ force = false } = {}) {
  const files = await fs.readdir(PUBLIC_DIR);
  const pdfs = files.filter((f) => f.toLowerCase().endsWith(".pdf"));

  let indexedDocs = 0;

  for (const pdfName of pdfs) {
    const filePath = path.join(PUBLIC_DIR, pdfName);
    const buf = await fs.readFile(filePath);

    // Upsert document row and standards mapping (based on filename)
    // Public docs don't need stored_as; we key them by filename.
    const doc = rag.upsertDocumentFromFile({
      origin: "public",
      stored_as: null,
      filename: pdfName,
      bytes: buf,
      mime_type: "application/pdf",
    });

    // If not forcing, skip reindex if sha unchanged and chunks exist
    if (!force) {
      const existingChunks = rag.countChunksForDoc(doc.id);
      if (existingChunks > 0) {
        // already indexed (and sha upserted). Good enough.
        continue;
      }
    }

    // Page-by-page extraction to get page boundaries
    const pages = [];
    await pdfParse(buf, {
      pagerender: (page) =>
        page.getTextContent().then((tc) => {
          const text = tc.items
            .map((item) => (item.str || ""))
            .join(" ")
            .replace(/\s+/g, " ")
            .trim();
          pages.push(text);
          return "";
        }),
    });

    // Build combined text + character offset → page number map
    const pageOffsets = [];
    let combinedText = "";
    for (let i = 0; i < pages.length; i++) {
      const t = (pages[i] || "").trim();
      if (!t) continue;
      const start = combinedText.length;
      combinedText += (combinedText.length > 0 ? " " : "") + t;
      pageOffsets.push({ start, end: combinedText.length, pageNum: i + 1 });
    }

    if (!combinedText.trim()) continue;

    // Chunk the COMBINED text (proper ~1000 char chunks with good context)
    const chunks = chunkText(combinedText, 1000, 300);
    if (!chunks.length) continue;

    // Helper: find which page a character offset falls on
    function getPageForOffset(charIdx) {
      for (const po of pageOffsets) {
        if (charIdx >= po.start && charIdx < po.end) return po.pageNum;
      }
      return pageOffsets.length > 0 ? pageOffsets[pageOffsets.length - 1].pageNum : 1;
    }

    // Embed and store chunks, tracking page for each
    const allChunkRows = [];
    const batchSize = 32;
    let searchFrom = 0;

    for (let i = 0; i < chunks.length; i += batchSize) {
      const slice = chunks.slice(i, i + batchSize);

      const textsForEmbedding =
        doc?.standard_base && doc?.versioned_id
          ? slice.map((t) => `${doc.standard_base} ${doc.versioned_id}\n${t}`)
          : slice;

      const vecs = await embedTextsWithDbCache(textsForEmbedding);

      for (let j = 0; j < slice.length; j++) {
        const text = slice[j];
        const text_hash = rag.sha256Text(
          (doc?.standard_base && doc?.versioned_id)
            ? `${doc.standard_base} ${doc.versioned_id}\n${text}`
            : text
        );

        if (!rag.getEmbeddingVector(text_hash, EMBED_MODEL)) {
          rag.putEmbeddingVector(text_hash, EMBED_MODEL, vecs[j]);
        }

        // Find where this chunk starts in combined text to determine its page
        const snippet = text.slice(0, 80);
        const chunkStart = combinedText.indexOf(snippet, searchFrom);
        const pageNum = chunkStart >= 0 ? getPageForOffset(chunkStart) : 1;
        if (chunkStart >= 0) searchFrom = chunkStart;

        allChunkRows.push({
          doc_id: doc.id,
          page: pageNum,
          chunk_index: i + j,
          text,
          text_hash,
          source_label: pdfName,
          href: `/${pdfName}#page=${pageNum}`,
        });
      }
    }

    rag.replaceDocumentChunks(doc.id, allChunkRows);

    indexedDocs++;
    console.log(`[index] Public ${pdfName}: ${allChunkRows.length} chunks, ${pages.length} pages`);
  }

  console.log(`[index] Public indexing done. Docs indexed this run: ${indexedDocs}`);
}

// Initial index pass (only missing docs)
await indexPublicPDFs({ force: false });

// ===============================
// API routes (JWT-protected where appropriate)
// ===============================

// Corpus stats (private)
app.get("/api/corpus", authenticateToken, async (_req, res) => {
  try {
    const rows = stmt.corpusBySource.all();
    const bySource = {};
    let total = 0;
    for (const r of rows) {
      bySource[r.source] = r.n;
      total += r.n;
    }
    res.json({ sources: bySource, totalChunks: total });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Reindex from /public PDFs (private)
app.post("/api/reindex", authenticateToken, async (_req, res) => {
  try {
    // Force reindex public docs (embeddings remain cached by text_hash)
    await indexPublicPDFs({ force: true });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ===============================
// Hybrid retrieval (cosine + keyword)
// ===============================
function normalize(s = "") {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

// Extract meaningful keywords from the user query (skip stopwords)
const STOPWORDS = new Set([
  "a","an","the","is","are","was","were","be","been","being","have","has","had",
  "do","does","did","will","would","shall","should","may","might","must","can","could",
  "i","me","my","we","our","you","your","he","she","it","they","them","their",
  "this","that","these","those","what","which","who","whom","where","when","why","how",
  "if","then","else","so","but","and","or","not","no","nor","for","to","of","in","on",
  "at","by","with","from","up","out","off","over","under","about","into","through",
  "during","before","after","above","below","between","all","each","every","any","some",
  "such","only","just","than","too","very","also","as","more","most","other","own",
  "same","both","either","neither","here","there","once","than","specific","requirements",
  "must","implemented","describe","explain","tell","provide","based","per","within",
]);

function extractKeywords(query) {
  return normalize(query)
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

function keywordScore(query, chunk) {
  const c = normalize(chunk);
  const queryKeywords = extractKeywords(query);

  let score = 0;
  for (const kw of queryKeywords) {
    if (c.includes(kw)) score += 1;
  }

  // Bonus for CIP identifiers mentioned in both query and chunk
  const cipIds = normalize(query).match(/cip[-\s]?\d{2,3}(?:[-\s]?\d+)?/g) || [];
  for (const id of cipIds) {
    const clean = id.replace(/\s+/g, "");
    if (c.includes(clean)) score += 3;
  }

  return score;
}

// Extract ALL CIP base standards from a query (handles both CIP-006 and CIP-006-6)
function extractCipBases(query) {
  const matches = (query || "").matchAll(/\bCIP[-\s]?(\d{1,3})(?:[-\s.]?\d+\w*)?/gi);
  const bases = new Set();
  for (const m of matches) {
    const num = String(m[1]).padStart(3, "0");
    bases.add(`CIP-${num}`);
  }
  return Array.from(bases);
}

// DB-backed retrieval
async function retrieveTopK(query, k = 8) {
  const q = query || "";
  const qNorm = normalize(q);

  // Embed query
  const qvec = await embedTextSingle(q);

  // Extract all CIP standards mentioned in the query
  const cipBases = extractCipBases(q);
  let candidates;

  if (cipBases.length === 1) {
    // Single standard — filtered search
    candidates = stmt.fetchChunksForStandardBase.all(cipBases[0], 2500);
  } else if (cipBases.length > 1) {
    // Multiple standards — fetch for each and merge
    const allCandidates = [];
    for (const base of cipBases) {
      const rows = stmt.fetchChunksForStandardBase.all(base, 1500);
      allCandidates.push(...rows);
    }
    // Deduplicate by text_hash
    const seen = new Set();
    candidates = allCandidates.filter((c) => {
      if (seen.has(c.text_hash)) return false;
      seen.add(c.text_hash);
      return true;
    });
  } else {
    // No CIP reference — broad search
    candidates = stmt.fetchChunkCandidates.all(2500);
  }

  // If filtered search returned too few results, supplement with broad search
  if (cipBases.length > 0 && candidates.length < 20) {
    const broad = stmt.fetchChunkCandidates.all(2500);
    const seen = new Set(candidates.map((c) => c.text_hash));
    for (const c of broad) {
      if (!seen.has(c.text_hash)) {
        candidates.push(c);
        seen.add(c.text_hash);
      }
    }
  }

  if (!candidates.length) {
    console.warn("[retrieve] No chunk candidates found at all.");
    return [];
  }

  console.log(`[retrieve] query: "${q.slice(0, 80)}..." | CIP bases: [${cipBases.join(", ")}] | candidates: ${candidates.length}`);

  // Bulk load embeddings for candidate hashes
  const hashes = candidates.map((c) => c.text_hash).filter(Boolean);
  const embMap = getEmbeddingsBulk(EMBED_MODEL, hashes);

  // Score candidates
  const scored = [];
  for (const c of candidates) {
    const vec = embMap.get(c.text_hash);
    if (!Array.isArray(vec) || !vec.length) continue;

    const cosBase = cosineSim(qvec, vec) || 0;
    let kw = keywordScore(q, c.text) || 0;

    // Boost if chunk's source label matches a mentioned standard
    const label = (c.source_label || "").toLowerCase();
    for (const base of cipBases) {
      if (label.includes(base.toLowerCase())) kw += 2;
    }

    const blended = cosBase * 0.6 + Math.min(kw, 10) * 0.4;
    scored.push({
      score: blended,
      chunk: c.text,
      source: c.source_label,
      href: c.href || null,
      page: c.page || null,
    });
  }

  scored.sort((a, b) => b.score - a.score);

  const topK = scored.slice(0, k);
  if (topK.length > 0) {
    console.log(`[retrieve] Top result: score=${topK[0].score.toFixed(3)} source="${topK[0].source}" chunk="${topK[0].chunk.slice(0, 60)}..."`);
  }
  return topK;
}

function buildSystemPrompt(chunks) {
  if (!chunks || chunks.length === 0) {
    return `You are a knowledgeable NERC-CIP compliance assistant. No reference documents were found for this query. Answer using your general knowledge of NERC-CIP standards, but note that your answer is from general knowledge rather than the indexed documents.`;
  }

  const contextBody = chunks
    .map(
      (c, i) => {
        const pageInfo = c.page ? `, p.${c.page}` : "";
        return `[${i + 1}] (${c.source}${pageInfo})\n${c.chunk}`;
      }
    )
    .join("\n---\n");

  return `You are an expert NERC-CIP compliance assistant. Below are excerpts from official NERC-CIP standard documents that are relevant to the user's question.

YOUR PRIMARY JOB: Read the documents carefully and answer the question using the information they contain. The answer IS in these documents — look for it thoroughly before concluding it is not there.

<documents>
${contextBody}
</documents>

Instructions:
- Answer directly using the document content above. Cite sources using the bracketed number shown before each excerpt, e.g. "[1]", "[3]". These numbers are clickable links for the user, so use them consistently.
- Each excerpt header shows the source file and page number. Use these citations so the user can find the exact location.
- Synthesize information across multiple sources when the question spans multiple standards.
- If a document discusses the topic but not the exact detail asked about, share what IS there and note what is missing.
- Use clear, professional language.
- Only say you cannot find information as an absolute last resort, after carefully checking every document above.`;
}

// ===============================
// Retrieval + streaming RAG chat (private)
// ===============================
app.post("/api/chat", authenticateToken, async (req, res) => {
  const { model = CHAT_MODEL, messages = [], temperature = 0.4, max_tokens } = req.body;

  const lastUser = [...messages].reverse().find((m) => m.role === "user")?.content || "";

  // DB-driven standard normalization (latest version mapping)
  const normalizedUser = rag.normalizeStandardsInQuery(lastUser);

  // Retrieve relevant chunks using the normalized query (more chunks for Gemma 4's larger context)
  let retrieved = [];
  try {
    retrieved = await retrieveTopK(normalizedUser, 8);
  } catch (e) {
    console.warn("Retrieve error:", e.message);
  }

  // Build ONE consolidated system message (Gemma 4 works best with a single system prompt)
  const systemMsg = { role: "system", content: buildSystemPrompt(retrieved) };

  console.log(`[chat] Retrieved ${retrieved.length} chunks for query: "${lastUser.slice(0, 80)}..."`);
  if (retrieved.length > 0) {
    console.log(`[chat] Sources: ${retrieved.map((r) => r.source).join(", ")}`);
  } else {
    console.warn("[chat] WARNING: No chunks retrieved — model will use general knowledge only");
  }

  // Strip any client-side system messages — server owns the system prompt
  const userAssistantMsgs = messages.filter((m) => m.role !== "system");

  const toSend = [systemMsg, ...userAssistantMsgs];

  const upstream = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: toSend,
      stream: true,
      options: {
        temperature,
        num_ctx: 16384,
        ...(Number.isFinite(max_tokens) ? { num_predict: Number(max_tokens) } : {}),
      },
      keep_alive: "1h",
    }),
  });

  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("X-Accel-Buffering", "no");

  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => "");
    res.status(502).end(text || "Upstream error");
    return;
  }

  try {
    for await (const chunk of upstream.body) res.write(chunk);
  } catch {
    // ignore midstream disconnects
  } finally {
    // Deduplicate sources by filename only (ignore #page= fragments)
    const seen = new Set();
    const sources = [];

    for (const r of retrieved) {
      if (!r) continue;
      const label = (r.source || "").replace(/\s+\(pseudopages\)$/, "");
      // Strip #page= from href for dedup key
      const baseHref = (r.href || "").replace(/#.*$/, "") || null;
      if (seen.has(label)) continue;
      seen.add(label);
      sources.push({ source: label, href: baseHref });
    }

    // Per-chunk mapping: [1] -> {source, href, page}, [2] -> ...
    const chunkMap = retrieved.map((r) => ({
      source: (r?.source || "").replace(/\s+\(pseudopages\)$/, ""),
      href: r?.href || null,
      page: r?.page || null,
    }));

    res.write(JSON.stringify({ done: true, sources, chunkMap }) + "\n");
    res.end();
  }
});

// ===============================
// #113 — Scraping pipeline
// ===============================
const scraper = new Scraper({
  downloadDir: SCRAPED_DIR,
  publicDir: PUBLIC_DIR,
  sources: (process.env.SCRAPE_SOURCES || "")
    .split(",")
    .filter(Boolean)
    .map((url) => ({ name: url, url: url.trim(), type: "html" }))
    .concat(
      // Default NERC source if no env override
      (process.env.SCRAPE_SOURCES ? [] : [
        {
          name: "NERC CIP Standards",
          url: "https://www.nerc.com/pa/Stand/Pages/CIPStandards.aspx",
          type: "html",
        },
      ])
    ),
  log: (...args) => console.log(...args),
});

/**
 * Ingest scraped PDFs into the RAG database.
 * Copies new files into public/ so indexPublicPDFs() picks them up,
 * then triggers a reindex.
 */
async function ingestScrapedFiles(downloadedFiles) {
  if (!downloadedFiles || downloadedFiles.length === 0) return [];

  const ingested = [];
  for (const file of downloadedFiles) {
    if (!file.path || file.status !== "downloaded") continue;
    try {
      const destPath = path.join(PUBLIC_DIR, file.filename);
      await fs.copyFile(file.path, destPath);
      ingested.push(file.filename);
      console.log(`[ingest] Copied scraped file to public/: ${file.filename}`);
    } catch (err) {
      console.error(`[ingest] Error copying ${file.filename}: ${err.message}`);
    }
  }

  if (ingested.length > 0) {
    console.log(`[ingest] Triggering reindex for ${ingested.length} new file(s)...`);
    await indexPublicPDFs({ force: false });
  }

  return ingested;
}

// Trigger scrape + ingest (admin only)
app.post(
  "/api/scrape",
  authenticateToken,
  requirePermission("docs:write"),
  async (req, res) => {
    try {
      const { url } = req.body || {};

      let result;
      if (url) {
        // Ad-hoc scrape from a specific URL
        const files = await scraper.scrapeUrl(url);
        const downloaded = files.filter((f) => f.status === "downloaded");
        const ingested = await ingestScrapedFiles(downloaded);
        result = {
          source: url,
          discovered: files.length,
          downloaded: downloaded.length,
          ingested,
        };
      } else {
        // Full pipeline from configured sources
        const pipelineResult = await scraper.run();
        const ingested = await ingestScrapedFiles(pipelineResult.downloaded);
        result = {
          discovered: pipelineResult.discovered,
          downloaded: pipelineResult.downloaded.length,
          unchanged: pipelineResult.unchanged,
          errors: pipelineResult.errors.length,
          ingested,
        };
      }

      res.json({ ok: true, ...result });
    } catch (e) {
      console.error("Scrape error:", e);
      res.status(500).json({ ok: false, error: e.message });
    }
  }
);

// Get scraper manifest / status
app.get(
  "/api/scrape/status",
  authenticateToken,
  requirePermission("docs:read"),
  async (_req, res) => {
    try {
      const manifest = await scraper.getManifest();
      res.json({ ok: true, ...manifest });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  }
);

// ===============================
// #114 — Document change watcher
// ===============================
const watcher = new DocumentWatcher({
  watchDirs: [PUBLIC_DIR, UPLOAD_DIR, SCRAPED_DIR],
  extensions: [".pdf", ".txt", ".md"],
  pollIntervalMs: Number(process.env.WATCH_INTERVAL_MS) || 5 * 60 * 1000,
  log: (...args) => console.log(...args),
  onChanges: async (report) => {
    console.log(
      `[watcher] Changes detected — added: ${report.added.length}, ` +
        `modified: ${report.modified.length}, removed: ${report.removed.length}`
    );

    // Auto-reindex if files in public/ or scraped/ changed
    const publicOrScrapedChanges = [...report.added, ...report.modified].filter(
      (f) => f.dir === PUBLIC_DIR || f.dir === SCRAPED_DIR
    );

    if (publicOrScrapedChanges.length > 0) {
      console.log(`[watcher] Auto-triggering reindex for ${publicOrScrapedChanges.length} changed file(s)...`);

      // Copy any scraped changes into public/
      for (const f of publicOrScrapedChanges) {
        if (f.dir === SCRAPED_DIR) {
          try {
            await fs.copyFile(
              path.join(SCRAPED_DIR, f.filename),
              path.join(PUBLIC_DIR, f.filename)
            );
          } catch (err) {
            console.error(`[watcher] Copy error for ${f.filename}: ${err.message}`);
          }
        }
      }

      try {
        await indexPublicPDFs({ force: true });
        console.log("[watcher] Reindex complete.");
      } catch (err) {
        console.error("[watcher] Reindex failed:", err.message);
      }
    }
  },
});

// Start watcher if not explicitly disabled
if (process.env.DISABLE_WATCHER !== "true") {
  watcher.start().catch((err) => {
    console.error("[watcher] Failed to start:", err.message);
  });
}

// Watcher status endpoint
app.get(
  "/api/watcher/status",
  authenticateToken,
  requirePermission("docs:read"),
  (_req, res) => {
    res.json({ ok: true, ...watcher.getStatus() });
  }
);

// Watcher history endpoint
app.get(
  "/api/watcher/history",
  authenticateToken,
  requirePermission("docs:read"),
  (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 10, 50);
    res.json({ ok: true, history: watcher.getHistory(limit) });
  }
);

// Manual trigger scan (admin only)
app.post(
  "/api/watcher/scan",
  authenticateToken,
  requirePermission("docs:write"),
  async (_req, res) => {
    try {
      const report = await watcher.scan();
      res.json({ ok: true, ...report });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  }
);

// ============
// Start server
// ============
app.listen(5173, () => {
  console.log(`UI running on http://localhost:5173`);
});