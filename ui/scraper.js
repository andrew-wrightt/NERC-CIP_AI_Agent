// ui/scraper.js
// =========================
// #113 — Build scraping pipeline
// =========================
// Fetches NERC-CIP standard PDFs from configured source URLs,
// downloads new or updated documents, and stages them for ingestion.
// =========================

import fetch from "node-fetch";
import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import { createHash } from "crypto";

// ---- Configuration ----

// Base URLs where NERC publishes CIP standards.
// The scraper will attempt to discover PDF links from these pages.
const DEFAULT_SOURCES = [
  {
    name: "NERC Standards (official)",
    url: "https://www.nerc.com/pa/Stand/Pages/CIPStandards.aspx",
    type: "html",
  },
];

// Regex that matches CIP standard PDF filenames / URLs
const CIP_PDF_PATTERN = /CIP[-_]?\d{2,3}[-_]?\d+[^"'\s)]*\.pdf/gi;

// File-level SHA-256 helper
function sha256File(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

// ---- Scraper class ----

export class Scraper {
  /**
   * @param {object} opts
   * @param {string}   opts.downloadDir  — where to save downloaded PDFs
   * @param {string}   opts.publicDir    — the public/ folder (existing PDFs)
   * @param {object[]} opts.sources      — array of { name, url, type }
   * @param {function} opts.log          — logging function
   */
  constructor(opts = {}) {
    this.downloadDir = opts.downloadDir || path.join(process.cwd(), "scraped");
    this.publicDir = opts.publicDir || path.join(process.cwd(), "public");
    this.sources = opts.sources || DEFAULT_SOURCES;
    this.log = opts.log || console.log;
    this.timeoutMs = opts.timeoutMs || 30_000;

    // Manifest tracks what we've already downloaded (keyed by URL)
    this.manifestPath = path.join(this.downloadDir, "_manifest.json");
    this._manifest = null;
  }

  // ---- Manifest (persistent JSON record of scraped URLs) ----

  async _loadManifest() {
    if (this._manifest) return this._manifest;
    try {
      const raw = await fs.readFile(this.manifestPath, "utf8");
      this._manifest = JSON.parse(raw);
    } catch {
      this._manifest = { entries: {} };
    }
    return this._manifest;
  }

  async _saveManifest() {
    if (!this._manifest) return;
    await fs.mkdir(this.downloadDir, { recursive: true });
    await fs.writeFile(this.manifestPath, JSON.stringify(this._manifest, null, 2));
  }

  // ---- Link discovery ----

  /**
   * Fetch an HTML page and extract all URLs that look like CIP PDFs.
   * Returns an array of { url, filename }.
   */
  async discoverLinksFromHtml(sourceUrl) {
    this.log(`[scraper] Fetching index page: ${sourceUrl}`);

    let html;
    try {
      const resp = await fetch(sourceUrl, {
        headers: { "User-Agent": "NERC-CIP-AI-Agent/1.0 (+compliance-tool)" },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!resp.ok) {
        this.log(`[scraper] HTTP ${resp.status} from ${sourceUrl}`);
        return [];
      }
      html = await resp.text();
    } catch (err) {
      this.log(`[scraper] Fetch error for ${sourceUrl}: ${err.message}`);
      return [];
    }

    // Pull all href and src values
    const urlCandidates = new Set();
    const hrefPattern = /(?:href|src)\s*=\s*["']([^"']+)["']/gi;
    let m;
    while ((m = hrefPattern.exec(html)) !== null) {
      urlCandidates.add(m[1]);
    }

    // Filter for CIP PDF matches
    const results = [];
    const seenFilenames = new Set();

    for (const raw of urlCandidates) {
      const filenameMatch = raw.match(CIP_PDF_PATTERN);
      if (!filenameMatch) continue;

      const filename = filenameMatch[0];
      if (seenFilenames.has(filename.toLowerCase())) continue;
      seenFilenames.add(filename.toLowerCase());

      // Resolve relative URLs
      let fullUrl;
      try {
        fullUrl = new URL(raw, sourceUrl).href;
      } catch {
        continue;
      }

      results.push({ url: fullUrl, filename });
    }

    this.log(`[scraper] Discovered ${results.length} CIP PDF link(s) from ${sourceUrl}`);
    return results;
  }

  /**
   * For a "directory" source, list PDF files from a local or remote directory listing.
   */
  async discoverLinksFromDirectory(sourceUrl) {
    // Reuse HTML discovery — directory listings are typically HTML
    return this.discoverLinksFromHtml(sourceUrl);
  }

  // ---- Download ----

  /**
   * Download a single PDF if it's new or changed.
   * Returns { filename, path, status: 'downloaded' | 'unchanged' | 'error' }
   */
  async downloadPdf(pdfUrl, filename) {
    const manifest = await this._loadManifest();
    const destPath = path.join(this.downloadDir, filename);

    try {
      // HEAD request first to check content-length / last-modified if available
      let headInfo = {};
      try {
        const head = await fetch(pdfUrl, {
          method: "HEAD",
          headers: { "User-Agent": "NERC-CIP-AI-Agent/1.0" },
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        headInfo = {
          contentLength: head.headers.get("content-length"),
          lastModified: head.headers.get("last-modified"),
          etag: head.headers.get("etag"),
        };
      } catch {
        // HEAD not supported; proceed to GET
      }

      // Check manifest for unchanged content
      const prev = manifest.entries[pdfUrl];
      if (prev) {
        const sameEtag = headInfo.etag && prev.etag === headInfo.etag;
        const sameModified = headInfo.lastModified && prev.lastModified === headInfo.lastModified;
        const sameSize = headInfo.contentLength && prev.contentLength === headInfo.contentLength;

        if (sameEtag || sameModified) {
          this.log(`[scraper] Unchanged (etag/modified): ${filename}`);
          return { filename, path: destPath, status: "unchanged" };
        }

        // If only size matches and file exists on disk with same hash, skip
        if (sameSize && fsSync.existsSync(destPath)) {
          const existingBuf = await fs.readFile(destPath);
          const existingHash = sha256File(existingBuf);
          if (existingHash === prev.sha256) {
            this.log(`[scraper] Unchanged (size+hash): ${filename}`);
            return { filename, path: destPath, status: "unchanged" };
          }
        }
      }

      // Full download
      this.log(`[scraper] Downloading: ${filename}`);
      const resp = await fetch(pdfUrl, {
        headers: { "User-Agent": "NERC-CIP-AI-Agent/1.0" },
        signal: AbortSignal.timeout(60_000), // 60s for large PDFs
      });

      if (!resp.ok) {
        this.log(`[scraper] HTTP ${resp.status} downloading ${filename}`);
        return { filename, path: null, status: "error", error: `HTTP ${resp.status}` };
      }

      const buf = Buffer.from(await resp.arrayBuffer());
      const sha = sha256File(buf);

      // If we already have this exact content, skip write
      if (prev?.sha256 === sha && fsSync.existsSync(destPath)) {
        this.log(`[scraper] Unchanged (hash match after download): ${filename}`);
        manifest.entries[pdfUrl] = {
          ...prev,
          lastChecked: new Date().toISOString(),
          ...headInfo,
        };
        await this._saveManifest();
        return { filename, path: destPath, status: "unchanged" };
      }

      await fs.mkdir(this.downloadDir, { recursive: true });
      await fs.writeFile(destPath, buf);

      // Update manifest
      manifest.entries[pdfUrl] = {
        filename,
        sha256: sha,
        sizeBytes: buf.length,
        downloadedAt: new Date().toISOString(),
        lastChecked: new Date().toISOString(),
        ...headInfo,
      };
      await this._saveManifest();

      this.log(`[scraper] Downloaded: ${filename} (${buf.length} bytes)`);
      return { filename, path: destPath, status: "downloaded" };
    } catch (err) {
      this.log(`[scraper] Error downloading ${filename}: ${err.message}`);
      return { filename, path: null, status: "error", error: err.message };
    }
  }

  // ---- Main pipeline ----

  /**
   * Run the full scraping pipeline:
   * 1. Discover links from all configured sources
   * 2. Download new or changed PDFs
   * 3. Return results for ingestion
   *
   * @returns {{ discovered: number, downloaded: object[], unchanged: number, errors: object[] }}
   */
  async run() {
    this.log("[scraper] Starting scraping pipeline...");

    // 1. Discover all PDF links
    const allLinks = [];

    for (const source of this.sources) {
      let links = [];
      if (source.type === "directory") {
        links = await this.discoverLinksFromDirectory(source.url);
      } else {
        links = await this.discoverLinksFromHtml(source.url);
      }
      for (const l of links) {
        l.sourceName = source.name;
      }
      allLinks.push(...links);
    }

    // Deduplicate by filename (prefer first occurrence)
    const deduped = new Map();
    for (const link of allLinks) {
      const key = link.filename.toLowerCase();
      if (!deduped.has(key)) deduped.set(key, link);
    }

    this.log(`[scraper] Total unique PDF links: ${deduped.size}`);

    // 2. Download
    const downloaded = [];
    const errors = [];
    let unchanged = 0;

    for (const [, link] of deduped) {
      const result = await this.downloadPdf(link.url, link.filename);
      if (result.status === "downloaded") {
        downloaded.push(result);
      } else if (result.status === "unchanged") {
        unchanged++;
      } else {
        errors.push(result);
      }
    }

    this.log(
      `[scraper] Pipeline complete — discovered: ${deduped.size}, ` +
        `downloaded: ${downloaded.length}, unchanged: ${unchanged}, errors: ${errors.length}`
    );

    return {
      discovered: deduped.size,
      downloaded,
      unchanged,
      errors,
    };
  }

  /**
   * Convenience: scrape from a single URL (for ad-hoc / API-triggered scrapes).
   */
  async scrapeUrl(url) {
    this.log(`[scraper] Ad-hoc scrape from: ${url}`);
    const links = await this.discoverLinksFromHtml(url);
    const results = [];

    for (const link of links) {
      const r = await this.downloadPdf(link.url, link.filename);
      results.push(r);
    }

    return results;
  }

  /**
   * Get manifest info for status reporting.
   */
  async getManifest() {
    const m = await this._loadManifest();
    const entries = Object.entries(m.entries || {}).map(([url, info]) => ({
      url,
      ...info,
    }));
    return { totalTracked: entries.length, entries };
  }
}

export default Scraper;
