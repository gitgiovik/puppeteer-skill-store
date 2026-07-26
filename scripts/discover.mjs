#!/usr/bin/env node
/**
 * discover.mjs — weekly candidate-finding, NO AUTO-ADDS (A2.0, puppeteer-skill-store).
 * Run by `.github/workflows/weekly-discovery.yml`, entirely separate from the
 * daily snapshot workflow because it spends a DIFFERENT, much tighter budget:
 * the GitHub Search API's 30 requests/minute (its own ceiling, independent of
 * the 5000/h core REST budget the daily job's GraphQL calls use).
 *
 * TWO DISCOVERY PASSES, written to `discovery.json` at the data-branch root as CANDIDATES only —
 * nothing here ever touches `catalog.json`. A human still reviews, pins a
 * commit, and byte-audits before anything becomes a real entry (the whole
 * point of `validate-entry.yml` existing as a PR gate).
 *
 * 1. GITHUB SEARCH: a short, fixed list of repo-search queries
 *    (`topic:claude-skill`, `topic:claude-skills`, `topic:agent-skills`, plus
 *    a `SKILL.md`-in-path code search) — each query paced at least 2.1s apart
 *    (60s / 30req = 2s floor; the extra 100ms is slack, not a promise) so a
 *    handful of queries never gets close to the 30/min ceiling even before
 *    accounting for GitHub's own burst smoothing. Every repo already present
 *    in `catalog.json` (by `owner/repo`) is filtered out — a "candidate" that
 *    is already curated is not news.
 *
 * 2. KNOWN-COLLECTION ENUMERATION: for the ~42 repos catalog.json already
 *    pins, fetch the CURRENT default-branch tree (core REST API — a
 *    completely separate budget from Search, 5000/h) and look for
 *    `.../SKILL.md` paths not already covered by any curated entry's
 *    `upstreamPath`/`upstreamPaths` for that repo. This is how a repo like
 *    `anthropics/skills` growing a 10th skill directory gets surfaced without
 *    re-running the expensive Search queries against it.
 *
 * `--dry-run` skips every network call and prints the query/repo plan.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseGithubOwnerRepo, curatedUpstreamMappings } from './lib/upstream.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..');
const DEFAULT_CATALOG = join(REPO_ROOT, 'catalog.json');
const DEFAULT_OUT = join(REPO_ROOT, 'data', 'discovery.json');

const SEARCH_PACE_MS = 2100; // > 60_000 / 30 req-per-min.
const SEARCH_PAGE_SIZE = 30;
const SEARCH_MAX_PAGES_PER_QUERY = 2; // bounded — this is discovery, not a crawl.

/** Fixed, small query list — grow deliberately, each addition costs real budget every week. */
export const SEARCH_QUERIES = [
  { kind: 'repos', q: 'topic:claude-skill' },
  { kind: 'repos', q: 'topic:claude-skills' },
  { kind: 'repos', q: 'topic:claude-code-skill' },
  { kind: 'repos', q: 'topic:agent-skills' },
  { kind: 'code', q: 'filename:SKILL.md' },
];

function parseArgs(argv) {
  const out = { dryRun: false, catalogPath: DEFAULT_CATALOG, outPath: DEFAULT_OUT };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--catalog') out.catalogPath = argv[++i];
    else if (a === '--out') out.outPath = argv[++i];
  }
  return out;
}

function loadCatalog(path) {
  if (!existsSync(path)) throw new Error(`discover: catalog not found at ${path}`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** `owner/repo` → the set of already-curated directory prefixes (from every entry's mappings). */
export function curatedPathsByRepo(catalog) {
  const byRepo = new Map();
  for (const entry of catalog.skills ?? []) {
    const parsed = parseGithubOwnerRepo(entry.sourceUrl ?? '');
    if (!parsed) continue;
    const key = `${parsed.owner}/${parsed.repo}`;
    if (!byRepo.has(key)) byRepo.set(key, new Set());
    const set = byRepo.get(key);
    for (const m of curatedUpstreamMappings(entry)) {
      if (m.from === '.' || m.from === '') {
        set.add(''); // whole-repo rows cover everything.
        continue;
      }
      // A mapping's `from` is EITHER a directory (the common case — the whole
      // subtree is curated, so the directory ITSELF is what's covered) OR a
      // single SKILL.md FILE path (the 3 multi-path rows' primary mapping —
      // only that file is fetched, so what's "covered" is the file's own
      // containing directory, not some deeper subtree under it).
      const isSkillMdFile = /(^|\/)SKILL\.md$/i.test(m.from);
      const covered = isSkillMdFile
        ? m.from.includes('/')
          ? m.from.slice(0, m.from.lastIndexOf('/'))
          : ''
        : m.from;
      set.add(covered);
    }
  }
  return byRepo;
}

/** `owner/repo` set already in the catalogue (Search-result dedup). */
function curatedRepoSet(catalog) {
  const set = new Set();
  for (const entry of catalog.skills ?? []) {
    const parsed = parseGithubOwnerRepo(entry.sourceUrl ?? '');
    if (parsed) set.add(`${parsed.owner}/${parsed.repo}`);
  }
  return set;
}

async function githubFetch(url, token) {
  const res = await fetch(url, {
    headers: {
      accept: 'application/vnd.github+json',
      'user-agent': 'puppeteer-skill-store-weekly-discovery',
      ...(token ? { authorization: `bearer ${token}` } : {}),
    },
  });
  if (!res.ok) throw new Error(`GitHub API ${url}: HTTP ${res.status}`);
  return res.json();
}

/** Run the fixed Search query list, paced, deduped against the known catalogue. */
export async function runSearchDiscovery(token, alreadyKnown) {
  const candidates = [];
  const errors = [];
  for (const { kind, q } of SEARCH_QUERIES) {
    for (let page = 1; page <= SEARCH_MAX_PAGES_PER_QUERY; page += 1) {
      const endpoint = kind === 'repos' ? 'search/repositories' : 'search/code';
      const url = `https://api.github.com/${endpoint}?q=${encodeURIComponent(q)}&per_page=${SEARCH_PAGE_SIZE}&page=${page}`;
      await new Promise((r) => setTimeout(r, SEARCH_PACE_MS));
      let json;
      try {
        json = await githubFetch(url, token);
      } catch (err) {
        errors.push(`${q} (page ${page}): ${err instanceof Error ? err.message : String(err)}`);
        break; // don't keep paging a query that's already failing.
      }
      const items = json.items ?? [];
      for (const item of items) {
        const repoFull = kind === 'repos' ? item.full_name : item.repository?.full_name;
        if (!repoFull || alreadyKnown.has(repoFull)) continue;
        candidates.push({
          repo: repoFull,
          htmlUrl: kind === 'repos' ? item.html_url : item.repository?.html_url,
          description: kind === 'repos' ? item.description ?? '' : undefined,
          stars: kind === 'repos' ? item.stargazers_count : item.repository?.stargazers_count,
          matchedQuery: q,
          matchedPath: kind === 'code' ? item.path : undefined,
        });
      }
      if (items.length < SEARCH_PAGE_SIZE) break; // no more pages for this query.
    }
  }
  // Dedup candidates across the multiple queries (same repo can match several).
  const byRepo = new Map();
  for (const c of candidates) {
    if (!byRepo.has(c.repo)) byRepo.set(c.repo, c);
  }
  return { candidates: [...byRepo.values()], errors };
}

/** For each known repo, list `SKILL.md` paths NOT already covered by a curated mapping. */
export async function runKnownRepoEnumeration(catalog, token) {
  const curatedPaths = curatedPathsByRepo(catalog);
  const results = [];
  const errors = [];
  for (const [repoKey, coveredDirs] of curatedPaths) {
    const [owner, repo] = repoKey.split('/');
    try {
      const meta = await githubFetch(`https://api.github.com/repos/${owner}/${repo}`, token);
      const branch = meta.default_branch;
      const tree = await githubFetch(
        `https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
        token,
      );
      if (tree.truncated) {
        errors.push(`${repoKey}: tree truncated by GitHub (repo too large for one recursive call) — skipped`);
        continue;
      }
      const skillMdPaths = (tree.tree ?? [])
        .filter((n) => n.type === 'blob' && /(^|\/)SKILL\.md$/i.test(n.path))
        .map((n) => n.path);
      for (const p of skillMdPaths) {
        const dir = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
        if (coveredDirs.has(dir) || coveredDirs.has('')) continue; // already curated (or whole-repo row).
        results.push({ repo: repoKey, path: p, branch });
      }
    } catch (err) {
      errors.push(`${repoKey}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { newSkillDirsInKnownRepos: results, errors };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const catalog = loadCatalog(args.catalogPath);
  const known = curatedRepoSet(catalog);

  if (args.dryRun) {
    console.log(`discover --dry-run: ${SEARCH_QUERIES.length} search queries, ${known.size} known repos to re-enumerate.`);
    for (const { kind, q } of SEARCH_QUERIES) console.log(`  search(${kind}): ${q}`);
    console.log(`  + recursive tree fetch for ${known.size} known repos, filtered against their curated paths.`);
    console.log('No network calls made, no files written (dry run).');
    return;
  }

  const token = process.env.GITHUB_TOKEN;
  console.log(`discover: running ${SEARCH_QUERIES.length} search queries (paced ${SEARCH_PACE_MS}ms apart)...`);
  const search = await runSearchDiscovery(token, known);
  console.log(`discover: enumerating ${known.size} known collection repos for new SKILL.md dirs...`);
  const enumeration = await runKnownRepoEnumeration(catalog, token);

  mkdirSync(dirname(args.outPath), { recursive: true });
  const doc = {
    generatedAt: new Date().toISOString(),
    searchCandidates: search.candidates,
    newSkillDirsInKnownRepos: enumeration.newSkillDirsInKnownRepos,
    errors: [...search.errors, ...enumeration.errors],
  };
  writeFileSync(args.outPath, JSON.stringify(doc, null, 2) + '\n', 'utf8');
  console.log(
    `discover: wrote ${args.outPath.replace(REPO_ROOT + '/', '')} — ` +
      `${doc.searchCandidates.length} new repo candidate(s), ${doc.newSkillDirsInKnownRepos.length} new dir(s) in known repos, ` +
      `${doc.errors.length} error(s).`,
  );
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((err) => {
    console.error(`discover: ${err instanceof Error ? err.stack : String(err)}`);
    process.exit(1);
  });
}
