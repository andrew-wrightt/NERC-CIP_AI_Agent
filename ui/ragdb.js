// ui/ragdb.js
import Database from "better-sqlite3";
import path from "path";
import fsSync from "fs";
import { createHash, randomUUID } from "crypto";

function sha256(bufOrStr) {
  return createHash("sha256").update(bufOrStr).digest("hex");
}

export function openRagDb() {
  // With your docker volume, this maps to ui/data on the host
  const DATA_DIR = path.join(process.cwd(), "data");
  if (!fsSync.existsSync(DATA_DIR)) fsSync.mkdirSync(DATA_DIR, { recursive: true });

  const DB_PATH = path.join(DATA_DIR, "rag.sqlite");
  const db = new Database(DB_PATH);

  console.log(`[ragdb] Using ${DB_PATH}`);

  // Safer concurrency behavior
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  // Schema
  // Key tweaks vs your version:
  // - stored_as is nullable (public docs can leave it null or reuse filename)
  // - add updated_at defaults where possible
  db.exec(`
    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY,
      origin TEXT NOT NULL,                 -- 'public' | 'upload'
      stored_as TEXT,                       -- filename on disk (uploads); optional for public
      filename TEXT NOT NULL,               -- display name (original for uploads)
      sha256 TEXT NOT NULL,
      mime_type TEXT,
      size_bytes INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,

      standard_base TEXT,                   -- e.g. 'CIP-005'
      standard_version INTEGER,             -- e.g. 6
      versioned_id TEXT                     -- e.g. 'CIP-005-6'
    );

    -- unique identity for a document within an origin
    CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_unique
    ON documents(origin, COALESCE(stored_as, filename));

    CREATE INDEX IF NOT EXISTS idx_documents_std
    ON documents(standard_base, standard_version);

    CREATE TABLE IF NOT EXISTS standards (
      standard_base TEXT PRIMARY KEY,
      latest_version INTEGER NOT NULL,
      latest_versioned_id TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      doc_id TEXT NOT NULL,
      page INTEGER,                         -- nullable for public pseudopages
      chunk_index INTEGER NOT NULL,
      text TEXT NOT NULL,
      text_hash TEXT NOT NULL,
      source_label TEXT NOT NULL,           -- displayed citation label
      href TEXT,                            -- link to pdf or uploads/#page

      FOREIGN KEY(doc_id) REFERENCES documents(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_chunks_doc
    ON chunks(doc_id, page, chunk_index);

    CREATE INDEX IF NOT EXISTS idx_chunks_hash
    ON chunks(text_hash);

    CREATE TABLE IF NOT EXISTS embeddings (
      text_hash TEXT NOT NULL,
      model TEXT NOT NULL,
      dims INTEGER NOT NULL,
      vector_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(text_hash, model)
    );
  `);

  // Prepared statements
  const stmt = {
    // documents
    getDocByOriginKey: db.prepare(`
      SELECT * FROM documents
      WHERE origin = ? AND COALESCE(stored_as, filename) = ?
      LIMIT 1
    `),

    upsertDoc: db.prepare(`
      INSERT INTO documents (
        id, origin, stored_as, filename, sha256, mime_type, size_bytes,
        created_at, updated_at, standard_base, standard_version, versioned_id
      ) VALUES (
        @id, @origin, @stored_as, @filename, @sha256, @mime_type, @size_bytes,
        @created_at, @updated_at, @standard_base, @standard_version, @versioned_id
      )
      ON CONFLICT(id) DO UPDATE SET
        origin=excluded.origin,
        stored_as=excluded.stored_as,
        filename=excluded.filename,
        sha256=excluded.sha256,
        mime_type=excluded.mime_type,
        size_bytes=excluded.size_bytes,
        updated_at=excluded.updated_at,
        standard_base=excluded.standard_base,
        standard_version=excluded.standard_version,
        versioned_id=excluded.versioned_id
    `),

    // standards
    getStandard: db.prepare(`SELECT * FROM standards WHERE standard_base = ? LIMIT 1`),
    upsertStandard: db.prepare(`
      INSERT INTO standards (standard_base, latest_version, latest_versioned_id, updated_at)
      VALUES (@standard_base, @latest_version, @latest_versioned_id, @updated_at)
      ON CONFLICT(standard_base) DO UPDATE SET
        latest_version=excluded.latest_version,
        latest_versioned_id=excluded.latest_versioned_id,
        updated_at=excluded.updated_at
    `),

    // chunks
    deleteChunksForDoc: db.prepare(`DELETE FROM chunks WHERE doc_id = ?`),
    insertChunk: db.prepare(`
      INSERT INTO chunks (doc_id, page, chunk_index, text, text_hash, source_label, href)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `),
    countChunksForDoc: db.prepare(`SELECT COUNT(*) AS n FROM chunks WHERE doc_id = ?`),

    // embeddings
    getEmbedding: db.prepare(`
      SELECT vector_json, dims
      FROM embeddings
      WHERE text_hash = ? AND model = ?
      LIMIT 1
    `),

    insertEmbedding: db.prepare(`
      INSERT OR REPLACE INTO embeddings (text_hash, model, dims, vector_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `),

    // retrieval helpers
    findChunksByKeyword: db.prepare(`
      SELECT c.id, c.doc_id, c.page, c.chunk_index, c.text, c.text_hash, c.source_label, c.href,
             d.filename, d.origin, d.standard_base, d.versioned_id
      FROM chunks c
      JOIN documents d ON d.id = c.doc_id
      WHERE c.text LIKE ?
      LIMIT ?
    `),

    listDocs: db.prepare(`
      SELECT id, origin, stored_as, filename, sha256, standard_base, standard_version, versioned_id, created_at, updated_at
      FROM documents
      ORDER BY origin ASC, filename ASC
    `),
  };

  // Transaction wrapper for chunk replacement
  const txReplaceDocChunks = db.transaction((docId, chunkRows) => {
    stmt.deleteChunksForDoc.run(docId);
    for (const r of chunkRows) {
      stmt.insertChunk.run(
        r.doc_id,
        r.page ?? null,
        r.chunk_index,
        r.text,
        r.text_hash,
        r.source_label,
        r.href ?? null
      );
    }
  });

  // Helper: bulk fetch embeddings for a set of hashes for a given model
  function getEmbeddingsBulk(model, hashes) {
    const uniq = Array.from(new Set((hashes || []).filter(Boolean)));
    if (uniq.length === 0) return new Map();

    const placeholders = uniq.map(() => "?").join(",");
    const q = `
      SELECT text_hash, vector_json
      FROM embeddings
      WHERE model = ?
        AND text_hash IN (${placeholders})
    `;
    const rows = db.prepare(q).all(model, ...uniq);
    const out = new Map();

    for (const r of rows) {
      try {
        const vec = JSON.parse(r.vector_json);
        if (Array.isArray(vec)) out.set(r.text_hash, vec);
      } catch {
        // ignore bad rows
      }
    }
    return out;
  }

  return {
    db,
    DB_PATH,

    sha256Text: (text) => sha256(String(text ?? "")),
    sha256Bytes: (buf) => sha256(buf),

    // ---- standards parsing / mapping
    parseCipFromFilename(pdfName) {
      const m = String(pdfName).match(/CIP[-\s]?(\d{1,3})[-\s]?(\d+)/i);
      if (!m) return null;
      const num = String(m[1]).padStart(3, "0");
      const versionNum = parseInt(m[2], 10);
      const standard_base = `CIP-${num}`;
      const versioned_id = `${standard_base}-${versionNum}`;
      return { standard_base, standard_version: versionNum, versioned_id };
    },

    upsertStandardLatest(standard_base, standard_version, versioned_id) {
      const now = new Date().toISOString();
      const existing = stmt.getStandard.get(standard_base);
      if (!existing || standard_version > existing.latest_version) {
        stmt.upsertStandard.run({
          standard_base,
          latest_version: standard_version,
          latest_versioned_id: versioned_id,
          updated_at: now,
        });
      }
    },

    normalizeStandardsInQuery(question = "") {
      return String(question).replace(
        /\bCIP[-\s]?(\d{1,3})(?![-\s]?\d)\b/gi,
        (match, numRaw) => {
          const num = String(numRaw).padStart(3, "0");
          const base = `CIP-${num}`;
          const row = stmt.getStandard.get(base);
          if (!row?.latest_versioned_id) return match;
          return `${match} (${row.latest_versioned_id})`;
        }
      );
    },

    // ---- documents
    upsertDocumentFromFile({ origin, stored_as = null, filename, bytes, mime_type = null }) {
  const now = new Date().toISOString();

  // Always store a non-null stored_as to support older DB schemas that had NOT NULL.
  // For public docs, stored_as == filename is totally fine.
  const storedAsEffective = stored_as ?? filename;
  const key = storedAsEffective; // matches getDocByOriginKey COALESCE(stored_as, filename)

  const meta = {
    id: randomUUID(),
    origin,
    stored_as: storedAsEffective,
    filename,
    sha256: sha256(bytes),
    mime_type,
    size_bytes: bytes?.length ?? null,
    created_at: now,
    updated_at: now,
    standard_base: null,
    standard_version: null,
    versioned_id: null,
  };

  // If public CIP file, parse CIP-XXX-V
  const cip = origin === "public" ? this.parseCipFromFilename(filename) : null;
  if (cip) {
    meta.standard_base = cip.standard_base;
    meta.standard_version = cip.standard_version;
    meta.versioned_id = cip.versioned_id;
  }

  // If already exists, keep its id + created_at stable
  const existing = stmt.getDocByOriginKey.get(origin, key);
  if (existing?.id) {
    meta.id = existing.id;
    meta.created_at = existing.created_at;
  }

  stmt.upsertDoc.run(meta);

  if (cip) this.upsertStandardLatest(cip.standard_base, cip.standard_version, cip.versioned_id);

  return stmt.getDocByOriginKey.get(origin, key);
},

    listDocuments() {
      return stmt.listDocs.all();
    },

    // ---- chunks
    replaceDocumentChunks(docId, chunkRows) {
      txReplaceDocChunks(docId, chunkRows);
    },

    countChunksForDoc(docId) {
      return stmt.countChunksForDoc.get(docId)?.n ?? 0;
    },

    // ---- embeddings
    getEmbeddingVector(text_hash, model) {
      const row = stmt.getEmbedding.get(text_hash, model);
      if (!row) return null;
      try {
        const vec = JSON.parse(row.vector_json);
        return Array.isArray(vec) ? vec : null;
      } catch {
        return null;
      }
    },

    getEmbeddingsBulk, // <— important for speed

    putEmbeddingVector(text_hash, model, vector) {
      const now = new Date().toISOString();
      const dims = Array.isArray(vector) ? vector.length : 0;
      stmt.insertEmbedding.run(text_hash, model, dims, JSON.stringify(vector), now);
    },

    // ---- retrieval helper (optional)
    findChunksLikeText(substr, limit = 50) {
      return stmt.findChunksByKeyword.all(`%${substr}%`, limit);
    },
  };
}