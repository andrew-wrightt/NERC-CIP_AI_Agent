import express from "express";
import fetch from "node-fetch";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs/promises";
import fsSync from "fs";
import pdfParse from "pdf-parse";
import { createHash } from "crypto";
import multer from "multer";

import session from "express-session";
import SQLiteStoreFactory from "connect-sqlite3";

import { authRouter } from "./auth/auth.routes.js";
import { requireAuth } from "./auth/auth.middleware.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());

// ---- Static folders ----
const PUBLIC_DIR = path.join(__dirname, "public");
const UPLOAD_DIR = path.join(__dirname, "uploads");
await fs.mkdir(PUBLIC_DIR, { recursive: true });
await fs.mkdir(UPLOAD_DIR, { recursive: true });

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

// ---- Config ----
const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";
const CHAT_MODEL = "mistral:instruct";
const EMBED_MODEL = "nomic-embed-text";

// === CACHE: persistent cache for embeddings of indexed documents ===
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
    console.log(
      `[cache] Loaded ${Object.keys(embedCache).length} vectors from ${path.basename(CACHE_PATH)}`
    );
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

async function embedTexts(texts) {
  return Promise.all(texts.map((t) => embedTextSingle(t)));
}

// Cache-aware embedding for corpus texts
async function embedTextsWithCache(texts) {
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
      embedCache[key] = vec; // persist in-memory
    }
  }

  return results;
}

// ===================
// Corpus management
// ===================
/**
 * corpus entries:
 * { chunk, source, href, embedding, meta?: { origin, filename, storedAs?, page?, chunkIndex? } }
 */
const corpus = [];

// Map like: { "CIP-005": { versions: ["CIP-005-3","CIP-005-6"], latest:"CIP-005-6", latestVersion:6 } }
const standardMap = Object.create(null);

/**
 * Parse a CIP filename like "CIP-005-6.pdf" and register it.
 * Returns { base, versioned } or null.
 */
function registerStandardFromFilename(pdfName) {
  // Accept things like CIP-5-3.pdf, CIP005-6.pdf, CIP 005-6.pdf, etc.
  const m = pdfName.match(/CIP[-\s]?(\d{1,3})[-\s]?(\d+)/i);
  if (!m) return null;

  const numRaw = m[1];
  const verRaw = m[2];
  const num = String(numRaw).padStart(3, "0"); // 5   -> "005"
  const versionNum = parseInt(verRaw, 10);

  const base = `CIP-${num}`; // e.g. CIP-005
  const versioned = `${base}-${versionNum}`; // e.g. CIP-005-6

  const existing = standardMap[base];
  if (!existing) {
    standardMap[base] = {
      versions: [versioned],
      latest: versioned,
      latestVersion: versionNum,
    };
  } else {
    if (!existing.versions.includes(versioned)) {
      existing.versions.push(versioned);
    }
    if (versionNum > existing.latestVersion) {
      existing.latest = versioned;
      existing.latestVersion = versionNum;
    }
  }

  return { base, versioned };
}

/**
 * Normalize user queries like "CIP-005" / "CIP 5" / "CIP005"
 * into: "CIP-005 (CIP-005-6)" so retrieval sees the versioned ID.
 */
function normalizeStandardsInQuery(question = "") {
  return question.replace(/\bCIP[-\s]?(\d{1,3})(?![-\s]?\d)\b/gi, (match, numRaw) => {
    const num = String(numRaw).padStart(3, "0"); // "5" -> "005"
    const base = `CIP-${num}`;
    const info = standardMap[base];
    if (!info || !info.latest) return match; // unknown base; leave alone
    return `${match} (${info.latest})`;
  });
}

// Build an index of uploaded files from the in-memory corpus
function listUploadedFromCorpus() {
  const byStored = new Map(); // storedAs -> { filename, storedAs, pages:Set, href }
  for (const c of corpus) {
    if (c?.meta?.origin !== "upload") continue;
    const { filename, storedAs, page } = c.meta || {};
    if (!storedAs || !filename) continue;
    if (!byStored.has(storedAs)) {
      byStored.set(storedAs, {
        filename,
        storedAs,
        href: `/uploads/${storedAs}`,
        pages: new Set(),
      });
    }
    if (Number.isFinite(page)) byStored.get(storedAs).pages.add(page);
  }
  return Array.from(byStored.values()).map((x) => ({
    filename: x.filename,
    storedAs: x.storedAs,
    href: x.href,
    pages: x.pages.size || null,
  }));
}

// Remove all corpus chunks belonging to a stored upload
function removeUploadFromCorpus(storedAs) {
  let removed = 0;
  for (let i = corpus.length - 1; i >= 0; i--) {
    const m = corpus[i]?.meta;
    if (m?.origin === "upload" && m?.storedAs === storedAs) {
      corpus.splice(i, 1);
      removed++;
    }
  }
  return removed;
}

// Very defensive filename guard (no path traversal)
function isSafeStoredName(name) {
  return typeof name === "string" && /^[A-Za-z0-9._-]+$/.test(name);
}

// FAST, reliable: index public PDFs as a single text stream (ensures server starts)
async function indexPublicPDFs() {
  // rebuild just the public part; keep uploads intact if you want
  for (let i = corpus.length - 1; i >= 0; i--) {
    if (corpus[i]?.meta?.origin === "public") corpus.splice(i, 1);
  }

  const files = await fs.readdir(PUBLIC_DIR);
  const pdfs = files.filter((f) => f.toLowerCase().endsWith(".pdf"));

  for (const pdfName of pdfs) {
    const filePath = path.join(PUBLIC_DIR, pdfName);

    // register this PDF as a CIP standard version if it matches the pattern
    const stdInfo = registerStandardFromFilename(pdfName); // { base, versioned } or null

    const buf = await fs.readFile(filePath);
    const parsed = await pdfParse(buf);
    const chunks = chunkText(parsed.text || "");
    if (!chunks.length) continue;

    const batchSize = 32;
    for (let i = 0; i < chunks.length; i += batchSize) {
      const slice = chunks.slice(i, i + batchSize);

      // inject aliases into embedded text
      const textsForEmbedding = stdInfo
        ? slice.map((t) => `${stdInfo.base} ${stdInfo.versioned}\n${t}`)
        : slice;

      const vecs = await embedTextsWithCache(textsForEmbedding);

      for (let j = 0; j < slice.length; j++) {
        corpus.push({
          chunk: slice[j],
          source: `${pdfName} (pseudopages)`,
          href: `/${pdfName}`,
          embedding: vecs[j],
          meta: {
            filename: pdfName,
            origin: "public",
            chunkIndex: i + j,
            ...(stdInfo
              ? {
                  standardBase: stdInfo.base,
                  standardVersion: stdInfo.versioned,
                }
              : {}),
          },
        });
      }
    }

    console.log(`Indexed ${pdfName}: ${chunks.length} chunks`);
    await saveEmbedCache();
  }

  console.log(`Total chunks indexed (public): ${corpus.length}`);
}

// Load cache and initial index
await loadEmbedCache();
await indexPublicPDFs();

// ==============
// Multer upload
// ==============
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const safe = `${Date.now()}-${file.originalname.replace(/[^\w.\-]+/g, "_")}`;
    cb(null, safe);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB
  fileFilter: (_req, file, cb) => {
    const ext = (file.originalname.split(".").pop() || "").toLowerCase();
    const ok = ["pdf", "txt", "md"].includes(ext);
    if (ok) cb(null, true);
    else cb(null, false);
  },
});

// Page-aware extraction ONLY for uploads
async function extractUploadedFilePages(absPath, mimetype, originalname) {
  const buf = await fs.readFile(absPath);
  const ext = (originalname.split(".").pop() || "").toLowerCase();
  const isPDF = mimetype === "application/pdf" || ext === "pdf";
  const isTXT = mimetype.startsWith("text/") || ext === "txt" || ext === "md";

  if (isPDF) {
    const pages = [];
    await pdfParse(buf, {
      pagerender: (page) =>
        page.getTextContent().then((tc) => {
          const text = tc.items
            .map((i) => (i.str || ""))
            .join(" ")
            .replace(/\s+/g, " ")
            .trim();
          pages.push(text);
          return "";
        }),
    });

    const out = [];
    for (let i = 0; i < pages.length; i++) {
      let t = (pages[i] || "").trim();
      if (!t) continue;
      t = t.replace(/(Purpose\s*:)(\s*)/i, "$1 ");
      out.push({ page: i + 1, text: t });
    }
    if (out.length) return out;

    const parsed = await pdfParse(buf);
    return [{ page: 1, text: parsed.text || "" }];
  }

  if (isTXT) {
    const txt = buf.toString("utf8");
    return [{ page: 1, text: txt }];
  }

  throw new Error("Unsupported file type");
}

// ===============================
// Protect most API routes
// ===============================

// Corpus by source (private)
app.get("/api/corpus", requireAuth, (_req, res) => {
  const bySource = corpus.reduce((m, c) => {
    m[c.source] = (m[c.source] || 0) + 1;
    return m;
  }, {});
  res.json({ sources: bySource, totalChunks: corpus.length });
});

// Upload & index (private)
app.post(
  "/api/upload",
  requireAuth,
  upload.fields([{ name: "files", maxCount: 20 }, { name: "file", maxCount: 20 }]),
  async (req, res) => {
    try {
      console.log("headers:", req.headers["content-type"]);
      console.log("body keys:", Object.keys(req.body || {}));
      console.log("raw files obj keys:", req.files ? Object.keys(req.files) : []);

      const files = [...(req.files?.files || []), ...(req.files?.file || [])];

      if (files.length === 0) {
        return res.status(400).json({ ok: false, error: "No files received" });
      }

      const results = [];
      for (const f of files) {
        const pages = await extractUploadedFilePages(
          f.path,
          f.mimetype || "application/octet-stream",
          f.originalname
        );

        for (const { page, text } of pages) {
          const chunks = chunkText(text, 1000, 300).filter(Boolean);
          const vecs = await embedTextsWithCache(chunks);

          for (let i = 0; i < chunks.length; i++) {
            corpus.push({
              chunk: chunks[i],
              source: `${f.originalname} p.${page}`,
              href: `/uploads/${f.filename}#page=${page}`,
              embedding: vecs[i],
              meta: {
                filename: f.originalname,
                storedAs: f.filename,
                uploadedAt: new Date().toISOString(),
                origin: "upload",
                page,
                chunkIndex: i,
              },
            });
          }
        }

        results.push({ file: f.originalname });
        console.log(`Uploaded & indexed ${f.originalname}`);
      }

      await saveEmbedCache();
      res.json({ ok: true, indexed: results, totalChunks: corpus.length });
    } catch (e) {
      console.error("upload handler error:", e);
      res.status(500).json({ ok: false, error: e.message });
    }
  }
);

// List uploaded files (private)
app.get("/api/uploads", requireAuth, async (_req, res) => {
  try {
    const items = listUploadedFromCorpus();
    res.json({ ok: true, uploads: items, totalUploads: items.length });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Delete an uploaded file (private)
app.delete("/api/uploads/:storedAs", requireAuth, async (req, res) => {
  try {
    const storedAs = req.params.storedAs;

    if (!isSafeStoredName(storedAs)) {
      return res.status(400).json({ ok: false, error: "Invalid file id" });
    }

    const listed = listUploadedFromCorpus();
    const found = listed.find((x) => x.storedAs === storedAs);
    if (!found) {
      return res.status(404).json({ ok: false, error: "Upload not found" });
    }

    const removedChunks = removeUploadFromCorpus(storedAs);

    const abs = path.join(UPLOAD_DIR, storedAs);
    try {
      await fs.unlink(abs);
    } catch {}

    await saveEmbedCache();
    res.json({ ok: true, removedChunks, removedFile: storedAs, totalChunks: corpus.length });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Reindex from /public PDFs (private)
app.post("/api/reindex", requireAuth, async (_req, res) => {
  try {
    await indexPublicPDFs();
    await saveEmbedCache();
    res.json({ ok: true, chunks: corpus.length });
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
function keywordScore(query, chunk) {
  const q = normalize(query);
  const c = normalize(chunk);

  const keys = [];
  const idMatch = q.match(/cip[-\s]?0?\d{2}(-\d+)?/g);
  if (idMatch) keys.push(...idMatch.map((x) => x.replace(/\s+/g, "")));
  keys.push(
    "purpose",
    "objective",
    "to protect",
    "confidentiality",
    "integrity",
    "communications between control centers"
  );

  let score = 0;
  for (const k of keys) if (k && c.includes(k)) score += 1;
  if (/\bpurpose\s*:/.test(c)) score += 3;
  return score;
}

async function retrieveTopK(query, k = 6) {
  if (!corpus.length) return [];
  const q = query || "";
  const qNorm = normalize(q);

  const [qvec] = await embedTexts([q]);

  const scored = corpus
    .filter((c) => Array.isArray(c.embedding) && c.embedding.length)
    .map((c, idx) => {
      const cosBase = cosineSim(qvec, c.embedding) || 0;
      let kw = keywordScore(q, c.chunk) || 0;

      const fname = (c.meta?.filename || "").toLowerCase();
      const sourceLabel = (c.source || "").toLowerCase();

      let filenameBoost = 0;
      if (fname && qNorm.includes(fname)) filenameBoost += 5;
      if (sourceLabel && qNorm.includes(sourceLabel)) filenameBoost += 3;

      kw += filenameBoost;

      const blended = cosBase * 0.7 + Math.min(kw, 6) * 0.3;
      return { idx, cos: cosBase, kw, score: blended };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, k);

  if (!scored.some((s) => s.kw > 0)) {
    const id = (q.match(/cip[-\s]?0?\d{2}(-\d+)?/i) || [])[0];
    if (id) {
      const normId = id.toLowerCase().replace(/\s+/g, "");
      const exacts = [];
      for (let i = 0; i < corpus.length; i++) {
        const c = normalize(corpus[i].chunk).replace(/\s+/g, "");
        if (c.includes(normId)) exacts.push({ idx: i, score: 1e6 });
      }
      if (exacts.length) return exacts.slice(0, k).map((e) => corpus[e.idx]);
    }
  }

  return scored.map((s) => corpus[s.idx]);
}

function buildContextBlock(chunks) {
  const header = `You are an assistant that must answer **only** using the CONTEXT below.
If the answer is not present in the context, say:
"I don't know based on the provided documents."

CONTEXT BEGIN
`;
  const body = chunks
    .map(
      (c, i) => `[${i + 1}] Source: ${c.source}
${c.chunk}
`
    )
    .join("\n---\n");
  const footer = "\nCONTEXT END\n";
  return header + body + footer;
}

// ===============================
// Retrieval + streaming RAG chat (private)
// ===============================
app.post("/api/chat", requireAuth, async (req, res) => {
  const { model = CHAT_MODEL, messages = [], temperature = 0.3, max_tokens } = req.body;

  const lastUser = [...messages].reverse().find((m) => m.role === "user")?.content || "";

  const normalizedUser = normalizeStandardsInQuery(lastUser);

  let retrieved = [];
  try {
    retrieved = await retrieveTopK(normalizedUser, 6);
  } catch (e) {
    console.warn("Retrieve error:", e.message);
  }

  const contextMsg = { role: "system", content: buildContextBlock(retrieved) };
  const guardrailsMsg = {
    role: "system",
    content:
      "If the user's request is outside the supplied CONTEXT, reply: 'I don't know based on the provided documents.'",
  };

  const toSend = [guardrailsMsg, contextMsg, ...messages];

  const upstream = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: toSend,
      stream: true,
      options: {
        temperature,
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
    const seen = new Set();
    const sources = [];

    for (const r of retrieved) {
      if (!r) continue;
      const label = (r.source || "").replace(/\s+\(pseudopages\)$/, "");
      const href = r.href || null;
      const key = `${label}|${href || ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      sources.push({ source: label, href });
    }

    res.write(JSON.stringify({ done: true, sources }) + "\n");
    res.end();
  }
});

// ============
// Start server
// ============
app.listen(5173, () => {
  console.log(`UI running on http://localhost:5173`);
});

// Save cache on shutdown
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, async () => {
    await saveEmbedCache();
    process.exit(0);
  });
}
