#!/usr/bin/env node
/**
 * external-leads.mjs — weekly "trending" leads from findarepo.com, filtered BEFORE they are
 * written (B3.2-G6, puppeteer-skill-store). Run by `.github/workflows/weekly-discovery.yml`
 * as one extra step of the existing weekly job (same cron, same permissions, same
 * GITHUB_TOKEN, `continue-on-error: true` so a findarepo outage never stops discovery).
 *
 * WHY A SEPARATE DOCUMENT. The app has read `discovery.json` from every install since
 * v0.0.1, with no switch and no filter. Leads from an outside source therefore go to their
 * OWN file, `external-leads.json` at the root of the `data` branch, which only a version of
 * the app with an explicit, off-by-default switch reads. This script refuses an `--out`
 * named `discovery.json`.
 *
 * WHAT IT DOES
 *  1. GET `<source-base>/skills.json` and `<source-base>/mcp.json` — nothing else (never
 *     `categories.json`): one request per file, a 20 s timeout, a User-Agent, no retry, no
 *     credentials. If either file fails or has no `items[]`, it writes NOTHING and exits 0:
 *     last week's file stays on the `data` branch instead of an empty one replacing it.
 *  2. Filters with `lib/external-leads-filter.mjs` (catalogue repos, deny groups, the
 *     "already integrated" gate) and keeps at most 30 skills + 30 MCP servers by momentum.
 *  3. For each survivor, ONE `GET /repos/{owner}/{repo}` on the GitHub REST API (never
 *     Search), at most {@link MAX_GITHUB_CALLS} in all. BUDGET: the workflow's
 *     GITHUB_TOKEN allows 1 000 requests/h per repository, shared with `discover.mjs` in
 *     the same job, so 60 is the ceiling. GitHub's `full_name` resolves renames, and the
 *     WHOLE filter chain runs again on the resolved identity (a rename towards an excluded
 *     or catalogued name must not pass). Archived, private or unreachable repos are dropped.
 *  4. Writes `{generatedAt, source, attribution, dataDate, license, candidates[]}`; a
 *     candidate carries GitHub's description and licence, never findarepo's summary, and
 *     an MCP lead is `installable: false` (a link, never a direct install).
 *
 * The token is only ever sent to api.github.com and never printed, not even inside an
 * error (errors are reported by HTTP status only).
 *
 * Usage:
 *   node scripts/external-leads.mjs --out ../data-branch/external-leads.json
 *   node scripts/external-leads.mjs --dry-run --out /tmp/x.json      # no network, prints the plan
 *   node scripts/external-leads.mjs --out x.json --source-base http://127.0.0.1:8000/data
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseGithubOwnerRepo } from './lib/upstream.mjs';
import {
  ALLOWED_SOURCE_FILES,
  MAX_LEADS_PER_KIND,
  REPO_RE,
  capByMomentum,
  filterChain,
  parseFindarepoItems,
  toLeads,
} from './lib/external-leads-filter.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Where findarepo publishes its static JSON (override with --source-base for local tests). */
export const DEFAULT_SOURCE_BASE = 'https://findarepo.com/data';
/** Timeout of every outgoing request. */
export const SOURCE_TIMEOUT_MS = 20_000;
/** Sent on every request, so the source can see who reads it and from where. */
export const USER_AGENT = 'puppeteer-skill-store (+https://github.com/gitgiovik/puppeteer-skill-store)';
/** Hard ceiling of GitHub REST calls per run (1 000/h per repository, shared with discover.mjs). */
export const MAX_GITHUB_CALLS = 60;
const GITHUB_API = 'https://api.github.com';

class UsageError extends Error {}

function parseArgs(argv) {
  const args = { outPath: null, catalogPath: join(REPO_ROOT, 'catalog.json'), dryRun: false, sourceBase: DEFAULT_SOURCE_BASE };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--out' || a === '--catalog' || a === '--source-base') {
      const v = argv[++i];
      if (!v) throw new UsageError(`${a} needs a value`);
      if (a === '--out') args.outPath = v;
      else if (a === '--catalog') args.catalogPath = v;
      else args.sourceBase = v.replace(/\/+$/, '');
    } else throw new UsageError(`unknown argument ${a}`);
  }
  if (!args.outPath) throw new UsageError('--out <path> is required');
  if (basename(args.outPath).toLowerCase() === 'discovery.json') {
    throw new UsageError('refusing to write discovery.json: external leads go to their own document');
  }
  return args;
}

function defaultReadCatalog(path) {
  if (!existsSync(path)) throw new Error(`catalog not found at ${path}`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

function defaultWriteFile(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, 'utf8');
}

/** `owner/repo` of every catalogue entry. */
function catalogRepos(catalog) {
  const set = new Set();
  for (const entry of catalog?.skills ?? []) {
    const parsed = parseGithubOwnerRepo(entry.sourceUrl ?? '');
    if (parsed) set.add(`${parsed.owner}/${parsed.repo}`);
  }
  return set;
}

/**
 * The whole run, with every side effect injected (the CLI passes the real ones). Returns
 * the exit code: 0 on success AND on a source outage (nothing written), 2 on bad usage.
 */
export async function run(argv, deps = {}) {
  const {
    env = process.env,
    fetchImpl = globalThis.fetch,
    timeoutSignal = (ms) => AbortSignal.timeout(ms),
    readCatalog = defaultReadCatalog,
    writeFileImpl = defaultWriteFile,
    log = (s) => console.log(s),
    warn = (s) => console.error(s),
    now = () => new Date(),
  } = deps;

  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    warn(`external-leads: ${err.message}`);
    return 2;
  }

  const files = Object.entries(ALLOWED_SOURCE_FILES);
  if (args.dryRun) {
    log(`external-leads --dry-run: would GET ${files.map(([, f]) => `${args.sourceBase}/${f}`).join(' and ')}`);
    log(`  filter, keep at most ${MAX_LEADS_PER_KIND} skills + ${MAX_LEADS_PER_KIND} MCP servers by momentum,`);
    log(`  then at most ${MAX_GITHUB_CALLS} GET ${GITHUB_API}/repos/{owner}/{repo} calls, and write ${args.outPath}.`);
    log('No network calls made, no files written (dry run).');
    return 0;
  }

  const known = catalogRepos(readCatalog(args.catalogPath));

  // 1. The two source files: one GET each, no retry, no credentials.
  let items = [];
  let dataDate = null;
  for (const [kind, file] of files) {
    const url = `${args.sourceBase}/${file}`;
    let doc;
    try {
      const res = await fetchImpl(url, {
        headers: { accept: 'application/json', 'user-agent': USER_AGENT },
        signal: timeoutSignal(SOURCE_TIMEOUT_MS),
      });
      if (!res.ok) {
        warn(`external-leads: ${file} answered HTTP ${res.status}; nothing written this week.`);
        return 0;
      }
      doc = await res.json();
    } catch (err) {
      warn(`external-leads: ${file} unreachable (${err?.name ?? 'Error'}); nothing written this week.`);
      return 0;
    }
    const parsed = parseFindarepoItems(doc, kind);
    if (parsed === null) {
      warn(`external-leads: ${file} has no items[]; nothing written this week.`);
      return 0;
    }
    dataDate ??= typeof doc.dataDate === 'string' ? doc.dataDate : null;
    items.push(...parsed);
  }

  // 2. Filter on findarepo's names, then cap.
  const shortlist = capByMomentum(filterChain(items, known), MAX_LEADS_PER_KIND);

  // 3. One GitHub call per survivor, within the budget; then the whole chain again.
  const token = env.GITHUB_TOKEN;
  const enriched = [];
  let calls = 0;
  let failed = 0;
  for (const item of shortlist) {
    if (calls >= MAX_GITHUB_CALLS) break;
    calls++;
    try {
      const res = await fetchImpl(`${GITHUB_API}/repos/${item.repo}`, {
        headers: {
          accept: 'application/vnd.github+json',
          'user-agent': USER_AGENT,
          'x-github-api-version': '2022-11-28',
          ...(token ? { authorization: `bearer ${token}` } : {}),
        },
        signal: timeoutSignal(SOURCE_TIMEOUT_MS),
      });
      if (!res.ok) {
        failed++;
        warn(`external-leads: GitHub answered HTTP ${res.status} for ${item.repo}; dropped.`);
        continue;
      }
      const gh = await res.json();
      if (typeof gh?.full_name !== 'string' || !REPO_RE.test(gh.full_name) || gh.archived || gh.private) continue;
      enriched.push({
        ...item,
        repo: gh.full_name,
        description: typeof gh.description === 'string' ? gh.description : null,
        licenseSpdx: typeof gh.license?.spdx_id === 'string' ? gh.license.spdx_id : null,
        createdAt: typeof gh.created_at === 'string' ? gh.created_at : null,
      });
    } catch (err) {
      failed++;
      warn(`external-leads: GitHub unreachable for ${item.repo} (${err?.name ?? 'Error'}); dropped.`);
    }
  }
  const seen = new Set();
  const finalItems = filterChain(enriched, known).filter((i) => {
    const key = i.repo.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // 4. Write the separate document.
  const doc = toLeads(finalItems, { dataDate, generatedAt: now().toISOString() });
  writeFileImpl(args.outPath, `${JSON.stringify(doc, null, 2)}\n`);
  log(
    `external-leads: wrote ${doc.candidates.length} lead(s) to ${basename(args.outPath)} ` +
      `(${items.length} read, ${shortlist.length} shortlisted, ${calls} GitHub call(s), ${failed} failed).`,
  );
  return 0;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  run(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      console.error(`external-leads: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    },
  );
}
