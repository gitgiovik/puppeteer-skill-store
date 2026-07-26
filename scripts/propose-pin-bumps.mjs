#!/usr/bin/env node
/**
 * propose-pin-bumps.mjs — weekly pin-bump bot (A2.0, puppeteer-skill-store).
 * Run by `.github/workflows/weekly-pin-bump.yml`. Same shape as a
 * winget/Scoop version-bump bot: find stale pins, verify there is actually
 * something new to pin, prepare the diff, open ONE cumulative PR. It NEVER
 * merges — `validate-entry.yml`'s existing PR gate re-verifies every bumped
 * entry (tarball fetch, contentHash, LICENSE) exactly like a human-authored
 * PR would be checked, so this bot gets no special trust.
 *
 * ALGORITHM, per DISTINCT repo in catalog.json (grouping `sourceUrl`s that
 * share an `owner/repo`, since several slugs often pin the same upstream —
 * see the multi-path entries and aggregator repos):
 *
 *   1. Resolve the repo's CURRENT default-branch HEAD sha (one API call
 *      pair per repo, cached — never re-resolved per slug).
 *   2. For every entry in that repo whose `upstreamCommit` != that HEAD:
 *      a. Diff `base(entry.upstreamCommit)...head(HEAD)` via the compare
 *         API and check whether ANY changed file falls under the entry's
 *         own resolved subtree (`curatedUpstreamMappings` — a whole-repo
 *         mapping ('.' or '') always counts; anything else must literally
 *         match the mapped path or a path underneath it). A repo whose HEAD
 *         moved for reasons entirely outside a curated skill's own directory
 *         (a README typo two levels away, an unrelated skill in the same
 *         collection) is NOT a candidate — this is the "diff on the subtree,
 *         not the commit" requirement: bumping on every unrelated upstream
 *         commit would make PRs pure noise and defeat the human-review point
 *         of `main`.
 *      b. GitHub's compare API returns at most ~300 changed files per call
 *         (undocumented but observed cap) with no explicit "truncated" flag.
 *         When a compare response has exactly that many files we CANNOT
 *         prove the subtree is unaffected, so we fail OPEN (treat as
 *         changed) rather than silently drop a real bump — same fail-closed-
 *         toward-safety posture as `validate-entry.mjs`'s hash/license
 *         checks, just inverted (here "closed" means "propose it, let a
 *         human's PR review and CI decide", not "silently skip it").
 *   3. Every real candidate is logged (repo, slug, old sha, new sha, which
 *      compare status decided it). Only the first `--max` (default 20,
 *      sorted by slug for determinism — this is a bound on ONE PR's size,
 *      not a priority queue) are actually fetched, re-hashed, and written;
 *      the remainder is logged as DEFERRED and picked up next week's run
 *      (never partially processed, never silently dropped).
 *   4. For each entry that makes the cut: fetch the pinned tarball at the
 *      NEW sha (same codeload URL shape + tar parsing `validate-entry.mjs`
 *      uses), re-resolve `curatedUpstreamMappings`, and re-hash with the
 *      SAME canonical `hashSkillFileBytes` scheme — this is the exact byte
 *      hash a human-authored bump PR would have to get right by hand.
 *      `catalog.json` is updated in place: `upstreamCommit`, `contentHash`,
 *      `catalogRevision += 1`, and — the point below — `byteAudit` DEMOTED to
 *      'upstream-differs'. `reviewed` is deliberately left pointing at the OLD
 *      sha (that review really did happen, at that sha; rewriting it would
 *      destroy the only record of it), as are author/license/description.
 *
 *      WHY THE DEMOTION IS NOT OPTIONAL (T3 closer, 2026-07-26). In the app,
 *      `byteAudit === 'vendored-match'` is the SOLE thing that earns install
 *      tier 'auto' — "the wizard may install this unattended", no owner
 *      confirmation (`packages/skills/src/skill-tier.ts`). The audit summary
 *      shown to the owner for such a row says literally "byte-identical to the
 *      payload reviewed at curation time" (`first-party-source.ts`). A bump
 *      moves the pin to a HEAD nobody has read AND recomputes `contentHash`
 *      from exactly those unread bytes — so leaving `byteAudit` alone would
 *      carry a byte-review verdict onto bytes that were never reviewed, and
 *      keep unattended installs flowing on them. That is a FABRICATED VERDICT,
 *      the exact class `skill-tier.ts` documents having shipped once already.
 *      CI cannot catch it either: `validate-entry.mjs` checks
 *      `contentHash == hash(bytes at pin)`, which this bot makes true by
 *      construction. So the bot demotes: the bump still lands, the skill still
 *      installs, it just costs ONE owner confirmation until a human re-reviews
 *      the bytes and restores 'vendored-match' by hand (updating `reviewed`
 *      in the same edit). `validate-entry.mjs` enforces the resulting
 *      invariant — `reviewed.sha === upstreamCommit || byteAudit ===
 *      'upstream-differs'` — so the hole cannot be reopened by hand either.
 *   5. A branch + single commit + `gh pr create` (one PR, title carries the
 *      count) — never a merge, never `--auto-merge`.
 *
 * `--dry-run` runs the FULL discovery (steps 1-3, real network calls) and
 * prints the would-be bump/deferred report, but writes nothing to disk,
 * creates no branch, and never calls `gh pr create`.
 *
 * Auth: `GITHUB_TOKEN` (Actions default token is fine for compare/commits on
 * public repos; unauthenticated works too, just against the 60 req/h anon
 * ceiling — fine for a manual local `--dry-run`, not for the real job).
 */
import { readFileSync, writeFileSync, existsSync, mkdtempSync, writeFileSync as writeFile } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseTar } from './lib/tar.mjs';
import {
  parseGithubOwnerRepo,
  codeloadTarballUrl,
  curatedUpstreamMappings,
  mapUpstreamTarEntries,
  hashSkillFileBytes,
} from './lib/upstream.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..');
const DEFAULT_CATALOG = join(REPO_ROOT, 'catalog.json');

const DEFAULT_MAX_PER_PR = 20; // bound on ONE PR's size — see header. Deliberately small: each bumped entry costs a tarball fetch + full re-hash.
const COMPARE_TRUNCATION_SUSPECT_COUNT = 300; // GitHub's observed per-call compare-files cap — see header's fail-open note.
const TAR_CAPS = { maxEntries: 20000, maxTotalBytes: 384 * 1024 * 1024 };

function parseArgs(argv) {
  const out = { dryRun: false, catalogPath: DEFAULT_CATALOG, max: DEFAULT_MAX_PER_PR, baseBranch: 'main' };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--catalog') out.catalogPath = argv[++i];
    else if (a === '--max') out.max = Number.parseInt(argv[++i], 10);
    else if (a === '--base-branch') out.baseBranch = argv[++i];
  }
  if (!Number.isFinite(out.max) || out.max <= 0) throw new Error(`propose-pin-bumps: --max must be a positive integer, got '${out.max}'`);
  return out;
}

function loadCatalog(path) {
  if (!existsSync(path)) throw new Error(`propose-pin-bumps: catalog not found at ${path}`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

async function githubFetch(url, token) {
  const res = await fetch(url, {
    headers: {
      accept: 'application/vnd.github+json',
      'user-agent': 'puppeteer-skill-store-weekly-pin-bump',
      ...(token ? { authorization: `bearer ${token}` } : {}),
    },
  });
  if (!res.ok) throw new Error(`GitHub API ${url}: HTTP ${res.status}`);
  return res.json();
}

/** owner/repo -> { owner, repo, entries: [catalog entry, ...] }, in first-seen order. */
export function groupEntriesByRepo(catalog) {
  const byRepo = new Map();
  for (const entry of catalog.skills ?? []) {
    if (entry.unavailable) continue; // nothing verifiable to bump — same exclusion validate-entry.mjs applies.
    const parsed = parseGithubOwnerRepo(entry.sourceUrl ?? '');
    if (!parsed) continue;
    const key = `${parsed.owner}/${parsed.repo}`;
    if (!byRepo.has(key)) byRepo.set(key, { owner: parsed.owner, repo: parsed.repo, entries: [] });
    byRepo.get(key).entries.push(entry);
  }
  return byRepo;
}

/** Current default-branch HEAD sha for owner/repo. */
async function resolveDefaultBranchHead(owner, repo, token) {
  const meta = await githubFetch(`https://api.github.com/repos/${owner}/${repo}`, token);
  const branch = meta.default_branch;
  if (!branch) throw new Error(`${owner}/${repo}: no default_branch reported`);
  const commit = await githubFetch(`https://api.github.com/repos/${owner}/${repo}/commits/${encodeURIComponent(branch)}`, token);
  if (!commit.sha) throw new Error(`${owner}/${repo}@${branch}: HEAD commit has no sha`);
  return { branch, sha: commit.sha };
}

/**
 * Does ANY file changed between base and head fall under one of `mappings`'
 * (curatedUpstreamMappings output) `from` paths? A whole-repo mapping
 * ('.' or '') always counts — see header for the truncation fail-open rule.
 */
export function mappingsTouchedByFiles(mappings, filenames) {
  for (const m of mappings) {
    if (m.from === '.' || m.from === '') return true;
    for (const f of filenames) {
      if (f === m.from || f.startsWith(`${m.from}/`)) return true;
    }
  }
  return false;
}

/** Compare base...head for owner/repo; returns { changed, filenames, suspectTruncated, status }. */
async function subtreeChanged(owner, repo, base, head, mappings, token) {
  const cmp = await githubFetch(`https://api.github.com/repos/${owner}/${repo}/compare/${base}...${head}`, token);
  const files = cmp.files ?? [];
  const filenames = files.map((f) => f.filename);
  const suspectTruncated = filenames.length >= COMPARE_TRUNCATION_SUSPECT_COUNT;
  const changed = suspectTruncated ? true : mappingsTouchedByFiles(mappings, filenames);
  return { changed, filenames, suspectTruncated, status: cmp.status };
}

async function fetchArchiveEntries(owner, repo, sha) {
  const url = codeloadTarballUrl(owner, repo, sha);
  const res = await fetch(url, { headers: { accept: 'application/gzip,application/octet-stream,*/*' }, redirect: 'follow' });
  if (!res.ok) throw new Error(`codeload ${owner}/${repo}@${sha}: HTTP ${res.status}`);
  const gz = Buffer.from(await res.arrayBuffer());
  if (gz.byteLength === 0) throw new Error(`codeload ${owner}/${repo}@${sha}: empty body`);
  const { entries, truncated } = parseTar(gunzipSync(gz), TAR_CAPS);
  if (truncated) throw new Error(`codeload ${owner}/${repo}@${sha}: archive exceeds caps`);
  return entries;
}

/**
 * Discover every real bump candidate (steps 1-2 of the header algorithm).
 * Pure network-in, data-out — no catalog.json mutation, no bound applied
 * here (the bound is a PR-size decision made by the caller after seeing the
 * full list, so the "deferred" log is honest about what a bigger --max
 * would have covered this run).
 */
export async function discoverCandidates(catalog, token, log = () => {}) {
  const byRepo = groupEntriesByRepo(catalog);
  const candidates = [];
  const errors = [];
  const compareCache = new Map(); // `${repoKey}@${base}->${head}` -> subtreeChanged() result, reused across slugs sharing a pin.

  for (const [repoKey, { owner, repo, entries }] of byRepo) {
    let head;
    try {
      head = await resolveDefaultBranchHead(owner, repo, token);
    } catch (err) {
      errors.push(`${repoKey}: could not resolve default-branch HEAD: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    log(`  ${repoKey}: HEAD=${head.sha.slice(0, 12)} (${head.branch})`);

    for (const entry of entries) {
      const base = (entry.upstreamCommit ?? '').trim();
      if (base.length === 0 || base === head.sha) continue; // already at HEAD, or nothing pinned to compare from.

      const mappings = curatedUpstreamMappings(entry);
      if (mappings.length === 0) {
        errors.push(`${entry.slug}: no resolvable upstreamPath/upstreamPaths — cannot scope a subtree diff, skipped`);
        continue;
      }

      const cacheKey = `${repoKey}@${base}->${head.sha}`;
      let cmp = compareCache.get(cacheKey);
      if (!cmp) {
        try {
          cmp = await subtreeChanged(owner, repo, base, head.sha, mappings, token);
          compareCache.set(cacheKey, cmp);
        } catch (err) {
          errors.push(`${entry.slug} (${repoKey}@${base}...${head.sha}): compare failed: ${err instanceof Error ? err.message : String(err)}`);
          continue;
        }
      }
      // The compare's file list is repo-wide and shared across entries at the same
      // base/head pin; re-scope it to THIS entry's own mappings before deciding.
      const changed = cmp.suspectTruncated ? true : mappingsTouchedByFiles(mappings, cmp.filenames);
      if (!changed) continue;

      candidates.push({
        slug: entry.slug,
        owner,
        repo,
        repoKey,
        oldSha: base,
        newSha: head.sha,
        mappings,
        suspectTruncated: cmp.suspectTruncated,
      });
    }
  }

  candidates.sort((a, b) => a.slug.localeCompare(b.slug));
  return { candidates, errors };
}

function printReport(candidates, deferred, errors, max) {
  console.log(`\npropose-pin-bumps: ${candidates.length + deferred.length} candidate(s) found, --max ${max}.`);
  if (candidates.length === 0 && deferred.length === 0) {
    console.log('  nothing to bump — every entry is already at (or ahead of) its repo default-branch HEAD, or no subtree changed.');
  }
  for (const c of candidates) {
    console.log(`  BUMP     ${c.slug.padEnd(32)} ${c.repoKey.padEnd(32)} ${c.oldSha.slice(0, 12)} -> ${c.newSha.slice(0, 12)}${c.suspectTruncated ? '  (compare truncated — failed open)' : ''}`);
  }
  for (const c of deferred) {
    console.log(`  DEFERRED ${c.slug.padEnd(32)} ${c.repoKey.padEnd(32)} ${c.oldSha.slice(0, 12)} -> ${c.newSha.slice(0, 12)}  (over --max ${max}, next run)`);
  }
  if (errors.length > 0) {
    console.log(`\n  ${errors.length} error(s) during discovery (not fatal — affected repos/entries are simply not candidates this run):`);
    for (const e of errors) console.log(`    - ${e}`);
  }
}

/**
 * Write ONE bump into the in-memory catalog. Returns `{ demoted }` so the
 * caller can report (and the PR body can list) which rows lost tier 'auto'.
 *
 * The `byteAudit` demotion is load-bearing, not cosmetic — see the module
 * header's "WHY THE DEMOTION IS NOT OPTIONAL". `reviewed` is untouched on
 * purpose: it still names the sha a human actually read, which is what makes
 * the demoted row self-explanatory to the next reviewer.
 */
export function applyBump(catalog, candidate, newContentHash) {
  const entry = (catalog.skills ?? []).find((s) => s.slug === candidate.slug);
  if (!entry) throw new Error(`propose-pin-bumps: slug '${candidate.slug}' vanished from catalog between discovery and apply`);
  const demoted = entry.byteAudit === 'vendored-match';
  entry.upstreamCommit = candidate.newSha;
  entry.contentHash = newContentHash;
  entry.byteAudit = 'upstream-differs';
  entry.catalogRevision = (typeof entry.catalogRevision === 'number' ? entry.catalogRevision : 1) + 1;
  return { demoted };
}

function prBody(applied, deferred, errors) {
  const lines = [
    `Automated weekly pin bump — ${applied.length} entr${applied.length === 1 ? 'y' : 'ies'} moved to their repo's current default-branch HEAD.`,
    '',
    'Each row was bumped only because the entry\'s OWN upstream subtree (not just the repo) changed between the old pin and the new HEAD — see `scripts/propose-pin-bumps.mjs` header for the exact diff-scoping rule.',
    '',
    '| slug | repo | old pin | new pin | byteAudit |',
    '|---|---|---|---|---|',
    ...applied.map(
      (c) =>
        `| \`${c.slug}\` | ${c.repoKey} | \`${c.oldSha.slice(0, 12)}\` | \`${c.newSha.slice(0, 12)}\` | ` +
        `${c.demoted ? '⚠️ `vendored-match` → `upstream-differs`' : '`upstream-differs` (unchanged)'} |`,
    ),
    '',
    '`contentHash` was recomputed from the bytes fetched at the new pin with the same canonical scheme `validate-entry.mjs` re-checks in CI — this PR carries no more trust than a hand-authored one.',
    '',
    "**`byteAudit` is DEMOTED to `upstream-differs` on every bumped row.** A bot cannot re-review bytes, and `vendored-match` is what grants unattended (`auto`) installs in the app while the audit summary tells the owner the bytes are \"byte-identical to the payload reviewed at curation time\". Carrying that verdict onto an unreviewed HEAD would be a fabricated one, so each bumped skill drops to a single owner confirmation until a human re-reads the bytes and restores `vendored-match` together with `reviewed`.",
    '',
    "**Not touched**: `reviewed`, `author`, `license`, `description`. `reviewed.sha` on each bumped row still names the OLD pin on purpose — that review really happened at that sha, and keeping it is what makes the demoted row legible to the next reviewer.",
    '',
    'This PR is never auto-merged.',
  ];
  const demotedRows = applied.filter((c) => c.demoted);
  if (demotedRows.length > 0) {
    lines.push(
      '',
      `⚠️ **${demotedRows.length} row(s) lost install tier \`auto\`** (unattended install → one owner confirmation): ${demotedRows.map((c) => `\`${c.slug}\``).join(', ')}. Restoring \`auto\` requires a human byte review, not a merge.`,
    );
  }
  const truncated = applied.filter((c) => c.suspectTruncated);
  if (truncated.length > 0) {
    // The fail-open is cached per `repo@base->head`, so it is a PER-REPO verdict that
    // every sibling entry sharing that pin inherits — naming the rows (grouped by repo)
    // is what makes the blast radius reviewable instead of "at least one row somewhere".
    const byRepo = new Map();
    for (const c of truncated) {
      if (!byRepo.has(c.repoKey)) byRepo.set(c.repoKey, []);
      byRepo.get(c.repoKey).push(c.slug);
    }
    lines.push(
      '',
      `⚠️ **${truncated.length} row(s) could not be scoped narrowly**: the base…head compare hit the ~300-file cap, so we cannot prove the entry's own subtree was untouched. Bumped anyway (fail-open — a human's review decides, rather than a real bump being silently dropped). NOTE the radius: the compare result is cached per repo+pin, so EVERY entry sharing that pin inherits the same fail-open:`,
      ...[...byRepo].map(([repoKey, slugs]) => `- ${repoKey}: ${slugs.map((s) => `\`${s}\``).join(', ')}`),
    );
  }
  if (deferred.length > 0) {
    lines.push('', `**Deferred to next week's run** (over this run's \`--max\`): ${deferred.map((c) => `\`${c.slug}\``).join(', ')}.`);
  }
  if (errors.length > 0) {
    lines.push('', `**Discovery errors** (not fatal, logged for visibility): ${errors.length} — see the workflow run log.`);
  }
  return lines.join('\n') + '\n';
}

function git(args, opts = {}) {
  return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', ...opts });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const catalog = loadCatalog(args.catalogPath);
  const token = process.env.GITHUB_TOKEN;

  console.log(`propose-pin-bumps: resolving HEAD for every distinct repo in ${args.catalogPath.replace(REPO_ROOT + '/', '')}...`);
  const { candidates, errors } = await discoverCandidates(catalog, token, (line) => console.log(line));

  const applied = candidates.slice(0, args.max);
  const deferred = candidates.slice(args.max);
  printReport(applied, deferred, errors, args.max);

  if (args.dryRun) {
    console.log('\npropose-pin-bumps: --dry-run — no catalog.json write, no branch, no PR.');
    return;
  }

  if (applied.length === 0) {
    console.log('\npropose-pin-bumps: no bumps to apply this run — nothing further to do.');
    return;
  }

  console.log(`\npropose-pin-bumps: fetching + re-hashing ${applied.length} entrie(s) at their new pin...`);
  const archiveCache = new Map(); // `${repoKey}@${sha}` -> tar entries, reused across slugs sharing a new HEAD.
  const failed = [];
  for (const c of applied) {
    const archiveKey = `${c.repoKey}@${c.newSha}`;
    try {
      let entries = archiveCache.get(archiveKey);
      if (!entries) {
        entries = await fetchArchiveEntries(c.owner, c.repo, c.newSha);
        archiveCache.set(archiveKey, entries);
      }
      const files = mapUpstreamTarEntries(entries, c.mappings, `${c.slug}@${c.newSha}`);
      const newContentHash = hashSkillFileBytes(files);
      const { demoted } = applyBump(catalog, c, newContentHash);
      c.demoted = demoted;
      console.log(
        `  ${c.slug.padEnd(32)} contentHash -> ${newContentHash.slice(0, 16)}...` +
          (demoted ? '  byteAudit vendored-match -> upstream-differs (install drops to one-click)' : ''),
      );
    } catch (err) {
      failed.push({ slug: c.slug, error: err instanceof Error ? err.message : String(err) });
      console.log(`  ${c.slug.padEnd(32)} FAILED: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const succeeded = applied.filter((c) => !failed.some((f) => f.slug === c.slug));
  if (succeeded.length === 0) {
    console.error(`\npropose-pin-bumps: all ${applied.length} attempted bump(s) failed to fetch/hash — nothing to commit. See failures above.`);
    process.exit(1);
  }

  writeFileSync(args.catalogPath, JSON.stringify(catalog, null, 2) + '\n', 'utf8');
  console.log(`\npropose-pin-bumps: wrote ${succeeded.length} bump(s) to catalog.json.`);

  // A bumped upstreamCommit changes the `sha` embedded in every affected
  // plugin's marketplace.json row too — regenerate it in the SAME commit or
  // validate-entry.yml's `--check` gate fails this PR outright (marketplace.json
  // must never drift from catalog.json, bot-authored or not).
  execFileSync('node', [join(HERE, 'generate-marketplace.mjs')], { cwd: REPO_ROOT, stdio: 'inherit' });
  console.log('propose-pin-bumps: regenerated .claude-plugin/marketplace.json.');

  const dateTag = new Date().toISOString().slice(0, 10);
  const branch = `bot/pin-bump-${dateTag}`;
  git(['config', '--global', 'user.name', 'puppeteer-skill-store-bot']);
  git(['config', '--global', 'user.email', 'actions@users.noreply.github.com']);
  git(['checkout', '-b', branch]);
  git(['add', 'catalog.json', '.claude-plugin/marketplace.json']);
  git(['commit', '-m', `chore(pins): weekly pin bump (${succeeded.length} entr${succeeded.length === 1 ? 'y' : 'ies'})`]);
  git(['push', 'origin', branch]);

  const bodyPath = join(mkdtempSync(join(tmpdir(), 'pin-bump-')), 'body.md');
  writeFile(bodyPath, prBody(succeeded, deferred, [...errors, ...failed.map((f) => `${f.slug}: ${f.error}`)]), 'utf8');

  execFileSync(
    'gh',
    [
      'pr',
      'create',
      '--title',
      `chore(pins): weekly pin bump (${succeeded.length} entr${succeeded.length === 1 ? 'y' : 'ies'})`,
      '--body-file',
      bodyPath,
      '--base',
      args.baseBranch,
      '--head',
      branch,
    ],
    { cwd: REPO_ROOT, stdio: 'inherit' },
  );

  if (failed.length > 0) {
    console.log(`\npropose-pin-bumps: PR opened, but ${failed.length} candidate(s) failed to bump and were left at their old pin (see log above) — will be retried next run.`);
  }
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((err) => {
    console.error(`propose-pin-bumps: ${err instanceof Error ? err.stack : String(err)}`);
    process.exit(1);
  });
}
