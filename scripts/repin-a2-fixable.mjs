#!/usr/bin/env node
/**
 * repin-a2-fixable.mjs — A2 (puppeteer-skill-store): re-pin the FIXABLE findings
 * from A1's `audit-bundle-refs.mjs` run (2026-07-27, `.audit-cache/audit-bundle-refs-report-2026-07-27.json`,
 * 25 findings across 10 slugs).
 *
 * A ONE-SHOT script (like `propose-pin-bumps.mjs`'s bump logic, minus the
 * GitHub-API discovery half — A1 already did discovery). For every slug in
 * `REPINS` below it: widens `upstreamPaths` (converting a bare `upstreamPath`
 * single-path entry into a multi-path one, or adding to an existing
 * `upstreamPaths` array) to `curatedUpstreamMappings` INCLUDE the file(s) the
 * skill's own SKILL.md cites; re-fetches the SAME pinned commit (no
 * `upstreamCommit` change — this is a mapping fix, not a version bump) from
 * `.audit-cache/` (A1's disk cache, so this never hits the network); re-hashes
 * with the canonical `hashSkillFileBytes` scheme; bumps `catalogRevision`;
 * demotes `byteAudit` from `vendored-match` to `upstream-differs` for every
 * entry whose payload widens (the SAME reasoning `propose-pin-bumps.mjs`
 * documents at length: a `vendored-match` claim is "byte-identical to the
 * payload a human reviewed", and a human never read the newly-added files —
 * see that script's header, "WHY THE DEMOTION IS NOT OPTIONAL"); and appends
 * a measured `' · repinned-<reason>-2026-07-27 (…)'` suffix to `reviewed.verdict`,
 * the same provenance-preserving pattern `digitalsamba-video-toolkit`'s
 * 2026-07-26 whole-repo re-pin established (see that entry in catalog.json).
 *
 * TWO of the 10 audit-flagged slugs are DELIBERATELY NOT re-pinned —
 * `promptfoo-redteam-plugin-development` (10 refs — A1's prose said 9, the
 * measured JSON/re-audit says 10; the exact count matters here so it is
 * corrected, not repeated) and `xiaolai-claude-code`
 * (1 ref). A1's manual review (not just the mechanical classifier) already
 * established both as false positives: the "missing" files are the HOST
 * repo's own application source / manifest, cited as documentation about
 * where a contributor edits or what a convention looks like — not bundle
 * dependencies this skill's payload needs to function. Pulling them in would
 * misrepresent the payload for zero functional benefit (promptfoo: ~300KB
 * across 9 core TypeScript files spanning the product's redteam/prompt
 * subsystems — the exact "repo enorme per un riferimento marginale" shape the
 * A2 task brief calls out by name; xiaolai: a trivial 632-byte file, but it is
 * the REPO'S OWN 8-skill-umbrella plugin manifest describing an entirely
 * different scope, cited in a table as a documentation example of the
 * Claude Code plugin.json convention, not a file this "claude-code" sub-skill
 * reads or executes). For these two, only `reviewed.verdict` is touched, with
 * a `' · audit-exception-2026-07-27 (…)'` suffix (never `' · repinned-…'` —
 * nothing was actually re-pinned) recording WHY the mechanical audit's
 * FIXABLE verdict is knowingly left unfixed. `catalogRevision` is bumped (a
 * verdict edit is a real row edit); `upstreamPaths`/`upstreamPath`/
 * `contentHash`/`byteAudit` are untouched.
 *
 * CONSEQUENCE FOR THE END-OF-RUN AUDIT (documented, not swept under the rug):
 * re-running `audit-bundle-refs.mjs` after this script drops FIXABLE from 25
 * to 10 (all 10 remaining findings are promptfoo's 9 + xiaolai's 1) — NOT to
 * zero. The classifier's ground-truth check ("does the file exist anywhere in
 * the repo?") cannot distinguish "a real bundle dependency" from "a
 * documentation pointer into the host's own source", so it will keep flagging
 * these two, correctly, until a future task teaches it that distinction (A1
 * deliberately declined to add such a filter — "non filtrabili in modo
 * generico senza rischio" — judging a narrow two-slug carve-out not worth the
 * risk of a bad precedent for a GENERIC classifier). This script's job is the
 * catalog fix, not the classifier; the two exceptions are recorded in
 * `reviewed.verdict` so the decision has a durable, inspectable home even
 * though the mechanical count cannot reach zero.
 *
 * USAGE: node scripts/repin-a2-fixable.mjs [--dry-run]
 *   --dry-run  computes and prints every change but writes nothing.
 *
 * Reads tarballs from `.audit-cache/` (A1's cache, already warm for every
 * slug this script touches — see `AUDIT_TARBALL_CACHE` in
 * `audit-bundle-refs.mjs`); falls back to a live codeload fetch (and caches
 * it there) if a given owner/repo@sha is not already cached.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseTar } from './lib/tar.mjs';
import {
  parseGithubOwnerRepo,
  codeloadTarballUrl,
  mapUpstreamTarEntries,
  hashSkillFileBytes,
} from './lib/upstream.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..');
const CATALOG_PATH = join(REPO_ROOT, 'catalog.json');
const CACHE_DIR = process.env.AUDIT_TARBALL_CACHE || join(REPO_ROOT, '.audit-cache');
const TAR_CAPS = { maxEntries: 20000, maxTotalBytes: 384 * 1024 * 1024 };
const DATE = '2026-07-27';

// ---------------------------------------------------------------------------
// the fix plan — one entry per slug, measured against the real upstream tree
// (see this script's header + the A2 handoff notes for how each was verified)
// ---------------------------------------------------------------------------

const REPINS = [
  {
    slug: 'brainstorming',
    upstreamPaths: [
      { from: 'skills/brainstorming', to: '' },
      { from: 'skills/brainstorming/visual-companion.md', to: 'skills/brainstorming' },
    ],
    demoteByteAudit: false, // already 'upstream-differs'
    verdictSuffix:
      "repinned-self-ref-duplicate-2026-07-27 (SKILL.md cita se stesso come 'skills/brainstorming/visual-companion.md', " +
      "il path pre-flattening del repo — il file ESISTE già nel payload flattenato come 'visual-companion.md'; " +
      "aggiunta una mappatura identity che lo duplica anche al path letterale citato, 0 byte di contenuto nuovo)",
  },
  {
    slug: 'browser-harness',
    upstreamPaths: [
      { from: 'SKILL.md', to: '' },
      { from: 'install.md', to: '' },
      { from: 'agent-workspace/agent_helpers.py', to: 'agent-workspace' },
      { from: 'interaction-skills', to: 'interaction-skills' },
    ],
    demoteByteAudit: true, // was 'vendored-match' on a 1-file payload; now widened, unreviewed
    verdictSuffix:
      "repinned-4-path-set-2026-07-27 (upstreamPath 'SKILL.md' installava UN file mentre il proprio SKILL.md " +
      // Byte counts are MEASURED (sum of file sizes in the tarball at the pin), not `du` output:
      // the first pass wrote "72KB"/"1.5MB", which were `du` block allocations for 17 and 109
      // small files — 5x and 1.2x the real bytes respectively.
      "richiede anche agent-workspace/agent_helpers.py, install.md e i 17 file di interaction-skills/ " +
      '(14.019 byte misurati — il "72KB" del primo giro era du a blocchi, non byte) — ' +
      'pin esteso a questi 4 path. agent-workspace/domain-skills/ ESCLUSO deliberatamente: 1.321.372 byte su 109 ' +
      'file di 99 playbook community per-sito, feature dormiente/opt-in dietro BH_DOMAIN_SKILLS=1 per lo stesso SKILL.md — ' +
      'eccezione dimensionale documentata, non pinnato)',
  },
  {
    slug: 'frontend-ui-engineering',
    upstreamPaths: [
      { from: 'skills/frontend-ui-engineering', to: '' },
      { from: 'references', to: 'references' },
    ],
    demoteByteAudit: true,
    verdictSuffix:
      "repinned-shared-references-2026-07-27 (references/accessibility-checklist.md è condiviso a repo-root " +
      'con altri 4 checklist dello stesso repo, 52KB totali; mappatura identity aggiunta references->references)',
  },
  {
    slug: 'geo-content-optimizer',
    upstreamPaths: [
      { from: 'build/geo-content-optimizer', to: '' },
      { from: 'memory', to: 'memory' },
    ],
    demoteByteAudit: true,
    verdictSuffix:
      "repinned-shared-memory-2026-07-27 (memory/hot-cache.md e memory/open-loops.md sono lo skeleton di stato-sessione " +
      "condiviso a repo-root, 1.9KB totali (governato da un cross-cutting/memory-management non catalogato, ma il file " +
      'esiste davvero al pin); mappatura identity aggiunta memory->memory)',
  },
  {
    slug: 'meta-tags-optimizer',
    upstreamPaths: [
      { from: 'build/meta-tags-optimizer', to: '' },
      { from: 'memory', to: 'memory' },
    ],
    demoteByteAudit: true,
    verdictSuffix:
      "repinned-shared-memory-2026-07-27 (stesso skeleton condiviso di geo-content-optimizer/seo-content-writer, " +
      '1.9KB totali; mappatura identity aggiunta memory->memory)',
  },
  {
    slug: 'seo-content-writer',
    upstreamPaths: [
      { from: 'build/seo-content-writer', to: '' },
      { from: 'memory', to: 'memory' },
    ],
    demoteByteAudit: true,
    verdictSuffix:
      "repinned-shared-memory-2026-07-27 (stesso skeleton condiviso di geo-content-optimizer/meta-tags-optimizer, " +
      '1.9KB totali; mappatura identity aggiunta memory->memory)',
  },
  {
    slug: 'market-research-reports',
    upstreamPaths: [
      { from: 'skills/market-research-reports', to: '' },
      { from: 'skills/market-research-reports/scripts', to: 'skills/market-research-reports/scripts' },
      { from: 'skills/scientific-schematics/scripts', to: 'skills/scientific-schematics/scripts' },
      { from: 'skills/generate-image/scripts', to: 'skills/generate-image/scripts' },
      { from: 'skills/research-lookup/scripts', to: 'skills/research-lookup/scripts' },
    ],
    demoteByteAudit: false, // already 'upstream-differs' (B3 gap-fill import)
    verdictSuffix:
      'repinned-sibling-scripts-2026-07-27 (4 riferimenti verificati script-per-script: 1 self-reference al proprio ' +
      "scripts/generate_market_visuals.py citato col path pre-flattening (stesso bug di brainstorming), 3 verso skill " +
      'sorelle NON catalogate dello stesso repo (scientific-schematics, generate-image, research-lookup) — tutti CLI ' +
      'standalone senza import locali (verificato leggendo i sorgenti); mappature identity aggiunte per i 4 scripts/ citati)',
  },
  {
    slug: 'peer-review',
    upstreamPaths: [
      { from: 'skills/peer-review', to: '' },
      { from: 'skills/scientific-slides/scripts', to: 'skills/scientific-slides/scripts' },
    ],
    demoteByteAudit: false, // already 'upstream-differs' (B3 gap-fill import)
    verdictSuffix:
      'repinned-sibling-script-2026-07-27 (pdf_to_images.py vive in skills/scientific-slides/scripts/, skill sorella ' +
      'NON catalogata dello stesso repo; script standalone senza import locali (verificato leggendo il sorgente); ' +
      'mappatura identity aggiunta skills/scientific-slides/scripts)',
  },
];

/** The 2 audit-flagged slugs deliberately left unfixed — see header. */
const EXCEPTIONS = [
  {
    slug: 'promptfoo-redteam-plugin-development',
    verdictSuffix:
      'audit-exception-2026-07-27 (10 refs verificati manualmente uno per uno — A1\'s report said 9 by prose slip, ' +
      "il re-audit misura 10: sono percorsi nel sorgente TypeScript DEL PRODOTTO promptfoo stesso (src/redteam/*, " +
      "src/prompts/grading.ts, site/docs/_shared/data/plugins.ts — ~300KB su 10 file, 6-76KB ciascuno), citati come " +
      "guida-CONTRIBUTOR (\"crea il file plugin qui\"), non come " +
      'dipendenze del bundle che questo skill usa/esegue — pinnarli gonfierebbe il payload con codice applicativo ' +
      'estraneo per zero beneficio funzionale. Lasciato FIXABLE nel classificatore meccanico (nessun filtro-intent ' +
      'generico aggiunto, per lo stesso motivo per cui A1 non lo ha aggiunto: rischio di sopprimere futuri finding reali)',
  },
  {
    slug: 'xiaolai-claude-code',
    verdictSuffix:
      "audit-exception-2026-07-27 (.claude-plugin/plugin.json esiste al pin (632B) ma è il manifest dell'INTERO repo " +
      'ombrello a 8 skill (anthropic-docs), tutt\'altro scope — citato in una tabella come esempio della convenzione ' +
      'plugin.json di Claude Code, non un file che questo sub-skill \'claude-code\' legge o esegue; pinnarlo produrrebbe ' +
      'un file morto e semanticamente fuorviante nel payload. Lasciato FIXABLE nel classificatore meccanico, stessa ' +
      'ragione di promptfoo (nessun filtro-intent generico aggiunto)',
  },
];

function loadCatalog() {
  return JSON.parse(readFileSync(CATALOG_PATH, 'utf8'));
}

function cacheFile(owner, repo, sha) {
  return join(CACHE_DIR, `${owner}__${repo}__${sha}.tgz`);
}

async function fetchArchiveEntries(owner, repo, sha) {
  const cached = cacheFile(owner, repo, sha);
  let gz;
  if (existsSync(cached)) {
    gz = readFileSync(cached);
  } else {
    const url = codeloadTarballUrl(owner, repo, sha);
    const res = await fetch(url, { headers: { accept: 'application/gzip,application/octet-stream,*/*' }, redirect: 'follow' });
    if (!res.ok) throw new Error(`codeload ${owner}/${repo}@${sha}: HTTP ${res.status}`);
    gz = Buffer.from(await res.arrayBuffer());
    if (gz.byteLength === 0) throw new Error(`codeload ${owner}/${repo}@${sha}: empty body`);
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(cached, gz);
  }
  const { entries, truncated } = parseTar(gunzipSync(gz), TAR_CAPS);
  if (truncated) throw new Error(`codeload ${owner}/${repo}@${sha}: archive exceeds caps`);
  return entries;
}

function appendVerdict(oldVerdict, suffix) {
  return `${oldVerdict} · ${suffix}`;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const catalog = loadCatalog();
  const bySlug = new Map(catalog.skills.map((e) => [e.slug, e]));
  const archiveCache = new Map();
  const changes = [];

  for (const plan of REPINS) {
    const entry = bySlug.get(plan.slug);
    if (!entry) throw new Error(`repin-a2-fixable: unknown slug '${plan.slug}'`);

    const parsed = parseGithubOwnerRepo(entry.sourceUrl ?? '');
    const sha = (entry.upstreamCommit ?? '').trim();
    if (!parsed || sha.length === 0) throw new Error(`repin-a2-fixable: '${plan.slug}' has no resolvable sourceUrl/upstreamCommit`);

    const archiveKey = `${parsed.owner}/${parsed.repo}@${sha}`;
    let entries = archiveCache.get(archiveKey);
    if (!entries) {
      entries = await fetchArchiveEntries(parsed.owner, parsed.repo, sha);
      archiveCache.set(archiveKey, entries);
    }

    const mappings = plan.upstreamPaths.map((m) => ({ from: m.from, to: m.to }));
    const files = mapUpstreamTarEntries(entries, mappings, archiveKey);
    const newHash = hashSkillFileBytes(files);
    const oldHash = entry.contentHash;
    const oldByteAudit = entry.byteAudit;
    const newByteAudit = plan.demoteByteAudit ? 'upstream-differs' : entry.byteAudit;

    changes.push({
      slug: plan.slug,
      kind: 'repin',
      oldHash,
      newHash,
      fileCount: files.length,
      oldByteAudit,
      newByteAudit,
      oldRevision: entry.catalogRevision ?? 1,
      newRevision: (entry.catalogRevision ?? 1) + 1,
      oldVerdict: entry.reviewed.verdict,
      newVerdict: appendVerdict(entry.reviewed.verdict, plan.verdictSuffix),
    });

    if (!dryRun) {
      entry.upstreamPaths = plan.upstreamPaths;
      entry.contentHash = newHash;
      entry.byteAudit = newByteAudit;
      entry.catalogRevision = (entry.catalogRevision ?? 1) + 1;
      entry.reviewed = { ...entry.reviewed, verdict: appendVerdict(entry.reviewed.verdict, plan.verdictSuffix) };
    }
  }

  for (const plan of EXCEPTIONS) {
    const entry = bySlug.get(plan.slug);
    if (!entry) throw new Error(`repin-a2-fixable: unknown slug '${plan.slug}'`);
    changes.push({
      slug: plan.slug,
      kind: 'exception',
      oldRevision: entry.catalogRevision ?? 1,
      newRevision: (entry.catalogRevision ?? 1) + 1,
      oldVerdict: entry.reviewed.verdict,
      newVerdict: appendVerdict(entry.reviewed.verdict, plan.verdictSuffix),
    });
    if (!dryRun) {
      entry.catalogRevision = (entry.catalogRevision ?? 1) + 1;
      entry.reviewed = { ...entry.reviewed, verdict: appendVerdict(entry.reviewed.verdict, plan.verdictSuffix) };
    }
  }

  console.log(`repin-a2-fixable: ${dryRun ? 'DRY RUN — ' : ''}${changes.length} entrie(s)`);
  for (const c of changes) {
    console.log(`\n[${c.slug}] (${c.kind})`);
    if (c.kind === 'repin') {
      console.log(`  contentHash: ${c.oldHash.slice(0, 12)}… -> ${c.newHash.slice(0, 12)}… (${c.fileCount} files)`);
      console.log(`  byteAudit:   ${c.oldByteAudit} -> ${c.newByteAudit}`);
    }
    console.log(`  catalogRevision: ${c.oldRevision} -> ${c.newRevision}`);
    console.log(`  verdict: ${c.newVerdict}`);
  }

  if (!dryRun) {
    // catalog.json's established on-disk formatting is 1-space indent, NO
    // trailing newline (verified against `git show HEAD:catalog.json` before
    // writing this) — matching it exactly keeps the diff to the actual
    // content change instead of a whole-file reformat noise bomb.
    writeFileSync(CATALOG_PATH, JSON.stringify(catalog, null, 1), 'utf8');
    console.log(`\nrepin-a2-fixable: wrote ${CATALOG_PATH}`);
  } else {
    console.log('\nrepin-a2-fixable: dry run — nothing written.');
  }
}

main().catch((err) => {
  console.error(`repin-a2-fixable: ${err instanceof Error ? err.stack : String(err)}`);
  process.exit(1);
});
