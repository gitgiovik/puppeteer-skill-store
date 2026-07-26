#!/usr/bin/env node
/**
 * collect-snapshot.mjs — daily popularity + reachability + MCP-registry sync
 * (A2.0, puppeteer-skill-store). Run by `.github/workflows/daily-snapshot.yml`
 * against a checkout of the orphan `data` branch (see that workflow for the
 * branch-management half — this script only reads/writes files under
 * `--out-dir` and never touches git itself). `--out-dir` IS the data-branch
 * root, so the files this script writes are `popularity.json`,
 * `snapshots/YYYY-MM-DD.json`, `mcp-registry.json` AT THAT ROOT — served as
 * `raw.githubusercontent.com/<owner>/puppeteer-skill-store/data/<file>`, where
 * the `data` segment is the BRANCH, not a directory. (W2 review finding #2:
 * the consumer's default URL, this script's `--out-dir`, and README.md's table
 * had drifted into three different URLs; the data-branch root is the one.)
 *
 * THREE THINGS IT MEASURES, ONE NETWORK CALL EACH:
 *
 * 1. GITHUB GRAPHQL, ONE ALIASED QUERY for the ~42 distinct upstream repos
 *    catalog.json's 108 entries resolve to (`stargazerCount`, `forkCount`,
 *    `pushedAt`). ~42 aliased `repository()` lookups cost ~2 GraphQL points
 *    of the 5000/h budget (per-node cost, not per-request) — nowhere near
 *    weekly-discovery's separate 30-req/min Search budget, which is why this
 *    stays in its own daily workflow. Auth: `GITHUB_TOKEN` only (Actions
 *    default token), never a PAT.
 *
 *    Trending is NOT read from a `stargazers` timestamp endpoint — that
 *    endpoint 404s for repos we don't own as of 2026-06-30. Instead this
 *    script's OWN prior `snapshots/YYYY-MM-DD.json` files are the trend
 *    source: today's `stargazerCount` minus the nearest available snapshot
 *    ~1d/7d/30d back. A window with no snapshot far enough back is OMITTED
 *    from the output, never backfilled with a 0 — a missing history point is
 *    not a measured "no change". That "far enough back" search is BOUNDED ON
 *    BOTH SIDES (W2 review finding #7): the candidate must sit at or before
 *    the window edge AND no earlier than `daysAgo*2+1` days back, so a gap in
 *    the history (workflow disabled, repo quiet) can never publish a 90-day
 *    diff under a field named `starsDelta1d`. Past the floor the window is
 *    simply absent — the same honest-absence rule, applied to staleness.
 *
 *    THE OUTPUT IS KEYED BY CATALOGUE SLUG, NOT BY REPO (W2 review finding
 *    #1). GitHub measures REPOS (42 of them); the app asks about catalogue
 *    SLUGS (108 of them), and N slugs routinely share one upstream repo. The
 *    `entries` map in `popularity.json` is that fan-out, and its per-slug
 *    shape is THE consumer contract: it mirrors `SkillPopularity`
 *    (@puppeteer/shared) field-for-field — `stars`, `starsDelta1d/7d/30d`,
 *    `pushedAt`, `snapshotAt` — so `store-index-client.ts` parses it and
 *    `stampPopularity` (catalog-routes.ts) copies it across with no
 *    translation layer to drift. `repos` is still emitted alongside it as the
 *    raw per-repo measurement (and it is what `snapshots/*.json` stores, since
 *    the trend history must survive a catalogue re-slug).
 *
 * 2. CODELOAD REACHABILITY: a sequential, POLITE (small delay between calls)
 *    HEAD request against every entry's pinned tarball URL
 *    (`codeloadTarballUrl`, same port as validate-entry.mjs's `lib/upstream.mjs`).
 *    This is NOT a content check (validate-entry.mjs's job on every PR) — it
 *    only asks "does this pin still 200", which is enough to flag a pin that
 *    started 404ing between PRs (force-pushed history, deleted fork, repo
 *    made private) well before the next PR touches that row.
 *
 * 3. MCP REGISTRY DELTA SYNC against registry.modelcontextprotocol.io:
 *    unauthenticated, cursor-paginated, `updated_since` from the LAST sync
 *    (persisted in the output file itself, so a re-run without `--out-dir`
 *    pointed at yesterday's data falls back to a full sync — never silently
 *    resets to "we know nothing"). A record with `status:'deleted'` is
 *    PRUNED from the persisted map, not just skipped. Every upstream field is
 *    stored verbatim under `raw`; anything we compute about a record lives in
 *    a separate namespaced `puppeteerMeta` key so the upstream record itself
 *    stays byte-comparable to the registry.
 *
 * `--dry-run`: skips EVERY network call and prints the plan (which repos,
 * which tarball URLs, whether an MCP delta or full sync would run) instead —
 * it never writes a snapshot, because a snapshot with no real numbers would
 * be indistinguishable from a real one but wrong (the house honesty rule:
 * absent data renders as absent, never a fabricated placeholder).
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { codeloadTarballUrl, parseGithubOwnerRepo } from './lib/upstream.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..');
const DEFAULT_CATALOG = join(REPO_ROOT, 'catalog.json');

const MCP_REGISTRY_BASE = 'https://registry.modelcontextprotocol.io/v0.1/servers';
const GRAPHQL_URL = 'https://api.github.com/graphql';
const HEAD_CHECK_DELAY_MS = 400; // polite spacing between sequential codeload HEAD requests.
const MCP_PAGE_LIMIT = 100;
/** Bumped only on a BREAKING change to `popularity.json`'s `entries` shape — the
 *  consumer (`StorePopularitySnapshot`, packages/skills/src/store-index-client.ts)
 *  reads it and is `.passthrough()`, so additive fields never need a bump. */
const POPULARITY_SCHEMA_VERSION = 1;

function parseArgs(argv) {
  const out = { dryRun: false, outDir: join(REPO_ROOT, 'data'), catalogPath: DEFAULT_CATALOG };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--out-dir') out.outDir = argv[++i];
    else if (a === '--catalog') out.catalogPath = argv[++i];
  }
  return out;
}

function todayUtc() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function loadCatalog(path) {
  if (!existsSync(path)) throw new Error(`collect-snapshot: catalog not found at ${path}`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** Distinct {owner, repo} pairs across every catalog entry, plus per-entry archive coordinates. */
export function distinctRepos(catalog) {
  const repos = new Map(); // "owner/repo" -> {owner, repo}
  const archives = []; // {slug, owner, repo, sha}
  for (const entry of catalog.skills ?? []) {
    const parsed = parseGithubOwnerRepo(entry.sourceUrl ?? '');
    const sha = (entry.upstreamCommit ?? '').trim();
    if (!parsed || sha.length === 0) continue;
    const key = `${parsed.owner}/${parsed.repo}`;
    if (!repos.has(key)) repos.set(key, parsed);
    archives.push({ slug: entry.slug, owner: parsed.owner, repo: parsed.repo, sha });
  }
  return { repos: [...repos.values()], archives };
}

/** Build ONE aliased GraphQL query body for all distinct repos (aliases must be valid GraphQL names). */
export function buildGraphqlQuery(repos) {
  const fields = repos
    .map(
      (r, i) =>
        `r${i}: repository(owner: ${JSON.stringify(r.owner)}, name: ${JSON.stringify(r.repo)}) { ` +
        `nameWithOwner stargazerCount forkCount pushedAt isArchived }`,
    )
    .join('\n  ');
  return `query {\n  ${fields}\n}`;
}

export async function fetchRepoStats(repos, token) {
  if (repos.length === 0) return { byKey: new Map(), errors: [] };
  const query = buildGraphqlQuery(repos);
  const res = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: {
      authorization: `bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/vnd.github+json',
      'user-agent': 'puppeteer-skill-store-daily-snapshot',
    },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) {
    throw new Error(`GitHub GraphQL: HTTP ${res.status} — ${await res.text().catch(() => '')}`);
  }
  const json = await res.json();
  const byKey = new Map();
  repos.forEach((r, i) => {
    const node = json.data?.[`r${i}`];
    if (node) {
      byKey.set(`${r.owner}/${r.repo}`, {
        stargazerCount: node.stargazerCount,
        forkCount: node.forkCount,
        pushedAt: node.pushedAt,
        isArchived: node.isArchived,
      });
    }
  });
  const errors = (json.errors ?? []).map((e) => e.message ?? String(e));
  return { byKey, errors };
}

/** Sequential, spaced HEAD requests — deliberately not Promise.all (politeness, not perf). */
export async function checkTarballsReachable(archives) {
  const out = new Map(); // slug -> {reachable, status, checkedAt}
  for (const a of archives) {
    const url = codeloadTarballUrl(a.owner, a.repo, a.sha);
    const checkedAt = new Date().toISOString();
    try {
      const res = await fetch(url, { method: 'HEAD', redirect: 'follow' });
      out.set(a.slug, { reachable: res.ok, status: res.status, checkedAt });
    } catch (err) {
      out.set(a.slug, { reachable: false, status: 0, error: err instanceof Error ? err.message : String(err), checkedAt });
    }
    if (HEAD_CHECK_DELAY_MS > 0) await new Promise((r) => setTimeout(r, HEAD_CHECK_DELAY_MS));
  }
  return out;
}

/** Load the persisted MCP registry mirror ({lastSync, servers}), or a fresh empty one. */
export function loadMcpRegistryState(outDir) {
  const p = join(outDir, 'mcp-registry.json');
  if (!existsSync(p)) return { lastSync: undefined, servers: {} };
  return JSON.parse(readFileSync(p, 'utf8'));
}

/**
 * Delta-sync the MCP registry: `updated_since` from the last sync (full sync
 * when absent), cursor-paginated, pruning `status:'deleted'` records. Every
 * upstream field is kept verbatim under `raw`; `puppeteerMeta` is OUR
 * namespaced bookkeeping (first/last seen by this mirror) — never merged into
 * the upstream shape, so a consumer diffing against the live registry can
 * still do it field-for-field.
 */
export async function syncMcpRegistry(state) {
  const servers = { ...state.servers };
  let cursor;
  let seenThisSync = 0;
  const syncStartedAt = new Date().toISOString();
  do {
    const url = new URL(MCP_REGISTRY_BASE);
    url.searchParams.set('limit', String(MCP_PAGE_LIMIT));
    if (state.lastSync) url.searchParams.set('updated_since', state.lastSync);
    if (cursor) url.searchParams.set('cursor', cursor);
    const res = await fetch(url, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`MCP registry: HTTP ${res.status} at ${url}`);
    const json = await res.json();
    const rows = json.servers ?? json.data ?? [];
    for (const row of rows) {
      const id = row.id ?? row.name;
      if (!id) continue;
      seenThisSync += 1;
      if (row.status === 'deleted') {
        delete servers[id];
        continue;
      }
      const prior = servers[id];
      servers[id] = {
        raw: row,
        puppeteerMeta: {
          firstSeen: prior?.puppeteerMeta?.firstSeen ?? syncStartedAt,
          lastSeen: syncStartedAt,
        },
      };
    }
    cursor = json.metadata?.nextCursor ?? json.nextCursor;
  } while (cursor);
  return { lastSync: syncStartedAt, servers, seenThisSync };
}

/** Shift a YYYY-MM-DD string by `-days` and return it as YYYY-MM-DD (UTC). */
function shiftDate(date, days) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/** The trend windows this script publishes: output field ⇒ nominal age in days. */
export const TREND_WINDOWS = [
  ['starsDelta1d', 1],
  ['starsDelta7d', 7],
  ['starsDelta30d', 30],
];

/**
 * The most recent snapshot inside the window `[date-(daysAgo*2+1), date-daysAgo]`
 * (YYYY-MM-DD strings sort lexicographically = chronologically).
 *
 * BOUNDED ON BOTH SIDES ON PURPOSE (W2 review finding #7). The upper bound is the
 * window edge — a snapshot must be at least `daysAgo` old to answer "how many stars
 * in the last `daysAgo` days". The LOWER bound is the honesty half: without it, the
 * first run after any gap in the history (workflow disabled for a month, a repo
 * added late) would happily diff against a 90-day-old file and publish the result
 * as `starsDelta1d`. A candidate older than the floor is DISCARDED and the window
 * is simply absent from the output — the same rule the file header states for a
 * missing history point, applied to a too-old one. The floor is generous
 * (`daysAgo*2+1`: 3d for the 1d window, 15d for 7d, 61d for 30d) so an ordinary
 * missed run or two still yields a usable — and still honestly dated, see
 * `deltaSince` — number rather than a hole.
 */
export function findSnapshotNear(snapshotDir, date, daysAgo) {
  if (!existsSync(snapshotDir)) return undefined;
  const newestStr = shiftDate(date, daysAgo);
  const oldestStr = shiftDate(date, daysAgo * 2 + 1);
  const files = readdirSync(snapshotDir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .map((f) => f.slice(0, 10))
    .sort();
  // The most recent snapshot at or before the window edge, but not past the floor.
  let best;
  for (const d of files) {
    if (d <= newestStr && d >= oldestStr) best = d;
  }
  if (!best) return undefined;
  return { date: best, data: JSON.parse(readFileSync(join(snapshotDir, `${best}.json`), 'utf8')) };
}

/**
 * Load each trend window's baseline snapshot ONCE for the whole run. Previously
 * every repo re-read and re-parsed the same three files (42 repos × 3 windows =
 * 126 parses of the full snapshot document); the baselines do not depend on the
 * repo, so they are hoisted out of the loop.
 */
export function loadTrendWindows(snapshotDir, date) {
  const windows = {};
  for (const [field, days] of TREND_WINDOWS) {
    const found = findSnapshotNear(snapshotDir, date, days);
    if (found) windows[field] = found;
  }
  return windows;
}

/**
 * Star-delta trend windows for one repo, present ONLY when a baseline snapshot
 * exists inside that window's bounds AND that baseline actually recorded this
 * repo (a repo GraphQL failed to resolve back then is absent, not 0). Returns
 * `{ <field>: {stars, sinceSnapshot} }` — the caller flattens it per slug.
 */
export function computeTrending(repoKey, currentStars, windows) {
  const trending = {};
  for (const [field] of TREND_WINDOWS) {
    const past = windows[field];
    const pastStars = past?.data?.repos?.[repoKey]?.stargazerCount;
    if (typeof pastStars === 'number' && typeof currentStars === 'number') {
      trending[field] = { stars: currentStars - pastStars, sinceSnapshot: past.date };
    }
    // No usable historical point ⇒ omit the field entirely (honest absence).
  }
  return trending;
}

/**
 * THE REPO→SLUG FAN-OUT (W2 review finding #1): turn the per-repo measurement into
 * the per-SLUG `entries` map `store-index-client.ts` actually reads. Each row
 * mirrors `SkillPopularity` (@puppeteer/shared) field-for-field so the consumer
 * copies it straight through; every field is OMITTED when unmeasured (a repo the
 * GraphQL query could not resolve contributes NO row at all, never `stars: 0`), and
 * `deltaSince` records which snapshot date each delta was actually diffed against
 * so a consumer — or a human reading the file — can see the real age behind a
 * field named "1d".
 */
export function buildPopularityEntries(archives, snapshotRepos, windows) {
  const entries = {};
  const trendingByRepo = new Map();
  for (const a of archives) {
    const key = `${a.owner}/${a.repo}`;
    const stats = snapshotRepos[key];
    if (!stats) continue; // repo unresolved this run ⇒ this slug has NO signal today.
    if (!trendingByRepo.has(key)) {
      trendingByRepo.set(key, computeTrending(key, stats.stargazerCount, windows));
    }
    const trending = trendingByRepo.get(key);
    const row = {};
    if (typeof stats.stargazerCount === 'number') row.stars = stats.stargazerCount;
    if (typeof stats.pushedAt === 'string') row.pushedAt = stats.pushedAt;
    const deltaSince = {};
    for (const [field] of TREND_WINDOWS) {
      const t = trending[field];
      if (!t) continue;
      row[field] = t.stars;
      deltaSince[field] = t.sinceSnapshot;
    }
    if (Object.keys(deltaSince).length > 0) row.deltaSince = deltaSince;
    if (typeof stats.fetchedAt === 'string') row.snapshotAt = stats.fetchedAt;
    // A row with nothing but a timestamp is not a measurement — drop it.
    if (row.stars === undefined && row.pushedAt === undefined) continue;
    entries[a.slug] = row;
  }
  return entries;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const catalog = loadCatalog(args.catalogPath);
  const { repos, archives } = distinctRepos(catalog);

  if (args.dryRun) {
    console.log(`collect-snapshot --dry-run: ${repos.length} distinct repos, ${archives.length} pinned archives.`);
    console.log('Would run:');
    console.log(`  1. ONE aliased GraphQL query for ${repos.length} repos (stargazerCount/forkCount/pushedAt).`);
    console.log(`  2. ${archives.length} sequential codeload HEAD checks, ${HEAD_CHECK_DELAY_MS}ms apart.`);
    console.log(`  3. MCP registry delta sync against ${MCP_REGISTRY_BASE}.`);
    console.log(
      `  4. Fan ${repos.length} repo measurements out to up to ${archives.length} per-slug ` +
        `'entries' rows (the consumer contract) + keep the raw per-repo view.`,
    );
    console.log(`  5. Write ${join(args.outDir, 'popularity.json')} and ${join(args.outDir, 'snapshots', `${todayUtc()}.json`)}.`);
    console.log('No network calls made, no files written (dry run).');
    return;
  }

  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error('collect-snapshot: GITHUB_TOKEN is required (GraphQL needs auth; Actions default token is fine).');
  }

  mkdirSync(join(args.outDir, 'snapshots'), { recursive: true });
  const date = todayUtc();

  console.log(`collect-snapshot: fetching stats for ${repos.length} repos...`);
  const { byKey: repoStats, errors: repoErrors } = await fetchRepoStats(repos, token);
  if (repoErrors.length > 0) {
    console.warn(`collect-snapshot: ${repoErrors.length} GraphQL error(s) (partial data still used):`);
    for (const e of repoErrors) console.warn(`  - ${e}`);
  }

  console.log(`collect-snapshot: HEAD-checking ${archives.length} pinned tarballs...`);
  const reachability = await checkTarballsReachable(archives);

  console.log('collect-snapshot: syncing MCP registry...');
  const priorMcp = loadMcpRegistryState(args.outDir);
  const mcpResult = await syncMcpRegistry(priorMcp);
  writeFileSync(
    join(args.outDir, 'mcp-registry.json'),
    JSON.stringify({ lastSync: mcpResult.lastSync, servers: mcpResult.servers }, null, 2) + '\n',
    'utf8',
  );
  console.log(`collect-snapshot: MCP registry now tracks ${Object.keys(mcpResult.servers).length} servers (${mcpResult.seenThisSync} touched this sync).`);

  // Snapshot: raw measurement for this date, kept forever as trending history.
  const snapshotRepos = {};
  for (const r of repos) {
    const key = `${r.owner}/${r.repo}`;
    const stats = repoStats.get(key);
    if (stats) snapshotRepos[key] = { ...stats, fetchedAt: new Date().toISOString() };
    // A repo GraphQL couldn't resolve (renamed/deleted/rate-limited) is simply
    // ABSENT from this snapshot — never recorded as 0 stars.
  }
  const snapshotTarballs = Object.fromEntries(reachability);
  const snapshotDoc = { date, repos: snapshotRepos, tarballReachability: snapshotTarballs };
  const snapshotDir = join(args.outDir, 'snapshots');
  writeFileSync(join(snapshotDir, `${date}.json`), JSON.stringify(snapshotDoc, null, 2) + '\n', 'utf8');

  // Popularity: the per-SLUG consumer contract FIRST (that is what the app reads),
  // plus the raw per-repo view alongside it for humans/debugging. Both are derived
  // from the SAME snapshotRepos measurement, so they can never disagree.
  const windows = loadTrendWindows(snapshotDir, date);
  const popularityEntries = buildPopularityEntries(archives, snapshotRepos, windows);
  const popularityRepos = {};
  for (const [key, stats] of Object.entries(snapshotRepos)) {
    popularityRepos[key] = { ...stats, trending: computeTrending(key, stats.stargazerCount, windows) };
  }
  const popularityDoc = {
    schemaVersion: POPULARITY_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    date,
    entries: popularityEntries,
    repos: popularityRepos,
    tarballReachability: snapshotTarballs,
    ...(repoErrors.length > 0 ? { graphqlErrors: repoErrors } : {}),
  };
  writeFileSync(join(args.outDir, 'popularity.json'), JSON.stringify(popularityDoc, null, 2) + '\n', 'utf8');

  const unreachable = [...reachability.values()].filter((v) => !v.reachable).length;
  console.log(
    `collect-snapshot: wrote popularity.json + snapshots/${date}.json at the data-branch root ` +
      `(${Object.keys(snapshotRepos).length}/${repos.length} repos resolved → ` +
      `${Object.keys(popularityEntries).length}/${archives.length} slug entries, ` +
      `${unreachable} unreachable tarball(s)).`,
  );
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((err) => {
    console.error(`collect-snapshot: ${err instanceof Error ? err.stack : String(err)}`);
    process.exit(1);
  });
}
