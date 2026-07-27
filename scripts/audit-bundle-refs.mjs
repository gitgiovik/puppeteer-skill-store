#!/usr/bin/env node
/**
 * audit-bundle-refs.mjs — CATALOG-WIDE audit of "references outside the pinned subtree"
 * (A1, puppeteer-skill-store).
 *
 * WHY THIS EXISTS. `packages/skill-runtime/src/skill-vendoring-lint.ts` (app repo) catches
 * this same class of bug — a SKILL.md that points at a bundle file which isn't actually
 * there — but only on skills that are ALREADY INSTALLED on someone's disk. That is too late:
 * the skill breaks on its first real invocation, and the fix (repin the catalog entry) has
 * to happen HERE, in the catalogue, before anyone installs it. This script runs the same
 * class of check pre-install, catalog-wide, against the upstream tarball at the pinned sha —
 * exactly the bug class that shipped as `digitalsamba-video-toolkit`: the entry pinned a
 * ONE-FILE subdirectory while its SKILL.md orchestrated 11 sibling sub-skills and `tools/*.py`
 * living at the REPO ROOT, so the skill installed a single file and broke on first use (fixed
 * 2026-07-27 by repinning the whole repo — see that entry's `reviewed.verdict` in catalog.json).
 *
 * WHAT IT DOES, end to end, for every catalog.json entry:
 *   1. Fetches the upstream tarball at `sourceUrl`@`upstreamCommit` (codeload — the same URL a
 *      real install hits), CACHED per `owner/repo@sha` on disk — many entries share a repo+sha
 *      (72 unique archives back 211 entries at the time this was written), so the cache turns
 *      an O(211) fetch cost into O(unique archives).
 *   2. Resolves `curatedUpstreamMappings` + `mapUpstreamTarEntries` (ported, byte-identical
 *      algorithm to the app repo — see `lib/upstream.mjs`'s header) to get the EXACT payload a
 *      real install would produce.
 *   3. Reads that payload's root `SKILL.md` (frontmatter stripped) and extracts every path-like
 *      reference to a bundle file, using the SAME rules as the runtime lint
 *      (`skill-vendoring-lint.ts`'s `BUNDLE_PREFIXES` + helper-ref regex) PLUS one new
 *      heuristic this audit adds (see EXTRACTION RULES below) that the runtime lint does not
 *      need, because the runtime lint only ever sees refs the rewrite already recognises —
 *      this audit has to recognise refs a human AUTHOR wrote, including ones like
 *      `python3 tools/generate_voice.py` that aren't spelled with a known bundle prefix at all.
 *   4. For every extracted ref that is NOT already present in the payload, classifies it:
 *        FIXABLE        — the file exists elsewhere in the fetched repo at the pinned sha; a
 *                          mapping/root-expansion would include it. Reports the suggested fix.
 *        UPSTREAM-MISSING — the file does not exist ANYWHERE in the repo at the pin (a
 *                          placeholder / user-supplied asset the author expects the END USER
 *                          to drop in later, e.g. `assets/voices/reference.m4a`).
 *        FALSE-POSITIVE — the "ref" is very likely prose, a template variable, another skill's
 *                          own bundle path, or a generated/output path — see FALSE-POSITIVE
 *                          FILTERS below. Reported, never silently dropped.
 *
 * EXTRACTION RULES (documented so the false-positive rate is auditable, not asserted):
 *   R1 bundle-prefix bare refs — `(scripts|assets|references|resources)/<leaf>(/<leaf>)*` (any
 *      extension) and `reference/<leaf>` (extension OR a further segment required — `reference`
 *      alone is common English prose, e.g. "the reference/manual process", so a bare
 *      extensionless single-segment match is NOT taken). Byte-identical charset and boundary
 *      rule to `loader.ts::rewriteBundlePaths` / `skill-vendoring-lint.ts::BUNDLE_PREFIXES`.
 *      LOW false-positive rate — this is the runtime's own proven regex.
 *   R2 `.claude/skills/<own-slug>/REST` and `.puppeteer/skills/<own-slug>/REST` — REST is the
 *      ref. Restricted to THIS entry's own slug (a mention of `.claude/skills/<other-skill>/…`
 *      is a cross-reference to a DIFFERENT skill's bundle, not a broken ref of this one, and is
 *      stripped out before extraction runs — see `stripOtherSkillNamespaces`). LOW rate.
 *   R3 helper refs — `skill_run_script('name','scripts/X')` / `skill_read('name','reference/Y')`
 *      (same regex as the runtime lint, both prefix sets). LOW rate (none in the catalogue at
 *      time of writing; kept for forward compatibility, same as the runtime lint).
 *   R4 (NEW, heuristic, HIGHER rate) — a relative path *not* under a known bundle prefix, the
 *      exact shape of the digitalsamba bug: (a) immediately following an interpreter/command
 *      keyword (`python3? node bash sh ruby perl Rscript`) on the same line, or (b) inside a
 *      SINGLE-BACKTICK inline-code span, in BOTH cases requiring at least one `/` AND a
 *      recognised code/doc/asset extension (see `KNOWN_EXTENSIONS`) so bare single-segment
 *      words and un-extensioned prose are excluded by construction. This is the rule that
 *      would have caught `tools/generate_voice.py` in digitalsamba's original SKILL.md.
 *
 * KNOWN RECALL GAP (documented, not fixed — this audit is a HIGH-PRECISION net, not a complete
 * one): a ref written ONLY as a markdown link target, `[label](some/path.md)`, with no bundle
 * prefix and outside any backtick span, is extracted by NEITHER rule. R1 takes it (its boundary
 * charset includes `(`) but only when the path starts with a real bundle prefix; R4's two
 * shapes are interpreter-command and single-backtick span, and a `](…)` target is neither.
 * Real example in the catalogue: `gws-sheets`'s helper table, `[`+append`](../gws-sheets-append/
 * SKILL.md)` — invisible here, while the PROSE ref two lines above it (`../gws-shared/SKILL.md`,
 * in backticks) is caught. Widening R4 to link targets would pull in every documentation URL
 * path and every cross-repo pointer authors write in link form, so the gap is deliberate; it
 * means a clean run is evidence of "no findings by these rules", never "no refs outside the
 * subtree" — which is exactly why the FIXABLE bucket is advisory to a human, not a gate.
 *
 * FALSE-POSITIVE FILTERS (applied to every candidate BEFORE it is checked against the repo, but
 * ground truth always wins — see classification below):
 *   - template placeholder: contains `${`, `{{`, a bare `{`, or `<...>`
 *   - URL: contains `://`
 *   - absolute unix path: starts with `/`
 *   - generated/output path: first path segment is one of
 *     dist, build, out, coverage, node_modules, .git, __pycache__, venv, .venv, site-packages
 *   - placeholder example: contains `path/to/`, `your-project`, `my-project`, `yourusername`,
 *     `example.com`
 *   - another skill's own `.claude|.puppeteer/skills/<other>/` namespace (stripped pre-extraction)
 *
 * CLASSIFICATION ORDER (ground truth beats heuristic guesses, always):
 *   1. Present in the payload already?              → not missing, not reported at all. `..`
 *      segments are POSIX-normalised first, so a `../sibling/x.md` between two skills that BOTH
 *      live in the same payload resolves and is correctly not reported.
 *   2. Exists ANYWHERE in the full repo at the pin?  → FIXABLE, regardless of any FP filter hit
 *      (a real file that happens to also look like a template var is still a real file). A ref
 *      with a `..` segment is resolved against the referencing SKILL.md's OWN directory and
 *      normalised (basis `relative`) — without that, `../gws-shared/SKILL.md` matched none of
 *      the three passes and fell through to UPSTREAM-MISSING, i.e. the audit claimed "exists
 *      nowhere in the repo" about a file sitting right next door. False negatives on FIXABLE
 *      are the one direction this tool must never fail in, so `..` is normalised everywhere.
 *   2b. …but a `../<x>/SKILL.md` hit whose sibling is ALREADY PUBLISHED as its own catalogue
 *      entry (same repo, a mapping pinned exactly at that directory, slug === that directory's
 *      name) is FALSE-POSITIVE `sibling-skill-published-separately`: the install layout is
 *      `<root>/.puppeteer/skills/<slug>/`, so once both entries are installed the relative path
 *      resolves literally, and NO mapping on this entry could ever satisfy it (a mapping can
 *      only place files INSIDE this skill's own directory). Checked against the whole catalogue,
 *      never just the audited slice, so `--slugs` and full runs agree.
 *   3. Matches a FALSE-POSITIVE filter?              → FALSE-POSITIVE, with the matched reason.
 *   4. Otherwise                                     → UPSTREAM-MISSING.
 *
 * HONESTY ON THE FALSE-POSITIVE RATE: R1-R3 are the runtime's own proven, narrow regex — their
 * false-positive rate on the current catalogue, measured by this run, is reported in the JSON
 * output's `heuristics.r1r2r3FalsePositiveCount` (expected ~0, they require a path-shaped
 * boundary and a real prefix). R4 is new and broader; its false-positive rate is reported as
 * `heuristics.r4FalsePositiveCount` / `heuristics.r4FindingCount` in the same output — read that
 * ratio before trusting an R4-only UPSTREAM-MISSING verdict blindly. Every finding carries the
 * `rule` that produced it (`r1`, `r2`, `r3`, `r4`) so a reviewer can filter by confidence.
 * MIND THE DENOMINATOR: `*FindingCount` counts FINDINGS, not extracted candidates — a candidate
 * that resolved inside the payload (step 1 above) never becomes a finding and is never counted.
 * The published ratio is therefore "false positives per REPORTED finding of that rule", which is
 * the number a reviewer triaging the report actually needs; it is NOT the rule's precision over
 * everything it matched in the SKILL.md text (that denominator would be much larger and would
 * flatter the rule). The fields are named for what they count for exactly this reason.
 *
 * USAGE:
 *   node scripts/audit-bundle-refs.mjs                     # full catalogue, network fetch
 *   node scripts/audit-bundle-refs.mjs --slugs a,b,c        # just these slugs
 *   node scripts/audit-bundle-refs.mjs --json-out FILE.json # write the full JSON report there
 *   node scripts/audit-bundle-refs.mjs --concurrency 8      # parallel archive fetches (default 6)
 *   AUDIT_TARBALL_CACHE=<dir> node scripts/audit-bundle-refs.mjs   # override the disk cache dir
 *     (default: <repo>/.audit-cache/ — gitignored; safe to delete, just re-fetches)
 *
 * EXIT CODE: 1 iff at least one FIXABLE finding exists (an actionable catalogue bug). A run
 * with only UPSTREAM-MISSING / FALSE-POSITIVE findings exits 0 — those are informative, not
 * actionable catalogue defects on their own.
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { dirname, join, posix as posixPath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseTar } from './lib/tar.mjs';
import {
  parseGithubOwnerRepo,
  codeloadTarballUrl,
  curatedUpstreamMappings,
} from './lib/upstream.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..');
const CATALOG_PATH = join(REPO_ROOT, 'catalog.json');
const CACHE_DIR = process.env.AUDIT_TARBALL_CACHE || join(REPO_ROOT, '.audit-cache');
const TAR_CAPS = { maxEntries: 20000, maxTotalBytes: 384 * 1024 * 1024 };

// ---------------------------------------------------------------------------
// arg parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { slugs: undefined, jsonOut: undefined, concurrency: 6 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--slugs') out.slugs = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--json-out') out.jsonOut = argv[++i];
    else if (a === '--concurrency') out.concurrency = Math.max(1, Number.parseInt(argv[++i], 10) || 6);
  }
  return out;
}

// ---------------------------------------------------------------------------
// tarball fetch + disk cache (keyed by owner/repo@sha — shared across entries)
// ---------------------------------------------------------------------------

function cacheFile(owner, repo, sha) {
  return join(CACHE_DIR, `${owner}__${repo}__${sha}.tgz`);
}

async function fetchArchiveBytes(owner, repo, sha) {
  const cached = cacheFile(owner, repo, sha);
  if (existsSync(cached)) return readFileSync(cached);
  const url = codeloadTarballUrl(owner, repo, sha);
  const res = await fetch(url, {
    headers: { accept: 'application/gzip,application/octet-stream,*/*' },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`codeload ${owner}/${repo}@${sha}: HTTP ${res.status}`);
  const gz = Buffer.from(await res.arrayBuffer());
  if (gz.byteLength === 0) throw new Error(`codeload ${owner}/${repo}@${sha}: empty body`);
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(cached, gz);
  return gz;
}

async function fetchArchiveEntries(owner, repo, sha) {
  const gz = await fetchArchiveBytes(owner, repo, sha);
  const { entries, truncated } = parseTar(gunzipSync(gz), TAR_CAPS);
  if (truncated) throw new Error(`codeload ${owner}/${repo}@${sha}: archive exceeds audit caps`);
  return entries;
}

/** Repo-root-relative path for a raw tar entry name (strips the codeload top dir), or undefined for the top dir itself. */
function repoRelativePath(name) {
  const norm = name.replace(/^\.\//, '');
  const slash = norm.indexOf('/');
  if (slash < 0) return undefined;
  const rest = norm.slice(slash + 1);
  return rest.length > 0 ? rest : undefined;
}

/** Every regular-file repo-root-relative path in a fetched archive (dirs excluded). */
function repoFilePaths(entries) {
  const out = [];
  for (const ent of entries) {
    if (ent.isDir) continue;
    const rel = repoRelativePath(ent.name);
    if (rel !== undefined) out.push(rel);
  }
  return out;
}

// ---------------------------------------------------------------------------
// payload building WITH PROVENANCE (repo-root-relative origin per payload file) —
// a local superset of `upstream.mjs`'s ported `extractSubtree`/`mapUpstreamTarEntries`.
// WHY NOT JUST CALL THE PORTED ONES: this audit needs, for every payload file, the
// REPO-ROOT-RELATIVE path it actually came from (not just its final payload-relative
// path) so a ref found in a NESTED SKILL.md (e.g. an umbrella repo with a dozen
// sub-skill SKILL.md files, each a `mapping.to` rename away from its `mapping.from`)
// can be resolved against "the same directory the author saw it in on disk", which is
// the semantics a bare relative ref actually has. The algorithm is otherwise IDENTICAL
// to `extractSubtree`/`mapUpstreamTarEntries` (same stripTopDir/basename shape,
// same collision guard) — only the provenance field is new.
// ---------------------------------------------------------------------------

function stripTopDirLocal(name) {
  const norm = name.replace(/^\.\//, '');
  const slash = norm.indexOf('/');
  if (slash < 0) return undefined;
  const rest = norm.slice(slash + 1);
  return rest.length > 0 ? rest : undefined;
}

function basenameLocal(p) {
  const slash = p.lastIndexOf('/');
  return slash < 0 ? p : p.slice(slash + 1);
}

/** Like `extractSubtree`, but each output file also carries `originalPath` (repo-root-relative). */
function extractSubtreeWithProvenance(entries, subPath) {
  const out = [];
  for (const ent of entries) {
    if (ent.isDir) continue;
    const rel = stripTopDirLocal(ent.name);
    if (rel === undefined) continue;
    let subRel;
    if (rel === subPath) subRel = basenameLocal(rel);
    else if (rel.startsWith(`${subPath}/`)) subRel = rel.slice(subPath.length + 1);
    else continue;
    if (subRel.length === 0) continue;
    out.push({ subRel, originalPath: rel, data: ent.data });
  }
  return out;
}

/** Like `mapUpstreamTarEntries`, but tracks `originalPath` per payload file. Returns `{path, originalPath, encoding?, contents}[]`. */
function mapUpstreamTarEntriesWithProvenance(entries, mappings, label) {
  if (mappings.length === 0) throw new Error(`${label}: no upstream path mapping to resolve`);
  const seen = new Set();
  const out = [];
  for (const mapping of mappings) {
    const files = extractSubtreeWithProvenance(entries, mapping.from);
    if (files.length === 0) throw new Error(`${label}: subPath '${mapping.from}' matched no files`);
    for (const f of files) {
      const path = mapping.to.length > 0 ? `${mapping.to}/${f.subRel}` : f.subRel;
      if (seen.has(path)) {
        throw new Error(`${label}: upstream path mappings collide on '${path}' (mapping '${mapping.from}' -> '${mapping.to}')`);
      }
      seen.add(path);
      out.push({ path, originalPath: f.originalPath, data: f.data });
    }
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

function decodeUtf8OrUndefined(data) {
  for (const b of data) if (b === 0) return undefined;
  const text = new TextDecoder('utf-8', { fatal: false }).decode(data);
  return text.includes('�') ? undefined : text;
}

// ---------------------------------------------------------------------------
// SKILL.md frontmatter strip (tiny, dependency-free — mirrors parse-skill-md.ts::splitFrontmatter
// closely enough for this audit's purposes: only the YAML front block need be removed so its
// `name:`/`description:` fields don't get mistaken for bundle-path prose).
// ---------------------------------------------------------------------------

function stripFrontmatter(raw) {
  if (!raw.startsWith('---')) return raw;
  const end = raw.indexOf('\n---', 3);
  if (end < 0) return raw;
  const afterMarker = raw.indexOf('\n', end + 1);
  return afterMarker < 0 ? '' : raw.slice(afterMarker + 1);
}

// ---------------------------------------------------------------------------
// extraction rules (R1-R4) — see module header for the full rationale
// ---------------------------------------------------------------------------

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const LEAF = '[A-Za-z0-9._-]+';
const SEGS = `(?:\\/${LEAF})*`;
/** scripts|assets|references|resources: not English prose words with a slash → extension optional. */
const R1_LOOSE_RE = new RegExp(`(^|[\\s\`(\\[])((?:scripts|assets|references|resources)\\/${LEAF}${SEGS})`, 'gm');
/** reference (singular, common English word) — require an extension OR a further segment. */
const R1_REFERENCE_RE = new RegExp(
  `(^|[\\s\`(\\[])(reference\\/${LEAF}(?:\\.[A-Za-z0-9]+|\\/${LEAF})${SEGS})`,
  'gm',
);
const R3_HELPER_RE =
  /skill_(?:run_script|read)\s*\(\s*['"][^'"]*['"]\s*,\s*['"]((?:scripts|assets|reference|references|resources)\/[^'"]+)['"]/g;

const KNOWN_EXTENSIONS = new Set([
  'py', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'sh', 'bash', 'zsh', 'rb', 'pl', 'r', 'ps1', 'bat',
  'go', 'rs', 'java', 'c', 'cpp', 'h', 'hpp', 'sql', 'html', 'css', 'svg', 'json', 'yaml', 'yml',
  'toml', 'md', 'markdown', 'txt', 'csv', 'ipynb', 'png', 'jpg', 'jpeg', 'gif', 'mp3', 'wav',
  'm4a', 'mp4', 'pdf', 'xlsx', 'docx', 'pptx',
]);
const INTERPRETER_RE =
  /\b(?:python3?|node|bash|sh|ruby|perl|Rscript)\s+([A-Za-z0-9_.\/-]+\.[A-Za-z0-9]{1,10})\b/g;
const BACKTICK_PATH_RE = /`([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+\.[A-Za-z0-9]{1,10})`/g;

/**
 * Blank out EVERY `.claude/skills/<id>/…` and `.puppeteer/skills/<id>/…` span before R4 runs —
 * regardless of whether `id` is this entry's own slug or another skill's. Own-slug spans are
 * already fully handled by R2 (which extracts the REST correctly, relative to skill root); if
 * R4's looser backtick/interpreter regex were left to also see them, it would re-record the
 * SAME reference under its full `.claude/skills/<slug>/REST` form as a SECOND, spurious
 * candidate (that literal nested path is never itself a payload path, so it would misfire as
 * missing). Another skill's own bundle path is simply not a reference this entry can be
 * "missing" — see FALSE-POSITIVE FILTERS in the module header. Replaced with `#` of equal
 * length so string offsets stay stable (no other rule depends on offsets here, but it keeps
 * the transform boring to reason about).
 */
function maskSkillNamespaceRefs(body) {
  const re = /\.(?:claude|puppeteer)\/skills\/[A-Za-z0-9._-]+\/[^\s`)\]]*/g;
  return body.replace(re, (m) => '#'.repeat(m.length));
}

/**
 * Extract every candidate bundle-file ref from a SKILL.md body, tagged with the rule that
 * found it AND ~80 chars of text immediately BEFORE and AFTER the match (`contextBefore`,
 * `contextAfter`) — used by `falsePositiveReason` to catch the "this is explicitly someone
 * ELSE's file" phrasing a human author actually writes (see that function's doc comment).
 * Dedup by ref text — a ref found by multiple rules keeps the highest-confidence rule tag
 * (r1 > r2 > r3 > r4).
 */
function extractCandidateRefs(body, ownSlug) {
  const RULE_RANK = { r1: 0, r2: 1, r3: 2, r4: 3 };
  const found = new Map(); // ref -> {rule, contextBefore, contextAfter}

  const record = (ref, rule, contextBefore, contextAfter) => {
    const clean = ref.replace(/^(?:\.\/|~\/)+/, '').replace(/\/+$/, '');
    if (clean.length === 0) return;
    const prior = found.get(clean);
    if (!prior || RULE_RANK[rule] < RULE_RANK[prior.rule]) {
      found.set(clean, { rule, contextBefore, contextAfter });
    }
  };
  // `ref` is always a literal substring of `text` at-or-after `m.index` (every regex below
  // captures it verbatim, no escaping) — locate its exact span to slice real before/after text.
  const contextFor = (text, m, ref) => {
    const start = text.indexOf(ref, m.index);
    const end = start < 0 ? m.index : start + ref.length;
    return {
      before: text.slice(Math.max(0, (start < 0 ? m.index : start) - 80), start < 0 ? m.index : start),
      after: text.slice(end, end + 100),
    };
  };

  for (const re of [R1_LOOSE_RE, R1_REFERENCE_RE]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(body)) !== null) {
      const c = contextFor(body, m, m[2]);
      record(m[2], 'r1', c.before, c.after);
    }
  }

  R3_HELPER_RE.lastIndex = 0;
  {
    let m;
    while ((m = R3_HELPER_RE.exec(body)) !== null) {
      const c = contextFor(body, m, m[1]);
      record(m[1], 'r3', c.before, c.after);
    }
  }

  const ownIds = new Set([ownSlug]);
  const r2Re = new RegExp(
    `(?:\\.\\/|~\\/)?\\.(?:claude|puppeteer)\\/skills\\/(${[...ownIds].map(escapeRegExp).join('|')})\\/([A-Za-z0-9._\\/-]+)`,
    'g',
  );
  {
    let m;
    while ((m = r2Re.exec(body)) !== null) {
      const c = contextFor(body, m, m[2]);
      record(m[2], 'r2', c.before, c.after);
    }
  }

  const cleanedForR4 = maskSkillNamespaceRefs(body);
  INTERPRETER_RE.lastIndex = 0;
  {
    let m;
    while ((m = INTERPRETER_RE.exec(cleanedForR4)) !== null) {
      const ext = m[1].split('.').pop()?.toLowerCase();
      if (ext && KNOWN_EXTENSIONS.has(ext)) {
        const c = contextFor(cleanedForR4, m, m[1]);
        record(m[1], 'r4', c.before, c.after);
      }
    }
  }
  BACKTICK_PATH_RE.lastIndex = 0;
  {
    let m;
    while ((m = BACKTICK_PATH_RE.exec(cleanedForR4)) !== null) {
      const ext = m[1].split('.').pop()?.toLowerCase();
      if (ext && KNOWN_EXTENSIONS.has(ext)) {
        const c = contextFor(cleanedForR4, m, m[1]);
        record(m[1], 'r4', c.before, c.after);
      }
    }
  }

  return found; // Map<ref, {rule, contextBefore, contextAfter}>
}

// ---------------------------------------------------------------------------
// false-positive filters (see module header) — split into two tiers that run at DIFFERENT
// points in the classification order (see `auditOne`):
//
//   INTENT filters run BEFORE the ground-truth repo search. They fire when the AUTHOR
//   explicitly says, in plain English, that a ref is someone else's file — at that point
//   whether the file happens to exist somewhere in the repo is irrelevant; the author already
//   told us it is not this entry's own bundle dependency. Verified by hand against real
//   entries during this audit's development:
//     - `citypaul-tdd`/`citypaul-testing`: "...load the `mutation-testing` skill and use its
//       `resources/mutator-rules.md`..." (the phrase precedes the ref, not immediately)
//     - `citypaul-ddd`: "...see `claude/.claude/skills/REFERENCES.md` in the source repo
//       (https://github.com/citypaul/.dotfiles) — that file is not..." (phrase follows it)
//     - `netlify-ai-gateway`: "...(see `netlify-blobs/SKILL.md`)..." — structural: `<x>/SKILL.md`
//       is always another skill's manifest, never this entry's own.
//   Getting these WRONG in the other direction (treating ground truth as decisive here) is
//   exactly the bug this two-tier split fixes: a cross-skill reference's target genuinely DOES
//   exist in the repo (it's a real sibling skill), so a plain "does it exist?" check reports
//   FIXABLE on something that was never broken.
//
//   SHAPE filters run AFTER the ground-truth search, ONLY when nothing was found anywhere in
//   the repo. These are about the path's superficial shape (a template var, a URL, an absolute
//   path, a generated-output dir), not authorial intent — a real match should still win over a
//   shape-based guess (a file that happens to also look like a template var is still a file).
// ---------------------------------------------------------------------------

/** INTENT filters — checked BEFORE the repo search; see block comment above. */
function intentFalsePositiveReason(ref, contextBefore, contextAfter) {
  // Structural: `<name>/SKILL.md` (a top-level dir immediately followed by SKILL.md) is, by
  // construction, always ANOTHER skill's manifest — this entry's own SKILL.md is always at
  // ref `SKILL.md` with no prefix once resolved relative to its own dir, never `<x>/SKILL.md`.
  if (/^[^/]+\/SKILL\.md$/.test(ref)) return 'cross-skill-manifest-reference';
  // "the `<other-name>` skill['s] ..." (backtick-quoted) OR "the <other-name> skill['s] ..."
  // (bare, but ONLY a hyphenated lowercase identifier — real skill slugs are hyphenated;
  // this excludes generic English like "the skill", "this skill", "a skill") ANYWHERE in the
  // trailing window before the ref — not anchored to the ref's immediate boundary, because
  // real authors interpose a few more words ("...the `mutation-testing` skill AND USE ITS
  // `resources/mutator-rules.md`..."; "...see the hexagonal-architecture skill's
  // `resources/worked-example.md`.").
  if (/(?:`[A-Za-z0-9._-]+`|\b[a-z][a-z0-9]*(?:-[a-z0-9]+)+\b)\s+skill\b/i.test(contextBefore)) {
    return 'cross-skill-reference (author names another skill immediately before the ref)';
  }
  // contextAfter starts with whatever closing delimiter ended the ref (a backtick, quote, or
  // paren) before any prose resumes — strip a few of those before testing the phrase.
  if (/^[`'")\]]{0,3}\s*in the source repo\b/i.test(contextAfter)) {
    return 'external-source-repo-reference (author says "in the source repo")';
  }
  return undefined;
}

/** SHAPE filters — checked AFTER the repo search comes up empty; see block comment above. */
function shapeFalsePositiveReason(ref) {
  if (ref.includes('${') || ref.includes('{{') || ref.includes('{') || ref.includes('<') || ref.includes('>')) {
    return 'template-placeholder';
  }
  if (ref.includes('://')) return 'url';
  if (ref.startsWith('/')) return 'absolute-path';
  const firstSeg = ref.split('/')[0];
  if (['dist', 'build', 'out', 'coverage', 'node_modules', '.git', '__pycache__', 'venv', '.venv', 'site-packages'].includes(firstSeg)) {
    return 'generated-output-path';
  }
  if (/path\/to\/|your-project|my-project|yourusername|example\.com/i.test(ref)) return 'placeholder-example';
  return undefined;
}

// ---------------------------------------------------------------------------
// classification
// ---------------------------------------------------------------------------

/** True iff `ref` contains a real `..` PATH SEGMENT (not merely the two characters — `..foo`
 * and `a..b` are ordinary names). */
function hasDotDotSegment(ref) {
  return ref.split('/').includes('..');
}

/**
 * Resolve a `..`-bearing ref against `baseDir` (the directory of the SKILL.md that wrote it),
 * POSIX-normalised, and return the repo-root-relative result. Returns undefined when the ref
 * climbs ABOVE the repo root (`../../../../etc/passwd` shapes): such a path is by construction
 * not a file in this repo, and normalising the leftover `..` away — which is what a naive
 * `normalize()` + `startsWith` check would silently do — would fabricate a repo path that was
 * never referenced. An unresolvable ref is left to fall through to the other buckets.
 */
function resolveRelativeRef(ref, baseDir) {
  const joined = baseDir.length > 0 ? `${baseDir}/${ref}` : ref;
  const normalized = posixPath.normalize(joined);
  if (normalized === '..' || normalized.startsWith('../') || normalized.startsWith('/')) return undefined;
  return normalized;
}

/**
 * `(../)+<dir>/SKILL.md` — a reference to ANOTHER skill's manifest, reached by climbing OUT of
 * the referencing skill's own directory. Structurally distinct from the prefix-less
 * `<x>/SKILL.md` shape that `intentFalsePositiveReason` already treats as a cross-skill
 * mention: this one names a SIBLING in the same skills root, which is precisely the layout a
 * real install reproduces (`<root>/.puppeteer/skills/<slug>/`), so it CAN be made to resolve —
 * by publishing that sibling as its own catalogue entry, never by a mapping on this one.
 */
const SIBLING_SKILL_MANIFEST_RE = /^(?:\.\.\/)+([^/]+)\/SKILL\.md$/;

/**
 * Index every catalogue entry by the upstream subtree(s) it pins: `owner/repo#<from>` -> the
 * slugs pinned exactly there. Built from the WHOLE catalogue (never the audited slice) so a
 * `--slugs` run classifies sibling references identically to a full run.
 */
function indexPublishedSubtrees(allEntries) {
  const index = new Map();
  for (const entry of allEntries) {
    const parsed = parseGithubOwnerRepo(entry.sourceUrl ?? '');
    if (!parsed) continue;
    let mappings;
    try {
      mappings = curatedUpstreamMappings(entry);
    } catch {
      continue; // an unresolvable entry is the audit's own error path, not this index's problem.
    }
    for (const m of mappings) {
      const key = `${parsed.owner}/${parsed.repo}#${m.from}`;
      const slugs = index.get(key);
      if (slugs) slugs.push(entry.slug);
      else index.set(key, [entry.slug]);
    }
  }
  return index;
}

/**
 * Is the sibling skill this ref points at already published as its own catalogue entry, pinned
 * exactly at that directory AND under a slug equal to the directory's name? Both halves matter:
 * the pin is what makes the file installable at all, and the slug is what decides the directory
 * it lands in — `<root>/.puppeteer/skills/<slug>/` — which is the very path segment the `../`
 * in the ref walks back into. A sibling published under a DIFFERENT slug does not make the ref
 * resolve, so it does not clear the finding.
 */
function publishedSiblingSlug(publishedSubtrees, owner, repo, resolvedSiblingPath) {
  const siblingDir = posixPath.dirname(resolvedSiblingPath);
  const expectedSlug = posixPath.basename(siblingDir);
  const slugs = publishedSubtrees.get(`${owner}/${repo}#${siblingDir}`) ?? [];
  return slugs.find((s) => s === expectedSlug);
}

/**
 * Search the FULL repo tree (repo-root-relative paths) for `ref`, in three passes, MOST
 * LIKELY-CORRECT interpretation first — order matters only for which `basis` gets reported
 * when more than one matches, all are still ground truth (the file really exists somewhere):
 *   1. 'repo-root'  — `ref` matches a repo-root-relative path EXACTLY. This is the
 *      digitalsamba precedent shape: a multi-skill/plugin bundle whose nested SKILL.md files
 *      reference SIBLING top-level dirs (`tools/`, `scripts/`) that live at the REPO ROOT, not
 *      under any one skill's own subtree — the shape the real fix (repin whole repo, identity
 *      mappings per top dir) addressed. Checked FIRST because it is the proven-precedent case.
 *   2. 'same-dir'   — `${originalSkillDir}/${ref}` matches exactly, i.e. the file lives right
 *      next to the SKILL.md that references it (ordinary self-contained-skill semantics —
 *      `loader.ts::rewriteBundlePaths`'s bare-prefix rule DOES confine to the skill's own dir
 *      at runtime, so if this is what's needed, it should normally already be included by the
 *      SAME mapping that produced the SKILL.md itself; a same-dir-only hit here is a signal to
 *      double check the existing mapping's scope, not necessarily a missing mapping).
 *   3. 'suffix'     — best-effort: the shortest repo path ending in `/${ref}`. Lowest
 *      confidence; reported so nothing is hidden, but the suggested fix is left to a human.
 *
 * A ref carrying a `..` segment short-circuits ALL THREE: `..` is only meaningful relative to
 * the directory of the SKILL.md that wrote it, and none of the three passes can resolve it
 * (repo-root and same-dir compare unnormalised strings, and no repo path ever ends in
 * `/../x/y`), so before this pass existed such a ref fell all the way through to
 * UPSTREAM-MISSING — "exists nowhere in the repo" said about a file one directory over. It gets
 * its own normalised pass (basis `relative`) instead.
 */
function findInRepo(repoPaths, ref, originalSkillDir) {
  if (hasDotDotSegment(ref)) {
    const resolved = resolveRelativeRef(ref, originalSkillDir ?? '');
    return resolved !== undefined && repoPaths.has(resolved)
      ? { path: resolved, exact: true, basis: 'relative' }
      : undefined;
  }
  if (repoPaths.has(ref)) return { path: ref, exact: true, basis: 'repo-root' };
  if (originalSkillDir) {
    const sameDir = `${originalSkillDir}/${ref}`;
    if (repoPaths.has(sameDir)) return { path: sameDir, exact: true, basis: 'same-dir' };
  }
  let best;
  const suffix = `/${ref}`;
  for (const p of repoPaths) {
    if (p.endsWith(suffix) && (!best || p.length < best.length)) best = p;
  }
  return best ? { path: best, exact: false, basis: 'suffix' } : undefined;
}

function suggestMapping(ref, hit, existingMappings, skillMdPayloadDir) {
  if (hit.basis === 'repo-root') {
    const dir = posixPath.dirname(ref);
    const from = dir === '.' ? ref : dir;
    const to = dir === '.' ? '' : dir;
    const already = existingMappings.find((m) => m.from === from);
    if (already) {
      return {
        note: `mapping from='${from}' already exists (to='${already.to}') but the file is still missing from the payload — investigate (possible extraction/tar-cap bug), do not blindly re-add`,
      };
    }
    if (skillMdPayloadDir === '') {
      return { from, to, kind: 'root-expansion (identity) — add this mapping' };
    }
    return {
      from,
      to,
      kind:
        `root-expansion at repo root, BUT this ref is read from a NESTED SKILL.md ` +
        `('${skillMdPayloadDir}/SKILL.md') inside a multi-skill payload — a plain root mapping ` +
        `places the file at payload root, not necessarily where that nested skill resolves bare ` +
        `refs from. Check whether this entry needs the digitalsamba-video-toolkit treatment ` +
        `instead: re-pin upstreamPath to '.' (whole repo) with identity mappings for every ` +
        `top-level dir actually referenced, so repo-root-relative refs resolve for ALL nested SKILL.md files at once`,
    };
  }
  if (hit.basis === 'relative') {
    const siblingDir = posixPath.dirname(hit.path);
    const asSibling = SIBLING_SKILL_MANIFEST_RE.test(ref);
    return {
      note:
        `the ref climbs OUT of this entry's pinned subtree and lands at '${hit.path}' — a ` +
        `sibling of the referencing SKILL.md's own directory. NO mapping on this entry can ` +
        `satisfy it: a mapping only ever places files INSIDE this skill's own installed ` +
        `directory, while '${ref}' resolves one level above it. ` +
        (asSibling
          ? `It names another SKILL's manifest, so the fix is to publish '${siblingDir}' as its ` +
            `OWN catalogue entry with slug '${posixPath.basename(siblingDir)}' (install layout ` +
            `is '<root>/.puppeteer/skills/<slug>/', so the two land side by side and the ` +
            `relative path resolves literally) — this finding clears itself once that entry exists.`
          : `Either re-pin this entry at the common parent directory (accepting the merged ` +
            `payload, the digitalsamba-video-toolkit treatment) or treat the ref as external.`),
    };
  }
  if (hit.basis === 'same-dir') {
    return {
      note:
        `found right next to the referencing SKILL.md, at '${hit.path}' — this should already be ` +
        `covered by whichever mapping produced that SKILL.md; if it is still missing, that mapping's ` +
        `'from' is narrower than the file's real directory — widen it to include '${posixPath.dirname(hit.path)}'`,
    };
  }
  return {
    note: `only a lower-confidence SUFFIX match was found, at '${hit.path}' — review manually before proposing a mapping`,
  };
}

async function auditOne(entry, archiveCache, publishedSubtrees) {
  const result = { slug: entry.slug, findings: [], error: undefined };
  const parsed = parseGithubOwnerRepo(entry.sourceUrl ?? '');
  const sha = (entry.upstreamCommit ?? '').trim();
  if (!parsed || sha.length === 0) {
    result.error = `unparseable sourceUrl/upstreamCommit ('${entry.sourceUrl}'@'${sha}')`;
    return result;
  }

  const archiveKey = `${parsed.owner}/${parsed.repo}@${sha}`;
  let entries = archiveCache.get(archiveKey);
  if (!entries) {
    try {
      entries = await fetchArchiveEntries(parsed.owner, parsed.repo, sha);
      archiveCache.set(archiveKey, entries);
    } catch (err) {
      result.error = `could not fetch upstream archive ${archiveKey}: ${err instanceof Error ? err.message : String(err)}`;
      return result;
    }
  }

  const mappings = curatedUpstreamMappings(entry);
  let payload;
  try {
    payload = mapUpstreamTarEntriesWithProvenance(entries, mappings, archiveKey);
  } catch (err) {
    result.error = `upstream path did not resolve: ${err instanceof Error ? err.message : String(err)}`;
    return result;
  }

  // Scan EVERY SKILL.md in the payload, not just a root one — a multi-skill/plugin bundle
  // (digitalsamba-video-toolkit: 13 SKILL.md files, none at payload root) has no single
  // canonical entry point, and the bug class this audit hunts can live in any of them.
  const skillMds = payload.filter((f) => f.path === 'SKILL.md' || f.path.endsWith('/SKILL.md'));
  if (skillMds.length === 0) {
    result.error = 'no SKILL.md anywhere in the resolved payload (upstreamPaths mapping problem, out of scope for this audit — flagged, not fixed here)';
    return result;
  }

  const payloadPaths = new Set(payload.map((f) => f.path));
  const repoPaths = new Set(repoFilePaths(entries));
  const seenRefKeys = new Set(); // dedupe identical (skillMdPath, ref) across nothing — kept for clarity, refs are per-file already.

  for (const skillMd of skillMds) {
    const text = decodeUtf8OrUndefined(skillMd.data);
    if (text === undefined) continue; // binary "SKILL.md" (shouldn't happen) — skip, not our bug class.
    const body = stripFrontmatter(text);
    const skillMdPayloadDir = skillMd.path === 'SKILL.md' ? '' : posixPath.dirname(skillMd.path);
    const skillMdOriginalDir = posixPath.dirname(skillMd.originalPath);

    const candidates = extractCandidateRefs(body, entry.slug);
    for (const [ref, { rule, contextBefore, contextAfter }] of candidates) {
      // A ref can legitimately resolve EITHER same-dir (ordinary self-contained-skill
      // semantics -- loader.ts's bare-prefix rewrite confines to the referencing SKILL.md's
      // own directory) OR at payload root (plugin/umbrella-bundle semantics, where the whole
      // repo's original relative layout was preserved 1:1 -- the digitalsamba-video-toolkit
      // shape, e.g. a top-level identity mapping tools->tools) OR, for a BARE single/multi
      // -segment ref with no directory of its own, already present in the payload under SOME
      // other directory (a doc that states the full path once and then refers to the file
      // bare in a follow-up shell snippet, e.g. literature-review's `scripts/search_databases.py`
      // stated in full, then just `search_databases.py` one line later assuming the reader `cd`ed
      // into `scripts/`). Checking all three before calling a ref "missing" is what avoids a wall
      // of false FIXABLE findings on exactly these shapes.
      // `..` segments are normalised HERE too, not only in the repo search: inside a
      // multi-skill payload two bundled skills can legitimately point at each other with
      // `../sibling/SKILL.md`, and the raw string would match no payload path, turning a ref
      // that IS shipped into a finding.
      const sameDirCandidate = hasDotDotSegment(ref)
        ? resolveRelativeRef(ref, skillMdPayloadDir)
        : skillMdPayloadDir === ''
          ? ref
          : `${skillMdPayloadDir}/${ref}`;
      const alreadyElsewhereInPayload = [...payloadPaths].some((p) => p === ref || p.endsWith(`/${ref}`));
      if ((sameDirCandidate !== undefined && payloadPaths.has(sameDirCandidate)) || payloadPaths.has(ref) || alreadyElsewhereInPayload) {
        continue; // present -- not a finding.
      }
      const dedupeKey = `${skillMd.path} ${ref}`;
      if (seenRefKeys.has(dedupeKey)) continue;
      seenRefKeys.add(dedupeKey);

      // INTENT filters run FIRST — before ground truth — because they encode the AUTHOR
      // explicitly saying "this is someone else's file"; whether it happens to exist in the
      // repo is irrelevant at that point (it usually does — it's a real sibling skill).
      const intentReason = intentFalsePositiveReason(ref, contextBefore, contextAfter);
      if (intentReason) {
        result.findings.push({ ref, rule, skillMdPath: skillMd.path, classification: 'FALSE-POSITIVE', reason: intentReason });
        continue;
      }

      const hit = findInRepo(repoPaths, ref, skillMdOriginalDir === '.' ? '' : skillMdOriginalDir);
      // A `../<x>/SKILL.md` whose sibling entry is ALREADY in the catalogue is satisfied by
      // co-installation, not by any mapping here (see `publishedSiblingSlug`) — so it is a
      // FALSE-POSITIVE *for this entry*, and one that names the entry that resolves it. This
      // check needs the ground-truth hit (it is the hit's resolved path that identifies the
      // sibling directory), which is why it sits AFTER the repo search and not with the other
      // intent filters.
      if (hit && hit.basis === 'relative' && SIBLING_SKILL_MANIFEST_RE.test(ref)) {
        const siblingSlug = publishedSiblingSlug(publishedSubtrees, parsed.owner, parsed.repo, hit.path);
        if (siblingSlug) {
          result.findings.push({
            ref,
            rule,
            skillMdPath: skillMd.path,
            classification: 'FALSE-POSITIVE',
            reason: `sibling-skill-published-separately (installed side by side as catalogue entry '${siblingSlug}', pinned at '${posixPath.dirname(hit.path)}')`,
          });
          continue;
        }
      }
      if (hit) {
        result.findings.push({
          ref,
          rule,
          skillMdPath: skillMd.path,
          classification: 'FIXABLE',
          foundAt: hit.path,
          exact: hit.exact,
          basis: hit.basis,
          suggestedMapping: suggestMapping(ref, hit, mappings, skillMdPayloadDir),
        });
        continue;
      }
      const shapeReason = shapeFalsePositiveReason(ref);
      if (shapeReason) {
        result.findings.push({ ref, rule, skillMdPath: skillMd.path, classification: 'FALSE-POSITIVE', reason: shapeReason });
        continue;
      }
      result.findings.push({ ref, rule, skillMdPath: skillMd.path, classification: 'UPSTREAM-MISSING' });
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// small concurrency pool (no deps)
// ---------------------------------------------------------------------------

async function runPool(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function lane() {
    while (next < items.length) {
      const i = next;
      next += 1;
      results[i] = await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => lane()));
  return results;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const catalog = JSON.parse(readFileSync(CATALOG_PATH, 'utf8'));
  const allEntries = catalog.skills ?? [];
  const targets = args.slugs
    ? allEntries.filter((e) => args.slugs.includes(e.slug))
    : allEntries;

  if (args.slugs) {
    const known = new Set(allEntries.map((e) => e.slug));
    const missing = args.slugs.filter((s) => !known.has(s));
    if (missing.length > 0) {
      console.error(`audit-bundle-refs: unknown slug(s): ${missing.join(', ')}`);
      process.exit(2);
    }
  }

  console.log(`audit-bundle-refs: auditing ${targets.length} catalog entrie(s), concurrency ${args.concurrency}, cache ${CACHE_DIR}`);

  const archiveCache = new Map();
  // Indexed over ALL entries, not `targets` — a `--slugs` run must classify a sibling-skill
  // reference exactly as the full run does (see `indexPublishedSubtrees`).
  const publishedSubtrees = indexPublishedSubtrees(allEntries);
  let done = 0;
  const results = await runPool(targets, args.concurrency, async (entry) => {
    const r = await auditOne(entry, archiveCache, publishedSubtrees);
    done += 1;
    process.stderr.write(`\r  [${done}/${targets.length}] ${entry.slug.padEnd(40)}`);
    return r;
  });
  process.stderr.write('\n');

  const errors = results.filter((r) => r.error);
  const fixable = [];
  const upstreamMissing = [];
  const falsePositives = [];
  // NOTE THE DENOMINATOR (see the module header's honesty note): these count FINDINGS per
  // rule — a candidate that resolved inside the payload never reaches this loop and is never
  // counted. The fields are named `*FindingCount` so the published ratio cannot be read as the
  // rule's precision over everything it matched in the SKILL.md text.
  let r1r2r3Findings = 0;
  let r1r2r3FalsePositive = 0;
  let r4Findings = 0;
  let r4FalsePositive = 0;

  for (const r of results) {
    for (const f of r.findings) {
      const isR4 = f.rule === 'r4';
      if (isR4) r4Findings += 1; else r1r2r3Findings += 1;
      if (f.classification === 'FIXABLE') fixable.push({ slug: r.slug, ...f });
      else if (f.classification === 'UPSTREAM-MISSING') upstreamMissing.push({ slug: r.slug, ...f });
      else {
        falsePositives.push({ slug: r.slug, ...f });
        if (isR4) r4FalsePositive += 1; else r1r2r3FalsePositive += 1;
      }
    }
  }

  const report = {
    // v2 (2026-07-27): `heuristics.r1r2r3Total`/`r4Total` renamed to `*FindingCount` — the old
    // names claimed a denominator ("candidates") the counters never had.
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    entriesAudited: targets.length,
    entriesErrored: errors.length,
    counts: {
      fixable: fixable.length,
      upstreamMissing: upstreamMissing.length,
      falsePositive: falsePositives.length,
    },
    heuristics: {
      r1r2r3FindingCount: r1r2r3Findings,
      r1r2r3FalsePositiveCount: r1r2r3FalsePositive,
      r4FindingCount: r4Findings,
      r4FalsePositiveCount: r4FalsePositive,
    },
    errors: errors.map((e) => ({ slug: e.slug, error: e.error })),
    fixable,
    upstreamMissing,
    falsePositives,
  };

  if (args.jsonOut) {
    writeFileSync(args.jsonOut, JSON.stringify(report, null, 2));
    console.log(`audit-bundle-refs: wrote JSON report to ${args.jsonOut}`);
  }

  console.log('\n=== audit-bundle-refs summary ===');
  console.log(`entries audited: ${targets.length}  (errored: ${errors.length})`);
  console.log(`FIXABLE: ${fixable.length}   UPSTREAM-MISSING: ${upstreamMissing.length}   FALSE-POSITIVE: ${falsePositives.length}`);
  console.log(`R1/R2/R3 (narrow, proven) findings: ${r1r2r3Findings}, of which false-positive: ${r1r2r3FalsePositive}`);
  console.log(`R4 (new heuristic) findings: ${r4Findings}, of which false-positive: ${r4FalsePositive}`);

  if (errors.length > 0) {
    console.log('\n--- errors (could not audit) ---');
    for (const e of errors) console.log(`  ${e.slug}: ${e.error}`);
  }

  if (fixable.length > 0) {
    console.log('\n--- FIXABLE ---');
    for (const f of fixable) {
      console.log(`  [${f.slug}] (${f.skillMdPath}) ${f.ref} (rule ${f.rule}, basis ${f.basis}) -> found at '${f.foundAt}'${f.exact ? '' : ' (suffix match)'}`);
      if (f.suggestedMapping.note) console.log(`      ${f.suggestedMapping.note}`);
      else console.log(`      suggest mapping {from:'${f.suggestedMapping.from}', to:'${f.suggestedMapping.to}'} (${f.suggestedMapping.kind})`);
    }
  }

  if (upstreamMissing.length > 0) {
    console.log('\n--- UPSTREAM-MISSING ---');
    for (const f of upstreamMissing) console.log(`  [${f.slug}] (${f.skillMdPath}) ${f.ref} (rule ${f.rule})`);
  }

  if (falsePositives.length > 0) {
    console.log('\n--- FALSE-POSITIVE ---');
    for (const f of falsePositives) console.log(`  [${f.slug}] (${f.skillMdPath}) ${f.ref} (rule ${f.rule}, reason: ${f.reason})`);
  }

  if (fixable.length > 0) {
    console.error(`\naudit-bundle-refs: ${fixable.length} FIXABLE finding(s) — see above.`);
    process.exit(1);
  }
  console.log('\naudit-bundle-refs: no FIXABLE findings.');
}

main().catch((err) => {
  console.error(`audit-bundle-refs: unexpected error: ${err instanceof Error ? err.stack : String(err)}`);
  process.exit(1);
});
