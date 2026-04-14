// ui/watcher.js
// =========================
// #114 — Detect document changes
// =========================
// Monitors configured directories for new, modified, or deleted PDFs.
// When changes are detected, triggers re-ingestion into the RAG pipeline.
// Supports both polling-based checks and on-demand scans.
// =========================

import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import { createHash } from "crypto";

function sha256File(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

/**
 * Snapshot of a single file's metadata + content hash.
 * @typedef {{ filename: string, size: number, mtimeMs: number, sha256: string }} FileSnapshot
 */

/**
 * Result of a change-detection scan.
 * @typedef {{
 *   added:    FileSnapshot[],
 *   modified: FileSnapshot[],
 *   removed:  string[],
 *   unchanged: number,
 *   scannedAt: string
 * }} ChangeReport
 */

export class DocumentWatcher {
  /**
   * @param {object} opts
   * @param {string[]}  opts.watchDirs        — directories to watch for PDFs
   * @param {string[]}  opts.extensions       — file extensions to track (default: ['.pdf'])
   * @param {number}    opts.pollIntervalMs   — polling interval in ms (default: 5 min)
   * @param {function}  opts.onChanges        — async callback when changes detected: (report) => {}
   * @param {function}  opts.log              — logger
   */
  constructor(opts = {}) {
    this.watchDirs = opts.watchDirs || [];
    this.extensions = (opts.extensions || [".pdf"]).map((e) => e.toLowerCase());
    this.pollIntervalMs = opts.pollIntervalMs || 5 * 60 * 1000; // 5 min
    this.onChanges = opts.onChanges || null;
    this.log = opts.log || console.log;

    // Internal state
    this._snapshots = new Map();  // dir -> Map<filename, FileSnapshot>
    this._timer = null;
    this._running = false;
    this._lastScan = null;
    this._history = [];           // last N change reports
    this._maxHistory = 50;
  }

  // ---- Snapshot a single directory ----

  /**
   * Scan a directory and return a Map of filename -> FileSnapshot.
   */
  async _snapshotDir(dirPath) {
    const snap = new Map();

    if (!fsSync.existsSync(dirPath)) {
      this.log(`[watcher] Directory does not exist: ${dirPath}`);
      return snap;
    }

    let entries;
    try {
      entries = await fs.readdir(dirPath);
    } catch (err) {
      this.log(`[watcher] Error reading ${dirPath}: ${err.message}`);
      return snap;
    }

    for (const entry of entries) {
      const ext = path.extname(entry).toLowerCase();
      if (!this.extensions.includes(ext)) continue;

      const fullPath = path.join(dirPath, entry);
      try {
        const stat = await fs.stat(fullPath);
        if (!stat.isFile()) continue;

        const buf = await fs.readFile(fullPath);
        const sha = sha256File(buf);

        snap.set(entry, {
          filename: entry,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          sha256: sha,
        });
      } catch (err) {
        this.log(`[watcher] Error reading file ${entry}: ${err.message}`);
      }
    }

    return snap;
  }

  // ---- Diff two snapshots ----

  /**
   * Compare old and new snapshots, returning changes.
   * @param {Map} oldSnap
   * @param {Map} newSnap
   * @returns {{ added: FileSnapshot[], modified: FileSnapshot[], removed: string[] }}
   */
  _diff(oldSnap, newSnap) {
    const added = [];
    const modified = [];
    const removed = [];

    // Check for new or modified files
    for (const [filename, newInfo] of newSnap) {
      const oldInfo = oldSnap.get(filename);
      if (!oldInfo) {
        added.push(newInfo);
      } else if (oldInfo.sha256 !== newInfo.sha256) {
        modified.push(newInfo);
      }
    }

    // Check for removed files
    for (const filename of oldSnap.keys()) {
      if (!newSnap.has(filename)) {
        removed.push(filename);
      }
    }

    return { added, modified, removed };
  }

  // ---- Full scan across all watched directories ----

  /**
   * Scan all watched directories for changes since the last scan.
   * @param {object} opts
   * @param {boolean} opts.initial — if true, treat all files as "added" (first run)
   * @returns {ChangeReport}
   */
  async scan({ initial = false } = {}) {
    this.log("[watcher] Scanning for document changes...");

    const report = {
      added: [],
      modified: [],
      removed: [],
      unchanged: 0,
      scannedAt: new Date().toISOString(),
      directories: this.watchDirs.length,
    };

    for (const dir of this.watchDirs) {
      const newSnap = await this._snapshotDir(dir);
      const oldSnap = this._snapshots.get(dir) || new Map();

      if (initial || oldSnap.size === 0) {
        // First scan of this directory: everything is "added"
        for (const info of newSnap.values()) {
          report.added.push({ ...info, dir });
        }
      } else {
        const diff = this._diff(oldSnap, newSnap);
        for (const f of diff.added) report.added.push({ ...f, dir });
        for (const f of diff.modified) report.modified.push({ ...f, dir });
        for (const f of diff.removed) report.removed.push(f);
      }

      // Count unchanged
      if (!initial && oldSnap.size > 0) {
        const changedNames = new Set([
          ...report.added.filter((a) => a.dir === dir).map((a) => a.filename),
          ...report.modified.filter((a) => a.dir === dir).map((a) => a.filename),
          ...report.removed,
        ]);
        for (const filename of newSnap.keys()) {
          if (!changedNames.has(filename)) report.unchanged++;
        }
      }

      // Update stored snapshot
      this._snapshots.set(dir, newSnap);
    }

    this._lastScan = report;
    this._history.push(report);
    if (this._history.length > this._maxHistory) this._history.shift();

    const totalChanges = report.added.length + report.modified.length + report.removed.length;
    this.log(
      `[watcher] Scan complete — added: ${report.added.length}, ` +
        `modified: ${report.modified.length}, removed: ${report.removed.length}, ` +
        `unchanged: ${report.unchanged}`
    );

    // Trigger callback if there are changes
    if (totalChanges > 0 && this.onChanges) {
      try {
        await this.onChanges(report);
      } catch (err) {
        this.log(`[watcher] onChanges callback error: ${err.message}`);
      }
    }

    return report;
  }

  // ---- Polling lifecycle ----

  /**
   * Start polling for changes at the configured interval.
   */
  async start() {
    if (this._running) {
      this.log("[watcher] Already running");
      return;
    }

    this._running = true;
    this.log(
      `[watcher] Starting document watcher — polling every ${this.pollIntervalMs / 1000}s ` +
        `across ${this.watchDirs.length} directory(ies)`
    );

    // Initial scan (marks baseline)
    await this.scan({ initial: true });

    // Set up interval
    this._timer = setInterval(async () => {
      if (!this._running) return;
      try {
        await this.scan();
      } catch (err) {
        this.log(`[watcher] Poll error: ${err.message}`);
      }
    }, this.pollIntervalMs);
  }

  /**
   * Stop the polling loop.
   */
  stop() {
    this._running = false;
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    this.log("[watcher] Stopped");
  }

  // ---- Status / introspection ----

  /**
   * Get current watcher status for API responses.
   */
  getStatus() {
    const dirs = {};
    for (const [dir, snap] of this._snapshots) {
      dirs[dir] = {
        fileCount: snap.size,
        files: Array.from(snap.values()).map((f) => ({
          filename: f.filename,
          size: f.size,
          sha256: f.sha256,
        })),
      };
    }

    return {
      running: this._running,
      pollIntervalMs: this.pollIntervalMs,
      watchDirs: this.watchDirs,
      lastScan: this._lastScan,
      directories: dirs,
      historyCount: this._history.length,
    };
  }

  /**
   * Get recent change history.
   */
  getHistory(limit = 10) {
    return this._history.slice(-limit);
  }
}

export default DocumentWatcher;
