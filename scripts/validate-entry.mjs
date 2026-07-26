#!/usr/bin/env node
/**
 * validate-entry.mjs — PR CI gate (A2.0, puppeteer-skill-store).
 *
 * For every catalog.json entry ADDED or CHANGED in a PR (or every entry, with
 * `--all`), this script:
 *   1. fetches the pinned upstream tarball (`sourceUrl`@`upstreamCommit`) via
 *      codeload — the SAME URL shape a real install would hit
 *      (`codeloadTarballUrl`, ported in `lib/upstream.mjs`);
 *   2. resolves `upstreamPath`/`upstreamPaths` to the assembled skill payload
 *      (`curatedUpstreamMappings` + `mapUpstreamTarEntries`, same port);
 *   3. re-hashes the RAW BYTES with the canonical scheme
 *      (`hashSkillFileBytes` — a duplicate of
 *      `packages/skills/src/skill-file-bytes.ts`, see `lib/upstream.mjs`'s
 *      header for why the duplication exists and where the source of truth
 *      lives) and requires it to equal the entry's `contentHash`;
 *   4. checks the FULL fetched repo (not just the mapped skill subset — most
 *      curated entries live in a subdirectory that never carried its own
 *      LICENSE file; the license lives at the repo root) for a top-level
 *      LICENSE file;
 *   5. enforces the BYTE-REVIEW INVARIANT (below) — the one check that is pure
 *      data, needs no network, and would otherwise be provable by nobody.
 * A mismatch, an unresolvable path, a missing license, or a broken invariant
 * FAILS the entry with a precise reason — nothing is silently skipped or
 * downgraded to a warning.
 *
 * THE BYTE-REVIEW INVARIANT (T3 closer, 2026-07-26):
 *
 *     reviewed.sha === upstreamCommit  ||  byteAudit === 'upstream-differs'
 *
 * `byteAudit: 'vendored-match'` is the SOLE grant of install tier 'auto' in
 * the app ("the wizard may install unattended", no owner confirmation —
 * `packages/skills/src/skill-tier.ts`), and the audit summary an owner reads
 * for such a row says literally "byte-identical to the payload reviewed at
 * curation time". That claim is only true of the bytes at the sha a human
 * ACTUALLY read. Checks 1-3 cannot detect a violation: they verify
 * `contentHash` against the bytes at the CURRENT pin, so anyone (a bot, a
 * hurried hand-edit) who moves `upstreamCommit` and recomputes `contentHash`
 * from the new bytes makes them pass by construction while silently carrying a
 * byte-review verdict onto bytes nobody has read. Since `vendored/` is no
 * longer kept on disk, `byteAudit` is not re-derivable from anything — this
 * invariant is the ONLY mechanical thing standing between a moved pin and a
 * fabricated verdict, so it is a hard error, not a warning. Legitimately
 * re-reviewing bytes satisfies it by updating `reviewed` in the same edit;
 * moving a pin without a review satisfies it by demoting `byteAudit` (which is
 * exactly what `propose-pin-bumps.mjs` does).
 *
 * WHICH ENTRIES GET CHECKED. Default: diff `catalog.json` between
 * `--base-ref` (a git ref/sha the workflow's `actions/checkout` made
 * available, e.g. `origin/main`) and the working tree, and validate every
 * slug that is NEW or whose row changed. `--all` validates every entry
 * (a full catalogue audit — expensive: ~42 archive fetches; use sparingly,
 * e.g. a scheduled full-audit workflow, never on every PR). `--slugs a,b,c`
 * validates an explicit list (manual debugging).
 *
 * ALSO VALIDATES `.claude-plugin/marketplace.json` is in sync with
 * `catalog.json` by shelling out to `generate-marketplace.mjs --check` —
 * one gate, not two things that can silently drift.
 *
 * OFFLINE TESTING: set `VALIDATE_TARBALL_CACHE=<dir>` to a directory of
 * `<owner>__<repo>__<sha>.tgz` files (the same naming
 * `generate-curated-index.mjs`'s `CURATED_TARBALL_CACHE` uses) to skip the
 * network entirely and read from disk — this is how this script's own dry
 * run was verified against the real catalogue without hitting GitHub.
 */
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseTar } from './lib/tar.mjs';
import {
  parseGithubOwnerRepo,
  codeloadTarballUrl,
  curatedUpstreamMappings,
  mapUpstreamTarEntries,
  hashSkillFileBytes,
  skillFileBytes,
} from './lib/upstream.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..');
const CATALOG_PATH = join(REPO_ROOT, 'catalog.json');

const TAR_CAPS = { maxEntries: 20000, maxTotalBytes: 384 * 1024 * 1024 };
const LICENSE_RE = /^licen[sc]e(\.(md|txt))?$/i;

function parseArgs(argv) {
  const out = { all: false, baseRef: process.env.VALIDATE_BASE_REF, slugs: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--all') out.all = true;
    else if (a === '--base-ref') out.baseRef = argv[++i];
    else if (a === '--slugs') out.slugs = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
  }
  return out;
}

function loadJson(text) {
  return JSON.parse(text);
}

function loadCurrentCatalog() {
  if (!existsSync(CATALOG_PATH)) throw new Error(`validate-entry: catalog.json not found at ${CATALOG_PATH}`);
  return loadJson(readFileSync(CATALOG_PATH, 'utf8'));
}

/** `git show <ref>:catalog.json`, or undefined if the ref/file doesn't resolve (new repo, first commit). */
function loadCatalogAtRef(ref) {
  try {
    const text = execFileSync('git', ['show', `${ref}:catalog.json`], { cwd: REPO_ROOT, encoding: 'utf8' });
    return loadJson(text);
  } catch {
    return undefined;
  }
}

/** Slugs that are new or whose row changed (deep JSON compare), base → head. */
function changedSlugs(baseCatalog, headCatalog) {
  const baseBySlug = new Map((baseCatalog?.skills ?? []).map((s) => [s.slug, s]));
  const changed = [];
  for (const entry of headCatalog.skills ?? []) {
    const prior = baseBySlug.get(entry.slug);
    if (!prior || JSON.stringify(prior) !== JSON.stringify(entry)) changed.push(entry.slug);
  }
  return changed;
}

async function fetchArchiveEntries(owner, repo, sha) {
  const cacheDir = process.env.VALIDATE_TARBALL_CACHE;
  let gz;
  if (cacheDir) {
    const cacheFile = join(cacheDir, `${owner}__${repo}__${sha}.tgz`);
    if (existsSync(cacheFile)) gz = readFileSync(cacheFile);
  }
  if (!gz) {
    const url = codeloadTarballUrl(owner, repo, sha);
    const res = await fetch(url, { headers: { accept: 'application/gzip,application/octet-stream,*/*' }, redirect: 'follow' });
    if (!res.ok) throw new Error(`codeload ${owner}/${repo}@${sha}: HTTP ${res.status}`);
    gz = Buffer.from(await res.arrayBuffer());
    if (gz.byteLength === 0) throw new Error(`codeload ${owner}/${repo}@${sha}: empty body`);
  }
  const { entries, truncated } = parseTar(gunzipSync(gz), TAR_CAPS);
  if (truncated) throw new Error(`codeload ${owner}/${repo}@${sha}: archive exceeds caps`);
  return entries;
}

/** Does the archive carry a top-level LICENSE(.md|.txt) file (repo root, not the skill subtree)? */
function hasRootLicense(entries) {
  for (const ent of entries) {
    if (ent.isDir) continue;
    const norm = ent.name.replace(/^\.\//, '');
    const slash = norm.indexOf('/');
    if (slash < 0) continue;
    const rel = norm.slice(slash + 1);
    if (!rel.includes('/') && LICENSE_RE.test(rel)) return true;
  }
  return false;
}

/**
 * The byte-review invariant — pure data, no network, run on EVERY targeted
 * entry (including `unavailable` ones, which make no fetchable claim but can
 * still carry a stale `vendored-match`). See the module header for why this is
 * the only mechanical guard left once `vendored/` stopped being kept on disk.
 * Absent/unknown `byteAudit` is an ERROR, not a pass: silence must never be the
 * permissive answer for the field that grants unattended installs.
 */
function byteReviewInvariantErrors(entry) {
  const errors = [];
  const byteAudit = entry.byteAudit;
  if (byteAudit !== 'vendored-match' && byteAudit !== 'upstream-differs') {
    errors.push(
      `byteAudit is '${byteAudit ?? 'absent'}' — every entry must state 'vendored-match' or 'upstream-differs' ` +
        `(it is what decides whether the app may install this skill unattended)`,
    );
    return errors;
  }
  if (byteAudit !== 'vendored-match') return errors;
  const pin = (entry.upstreamCommit ?? '').trim();
  const reviewedSha = (entry.reviewed?.sha ?? '').trim();
  if (reviewedSha !== pin) {
    errors.push(
      `byteAudit is 'vendored-match' but reviewed.sha is '${reviewedSha || 'absent'}' while upstreamCommit is '${pin || 'absent'}' — ` +
        `'vendored-match' grants UNATTENDED install and asserts the shipped bytes are the reviewed ones, so it may only stand at the sha a human actually reviewed. ` +
        `Either re-review the bytes at the new pin and update 'reviewed' in the same edit, or set byteAudit to 'upstream-differs' (the skill still installs, with one owner confirmation)`,
    );
  }
  return errors;
}

async function validateOne(entry, archiveCache) {
  const errors = [...byteReviewInvariantErrors(entry)];
  const parsed = parseGithubOwnerRepo(entry.sourceUrl ?? '');
  const sha = (entry.upstreamCommit ?? '').trim();
  if (!parsed) {
    errors.push(`sourceUrl '${entry.sourceUrl}' is not a parseable github.com repo URL`);
    return errors;
  }
  if (sha.length === 0) {
    errors.push('upstreamCommit is empty — a curated entry must be pinned to a commit');
    return errors;
  }
  if (entry.unavailable) {
    // An entry explicitly marked unavailable makes no verifiable claim; nothing to check.
    return errors;
  }

  const archiveKey = `${parsed.owner}/${parsed.repo}@${sha}`;
  let entries = archiveCache.get(archiveKey);
  if (!entries) {
    try {
      entries = await fetchArchiveEntries(parsed.owner, parsed.repo, sha);
      archiveCache.set(archiveKey, entries);
    } catch (err) {
      errors.push(`could not fetch upstream archive: ${err instanceof Error ? err.message : String(err)}`);
      return errors;
    }
  }

  const mappings = curatedUpstreamMappings(entry);
  if (mappings.length === 0) {
    errors.push('neither upstreamPath nor upstreamPaths resolves to a fetchable path');
    return errors;
  }

  let files;
  try {
    files = mapUpstreamTarEntries(entries, mappings, archiveKey);
  } catch (err) {
    errors.push(`upstream path did not resolve: ${err instanceof Error ? err.message : String(err)}`);
    return errors;
  }

  const actualHash = hashSkillFileBytes(files);
  if (entry.contentHash && actualHash !== entry.contentHash) {
    errors.push(
      `contentHash mismatch: catalog.json says '${entry.contentHash}', the fetched upstream bytes hash to '${actualHash}' ` +
        `(${files.length} files, ${files.reduce((n, f) => n + skillFileBytes(f).byteLength, 0)} bytes)`,
    );
  } else if (!entry.contentHash) {
    errors.push("contentHash is empty — every available entry must state one");
  }

  if (!hasRootLicense(entries)) {
    errors.push(`upstream repo ${parsed.owner}/${parsed.repo}@${sha} carries no top-level LICENSE file`);
  }

  return errors;
}

function runGenerateMarketplaceCheck() {
  try {
    execFileSync('node', [join(HERE, 'generate-marketplace.mjs'), '--check'], { cwd: REPO_ROOT, stdio: 'pipe' });
    return undefined;
  } catch (err) {
    const out = err.stdout ? err.stdout.toString() : '';
    const errOut = err.stderr ? err.stderr.toString() : '';
    return (out + errOut).trim() || (err instanceof Error ? err.message : String(err));
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const headCatalog = loadCurrentCatalog();

  let targets;
  if (args.slugs) {
    targets = args.slugs;
  } else if (args.all) {
    targets = (headCatalog.skills ?? []).map((s) => s.slug);
  } else {
    if (!args.baseRef) {
      console.error(
        'validate-entry: no --base-ref / VALIDATE_BASE_REF given and --all not set.\n' +
          'Usage: node scripts/validate-entry.mjs --base-ref origin/main\n' +
          '       node scripts/validate-entry.mjs --all\n' +
          '       node scripts/validate-entry.mjs --slugs slug-a,slug-b',
      );
      process.exit(2);
    }
    const baseCatalog = loadCatalogAtRef(args.baseRef);
    targets = changedSlugs(baseCatalog, headCatalog);
    if (targets.length === 0) {
      console.log(`validate-entry: catalog.json unchanged relative to '${args.baseRef}' — nothing to validate.`);
    }
  }

  const bySlug = new Map((headCatalog.skills ?? []).map((s) => [s.slug, s]));
  const missing = targets.filter((slug) => !bySlug.has(slug));
  if (missing.length > 0) {
    console.error(`validate-entry: unknown slug(s) in catalog.json: ${missing.join(', ')}`);
    process.exit(2);
  }

  const archiveCache = new Map();
  let failures = 0;
  for (const slug of targets) {
    const entry = bySlug.get(slug);
    process.stdout.write(`  ${slug.padEnd(40)} `);
    const errors = await validateOne(entry, archiveCache);
    if (errors.length === 0) {
      console.log('OK');
    } else {
      failures += 1;
      console.log('FAIL');
      for (const e of errors) console.log(`    - ${e}`);
    }
  }

  const marketplaceError = runGenerateMarketplaceCheck();
  if (marketplaceError) {
    failures += 1;
    console.log('  .claude-plugin/marketplace.json          FAIL');
    console.log(`    - ${marketplaceError}`);
  } else if (targets.length > 0 || args.all) {
    console.log('  .claude-plugin/marketplace.json          OK (in sync with catalog.json)');
  }

  if (failures > 0) {
    console.error(`\nvalidate-entry: ${failures} failure(s) across ${targets.length} checked entrie(s).`);
    process.exit(1);
  }
  console.log(`\nvalidate-entry: all ${targets.length} checked entrie(s) passed.`);
}

main().catch((err) => {
  console.error(`validate-entry: unexpected error: ${err instanceof Error ? err.stack : String(err)}`);
  process.exit(1);
});
