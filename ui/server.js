// ui/server.js
import express from "express";
import fetch from "node-fetch";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs/promises";
import fsSync from "fs";
import pdfParse from "pdf-parse";
import multer from "multer";

// Admin / Auth
import session from "express-session";
import SQLiteStoreFactory from "connect-sqlite3";
import { authRouter } from "./auth/auth.routes.js";
import adminRoutes, { authenticateToken, requirePermission } from "./adminRoutes.js";

// RAG DB (documents/standards/chunks/embeddings)
import { openRagDb } from "./ragdb.js";

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

// ---- Admin API Routes ----
app.use("/api/admin", adminRoutes);

// ---- Config ----
const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";
const CHAT_MODEL = "mistral:instruct";
const EMBED_MODEL = "nomic-embed-text";

// ===============================
// Open RAG SQLite
// ===============================
const rag = openRagDb();
console.log(`[ragdb] Using ${rag.DB_PATH}`);

// Server-local prepared statements for things ragdb.js doesn’t expose directly
const stmt = {
  // list uploads = docs with origin upload
  listUploadDocs: rag.db.prepare(
    `SELECT id, filename, stored_as FROM documents WHERE origin='upload' ORDER BY updated_at DESC`
  ),
  // count distinct pages in chunks for a doc (uploads)
  countPagesForDoc: rag.db.prepare(
    `SELECT COUNT(DISTINCT page) AS n FROM chunks WHERE doc_id=? AND page IS NOT NULL`
  ),
  // find upload doc by stored name
  getUploadDocByStored: rag.db.prepare(
    `SELECT * FROM documents WHERE origin='upload' AND stored_as=? LIMIT 1`
  ),
  // delete a doc (cascades chunks)
  deleteDocById: rag.db.prepare(`DELETE FROM documents WHERE id=?`),

  // corpus stats by source_label
  corpusBySource: rag.db.prepare(`
    SELECT source_label AS source, COUNT(*) AS n
    FROM chunks
    GROUP BY source_label
    ORDER BY n DESC
  `),

  // chunk candidates (broad) - adjust LIMIT if you grow large
  fetchChunkCandidates: rag.db.prepare(`
    SELECT c.text, c.text_hash, c.source_label, c.href
    FROM chunks c
    LIMIT ?
  `),

  // chunk candidates filtered by standard base if user asks CIP-###
  fetchChunksForStandardBase: rag.db.prepare(`
    SELECT c.text, c.text_hash, c.source_label, c.href
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

    const parsed = await pdfParse(buf);
    const chunks = chunkText(parsed.text || "");
    if (!chunks.length) continue;

    // Prepare chunk rows
    const batchSize = 32;
    const allChunkRows = [];

    for (let i = 0; i < chunks.length; i += batchSize) {
      const slice = chunks.slice(i, i + batchSize);

      // For CIP docs, help embeddings see both base and version
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

        // Ensure embedding exists (vecs already generated, but store under same hash)
        if (!rag.getEmbeddingVector(text_hash, EMBED_MODEL)) {
          rag.putEmbeddingVector(text_hash, EMBED_MODEL, vecs[j]);
        }

        allChunkRows.push({
          doc_id: doc.id,
          page: null, // public pseudopages
          chunk_index: i + j,
          text,
          text_hash,
          source_label: `${pdfName} (pseudopages)`,
          href: `/${pdfName}`,
        });
      }
    }

    rag.replaceDocumentChunks(doc.id, allChunkRows);

    indexedDocs++;
    console.log(`[index] Public ${pdfName}: ${allChunkRows.length} chunks`);
  }

  console.log(`[index] Public indexing done. Docs indexed this run: ${indexedDocs}`);
}

// Initial index pass (only missing docs)
await indexPublicPDFs({ force: false });

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

// Upload & index (admins only)
app.post(
  "/api/upload",
  authenticateToken,
  requirePermission("docs:write"),
  upload.fields([{ name: "files", maxCount: 20 }, { name: "file", maxCount: 20 }]),
  async (req, res) => {
    try {
      const files = [...(req.files?.files || []), ...(req.files?.file || [])];
      if (files.length === 0) {
        return res.status(400).json({ ok: false, error: "No files received" });
      }

      const results = [];
      for (const f of files) {
        // Read file bytes (for hashing + doc registry)
        const abs = path.join(UPLOAD_DIR, f.filename);
        const bytes = await fs.readFile(abs);

        // Upsert document row
        const doc = rag.upsertDocumentFromFile({
          origin: "upload",
          stored_as: f.filename,
          filename: f.originalname,
          bytes,
          mime_type: f.mimetype || "application/octet-stream",
        });

        const pages = await extractUploadedFilePages(
          f.path,
          f.mimetype || "application/octet-stream",
          f.originalname
        );

        const allChunkRows = [];

        for (const { page, text } of pages) {
          const chunks = chunkText(text, 1000, 300).filter(Boolean);
          if (!chunks.length) continue;

          const vecs = await embedTextsWithDbCache(chunks);

          for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i];
            const text_hash = rag.sha256Text(chunk);

            // ensure embedding stored
            if (!rag.getEmbeddingVector(text_hash, EMBED_MODEL)) {
              rag.putEmbeddingVector(text_hash, EMBED_MODEL, vecs[i]);
            }

            allChunkRows.push({
              doc_id: doc.id,
              page,
              chunk_index: i,
              text: chunk,
              text_hash,
              source_label: `${f.originalname} p.${page}`,
              href: `/uploads/${f.filename}#page=${page}`,
            });
          }
        }

        // Replace chunks for this doc
        rag.replaceDocumentChunks(doc.id, allChunkRows);

        results.push({ file: f.originalname, chunks: allChunkRows.length });
        console.log(`[upload] Indexed ${f.originalname}: ${allChunkRows.length} chunks`);
      }

      res.json({ ok: true, indexed: results });
    } catch (e) {
      console.error("upload handler error:", e);
      res.status(500).json({ ok: false, error: e.message });
    }
  }
);

// List uploaded files (private)
app.get("/api/uploads", authenticateToken, requirePermission("docs:read"), async (_req, res) => {
  try {
    const docs = stmt.listUploadDocs.all();
    const uploads = docs.map((d) => {
      const pages = stmt.countPagesForDoc.get(d.id)?.n ?? null;
      return {
        filename: d.filename,
        storedAs: d.stored_as,
        href: `/uploads/${d.stored_as}`,
        pages: pages || null,
      };
    });
    res.json({ ok: true, uploads, totalUploads: uploads.length });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Delete an uploaded file (private, admin only)
app.delete(
  "/api/uploads/:storedAs",
  authenticateToken,
  requirePermission("docs:delete"),
  async (req, res) => {
    try {
      const storedAs = req.params.storedAs;

      // defensive filename guard
      if (typeof storedAs !== "string" || !/^[A-Za-z0-9._-]+$/.test(storedAs)) {
        return res.status(400).json({ ok: false, error: "Invalid file id" });
      }

      const doc = stmt.getUploadDocByStored.get(storedAs);
      if (!doc) return res.status(404).json({ ok: false, error: "Upload not found" });

      // delete disk file
      const abs = path.join(UPLOAD_DIR, storedAs);
      try {
        await fs.unlink(abs);
      } catch {}

      // delete doc row (cascades chunks)
      stmt.deleteDocById.run(doc.id);

      res.json({ ok: true, removedFile: storedAs });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  }
);

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
function keywordScore(query, chunk) {
  const q = normalize(query);
  const c = normalize(chunk);

  const keys = [];
  const idMatch = q.match(/cip[-\s]?0?\d{2,3}(-\d+)?/g);
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

// DB-backed retrieval
async function retrieveTopK(query, k = 6) {
  const q = query || "";
  const qNorm = normalize(q);

  // Embed query
  const qvec = await embedTextSingle(q);

  // If user mentions a base standard (CIP-005), pull candidates only for that base
  const baseMatch = q.match(/\bCIP[-\s]?(\d{1,3})(?![-\s]?\d)\b/i);
  let candidates;

  if (baseMatch) {
    const num = String(baseMatch[1]).padStart(3, "0");
    const base = `CIP-${num}`;
    candidates = stmt.fetchChunksForStandardBase.all(base, 2500);
  } else {
    candidates = stmt.fetchChunkCandidates.all(2500);
  }

  if (!candidates.length) return [];

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

    // mild boost if user mentions label-ish strings
    const label = (c.source_label || "").toLowerCase();
    if (label && qNorm.includes(label)) kw += 2;

    const blended = cosBase * 0.7 + Math.min(kw, 6) * 0.3;
    scored.push({
      score: blended,
      chunk: c.text,
      source: c.source_label,
      href: c.href || null,
    });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k);
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
app.post("/api/chat", authenticateToken, async (req, res) => {
  const { model = CHAT_MODEL, messages = [], temperature = 0.3, max_tokens } = req.body;

  const lastUser = [...messages].reverse().find((m) => m.role === "user")?.content || "";

  // DB-driven standard normalization (latest version mapping)
  const normalizedUser = rag.normalizeStandardsInQuery(lastUser);

  // Retrieve relevant chunks using the normalized query
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
    // Deduplicate sources so each PDF appears only once
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