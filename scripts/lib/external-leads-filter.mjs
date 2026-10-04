/**
 * external-leads-filter.mjs — the pure filter behind `scripts/external-leads.mjs` (B3.2-G6).
 *
 * The "trending" source (findarepo.com, a static JSON directory of Claude skills and MCP
 * servers ranked by measured GitHub star velocity) is read ONLY by this store, once a week,
 * and every row is filtered HERE, BEFORE anything is written. The output is a SEPARATE
 * document, `external-leads.json` on the `data` branch — never `discovery.json`, which
 * already-shipped app versions read without any filter.
 *
 * The rules (all pure functions, no I/O, no dependencies):
 *  (a) only `skills.json` and `mcp.json` are read; `categories.json` never is (it is the
 *      file most loaded with duplicates of what the app already does);
 *  (b) a repo already in `catalog.json` is not news; subscription relays, prompt leaks,
 *      ToS / anti-bot / unofficial WhatsApp bypasses and offensive or reverse-engineering
 *      tooling are dropped ({@link DENY_REPOS} by name, {@link DENY_TERM_GROUPS} by words,
 *      one `reason` per group);
 *  (c) the "already integrated" gate ({@link INTEGRATED_NAMES}, {@link INTEGRATED_WORDS},
 *      {@link INTEGRATED_TERMS}) — see the HAND COPY note below;
 *  (d) findarepo's `summary` is never part of the output: description and licence come
 *      from GitHub;
 *  (e) ordered by `starsGained`, at most {@link MAX_LEADS_PER_KIND} skills and as many MCP
 *      servers per week.
 *
 * HAND COPY (owner decision D3, still to be ratified). The app's own "already integrated"
 * gate lives in the product repo (`packages/skills/src/curated-integrated-as.ts`, the
 * native-capability gate of `setup-recommender.ts`) and this repo cannot import it. The
 * lists below are a copy made by hand on 2026-10-04 from those two places and from the
 * app's native capabilities (GET /api/capabilities: brain, schedules). It can go stale; the
 * app re-applies its real gate when it consumes these leads (G7), as a second belt. This
 * is the one declared exception to the "no domain keyword lists" rule, on the basis of the
 * owner's answer rm-140 ("do not propose skills that do what the app already does").
 */

/** The only two findarepo files this store reads, by lead kind. */
export const ALLOWED_SOURCE_FILES = Object.freeze({ skill: 'skills.json', mcp: 'mcp.json' });

/** Files of the same directory that are never read (condition f). */
export const FORBIDDEN_SOURCE_FILES = Object.freeze(['categories.json', 'trending.json', 'active.json', 'vscode.json']);

/** Weekly ceiling per kind (owner decision D4): 30 skills + 30 MCP servers. */
export const MAX_LEADS_PER_KIND = 30;

/** Longest GitHub description kept in a lead. */
export const MAX_DESCRIPTION_CHARS = 300;

/** The exact attribution the source's licence asks for (owner decision D9). */
export const ATTRIBUTION = 'findarepo (findarepo.com) · CC BY 4.0';

/** `owner/name` as GitHub allows it; anything else is not a repo and is skipped. */
export const REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;

/** Rows dropped by subject matter, one `reason` per group (rule of 14/08, owner answers 9 and 18). */
export const DENY_TERM_GROUPS = Object.freeze([
  {
    reason: 'subscription-relay',
    patterns: [
      /\brelay\b/,
      /proxy[\s_-]*api|api[\s_-]*proxy/,
      /provider[\s_-]*proxy/,
      /[a-z0-9]2api\b/,
      /\bsubscriptions?\b.{0,60}\bapi\b/,
      /unlimited[\s_-]*free/,
      /\bfree\b.{0,40}\b(?:claude|gpt|gemini|codex|tokens?)\b/,
      /\b(?:claude|gpt|gemini|codex)\b.{0,40}\bfor[\s_-]*free\b/,
      /\b(?:ai|llm)[\s_-]*gateway/,
      /auto[\s_-]*fallback/,
      /telemetry[\s_-]*removed/,
      /guardrails?[\s_-]*stripped/,
    ],
  },
  {
    reason: 'prompt-leak',
    patterns: [
      /prompts?[\s_-]*leaks?/,
      /system[\s_-]*prompts?/,
      /\bleak(?:ed|s)?\b.{0,40}\b(?:prompts?|instructions?)\b/,
      /\b(?:prompts?|instructions?)\b.{0,40}\bleak(?:ed|s)?\b/,
    ],
  },
  {
    reason: 'tos-bypass',
    patterns: [
      /anti[\s_-]*bots?\b/,
      /captchas?\b/,
      /undetect/,
      /\bstealth\b/,
      /cloudflare[\s_-]*bypass/,
      /whatsapp(?![\s_-]*(?:cloud|business)[\s_-]*api)/,
      /\blinkedin\b/,
      /xiaohongshu/,
      /douyin/,
      /tiktok.{0,40}download/,
      /logged[\s_-]*in[\s_-]*browser[\s_-]*session/,
    ],
  },
  {
    reason: 'offensive-or-reverse-engineering',
    patterns: [
      /reverse[\s_-]*engineer/,
      /reverse[\s_-]*(?:skill|lab)/,
      /js[\s_-]*reverse/,
      /\bghidra\b/,
      /\bida[\s_-]*pro\b/,
      /cheat[\s_-]*engine/,
      /\bfrida\b/,
      /\bx64dbg\b/,
      /decompil/,
      /deobfusc/,
      /malware/,
      /\bexploit/,
      /\boffensive\b/,
      /penetration[\s_-]*test/,
      /pentest/,
      /red[\s_-]*team/,
      /\bclaude[\s_-]*red\b/,
      /cybersecurity/,
      /\bosint\b/,
      /\bjadx\b/,
    ],
  },
]);

/**
 * Repos dropped by name, whatever their words say (rule of 14/08, owner answers 9 and 18).
 * The source dossier names these one by one: 12 subscription relays, "free Claude" forks or
 * prompt leaks, 7 platform-ToS / anti-bot / unofficial WhatsApp tools, 15 offensive or
 * reverse-engineering tools, plus OmniRoute (an AI gateway with account auto-fallback).
 * Matched lower-cased on findarepo's name AND on the identity GitHub resolves (second pass).
 * Owner decision D3 ratifies the list; keeping any of them is the owner's call, not ours.
 */
export const DENY_REPOS = Object.freeze([
  { repo: 'wei-shaw/sub2api', reason: 'subscription-relay' },
  { repo: 'wei-shaw/claude-relay-service', reason: 'subscription-relay' },
  { repo: 'router-for-me/cliproxyapi', reason: 'subscription-relay' },
  { repo: 'alishahryar1/free-claude-code', reason: 'subscription-relay' },
  { repo: 'decolua/9router', reason: 'subscription-relay' },
  { repo: 'justlovemaki/aiclient2api', reason: 'subscription-relay' },
  { repo: 'freecodexyz/free-code', reason: 'subscription-relay' },
  { repo: 'claude-code-best/claude-code', reason: 'subscription-relay' },
  { repo: 'noemica-io/open-claude-in-chrome', reason: 'subscription-relay' },
  { repo: 'diegosouzapw/omniroute', reason: 'subscription-relay' },
  { repo: 'asgeirtj/system_prompts_leaks', reason: 'prompt-leak' },
  { repo: 'x1xhlol/system-prompts-and-models-of-ai-tools', reason: 'prompt-leak' },
  { repo: 'piebald-ai/claude-code-system-prompts', reason: 'prompt-leak' },
  { repo: 'stickerdaniel/linkedin-mcp-server', reason: 'tos-bypass' },
  { repo: 'korotovsky/slack-mcp-server', reason: 'tos-bypass' },
  { repo: 'verygoodplugins/whatsapp-mcp', reason: 'tos-bypass' },
  { repo: 'xpzouying/xiaohongshu-mcp', reason: 'tos-bypass' },
  { repo: 'feder-cr/invisible_playwright_mcp', reason: 'tos-bypass' },
  { repo: 'vibheksoni/stealth-browser-mcp', reason: 'tos-bypass' },
  { repo: 'evil0ctal/douyin_tiktok_download_api', reason: 'tos-bypass' },
  { repo: 'zhaoxuya520/reverse-skill', reason: 'offensive-or-reverse-engineering' },
  { repo: 'mukul975/anthropic-cybersecurity-skills', reason: 'offensive-or-reverse-engineering' },
  { repo: 'simoneavogadro/android-reverse-engineering-skill', reason: 'offensive-or-reverse-engineering' },
  { repo: '0x4m4/hexstrike-ai', reason: 'offensive-or-reverse-engineering' },
  { repo: 'mrexodia/ida-pro-mcp', reason: 'offensive-or-reverse-engineering' },
  { repo: 'blacktop/ida-mcp-rs', reason: 'offensive-or-reverse-engineering' },
  { repo: 'bethington/ghidra-mcp', reason: 'offensive-or-reverse-engineering' },
  { repo: 'symgraph/ghidrassistmcp', reason: 'offensive-or-reverse-engineering' },
  { repo: 'duty1g/x64dbg-mcp-server', reason: 'offensive-or-reverse-engineering' },
  { repo: 'miscusi-peek/cheatengine-mcp-bridge', reason: 'offensive-or-reverse-engineering' },
  { repo: 'zhizhuodemao/js-reverse-mcp', reason: 'offensive-or-reverse-engineering' },
  { repo: 'ling71671/open-reverselab', reason: 'offensive-or-reverse-engineering' },
  { repo: 'zinja-coder/jadx-ai-mcp', reason: 'offensive-or-reverse-engineering' },
  { repo: '1-3-7/disrobe', reason: 'offensive-or-reverse-engineering' },
  { repo: 'openosint/openosint', reason: 'offensive-or-reverse-engineering' },
]);

/** Repo names the owner contested as already integrated (dossier 3.2, row 29). */
export const INTEGRATED_NAMES = Object.freeze([
  { name: 'ponytail', reason: 'ships with the app (essential first-install set)' },
  { name: 'caveman', reason: 'replaced by ponytail, which ships with the app' },
  { name: 'claude-obsidian', reason: 'the Brain is the app\'s own knowledge base' },
  { name: 'graphify', reason: 'graphify is native in the app' },
  { name: 'obsidian-second-brain', reason: 'the Brain is the app\'s own knowledge base' },
]);

/** Words that mark a "second brain" anywhere in a row (owner: every brain / second brain / obsidian). */
export const INTEGRATED_WORDS = Object.freeze([/\bbrain\b/, /second[\s_-]*brain/, /\bobsidian\b/]);

/**
 * Native-capability vocabularies, same semantics as the app's native gate: a row is
 * withheld when it shares at least two terms with one feature AND at least one of them is
 * in its own name.
 */
export const INTEGRATED_TERMS = Object.freeze([
  {
    feature: 'brain',
    reason: 'the Brain already keeps memory, notes and a knowledge graph',
    terms: ['memory', 'memories', 'knowledge', 'graph', 'wiki', 'notes', 'vault', 'persistent', 'recall', 'remember'],
  },
  {
    feature: 'schedules',
    reason: 'the app already runs schedules and routines',
    terms: ['schedule', 'scheduler', 'scheduled', 'cron', 'recurring', 'routine', 'routines', 'reminder', 'reminders'],
  },
]);

/** Minimum shared terms for the vocabulary leg of the integrated gate. */
const INTEGRATED_MIN_TERMS = 2;

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const repoName = (repo) => repo.slice(repo.indexOf('/') + 1);
const terms = (text) =>
  new Set(
    String(text ?? '')
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean),
  );
/** Everything a row says about itself, for matching only (never written out). */
const haystack = (i) => [i.repo, i.summary ?? '', i.description ?? ''].join(' ').toLowerCase();

/**
 * Normalise one findarepo envelope into rows of `kind`. Returns `null` when the envelope
 * has no `items[]` (the caller then writes nothing); skips rows whose `repo` is not a
 * plain `owner/name`. Throws on a kind other than `skill` / `mcp`.
 */
export function parseFindarepoItems(doc, kind) {
  if (!Object.hasOwn(ALLOWED_SOURCE_FILES, kind)) throw new Error(`external-leads: unknown kind ${kind}`);
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.items)) return null;
  const out = [];
  for (const raw of doc.items) {
    if (!raw || typeof raw !== 'object' || typeof raw.repo !== 'string' || !REPO_RE.test(raw.repo)) continue;
    out.push({
      repo: raw.repo,
      kind,
      summary: typeof raw.summary === 'string' ? raw.summary : '',
      stars: num(raw.stars),
      starsGained: num(raw.starsGained) ?? 0,
      measuredWindowDays: num(raw.measuredWindowDays),
    });
  }
  return out;
}

/** Drop every row whose `owner/repo` is already in the catalogue (case-insensitive). */
export function dropKnown(items, catalogRepos) {
  const known = new Set([...catalogRepos].map((r) => String(r).toLowerCase()));
  return items.filter((i) => !known.has(i.repo.toLowerCase()));
}

/** The deny group a row falls in, or `undefined`. */
export function denyReason(i) {
  const repo = i.repo.toLowerCase();
  const byName = DENY_REPOS.find((r) => r.repo === repo);
  if (byName) return byName.reason;
  const text = haystack(i);
  return DENY_TERM_GROUPS.find((g) => g.patterns.some((p) => p.test(text)))?.reason;
}

/** Drop relays, prompt leaks, ToS bypasses and offensive / reverse-engineering tooling. */
export function dropByDenyTerms(items) {
  return items.filter((i) => denyReason(i) === undefined);
}

/** Why a row counts as already integrated in the app, or `undefined`. */
export function integratedReason(i) {
  const name = repoName(i.repo).toLowerCase();
  const byName = INTEGRATED_NAMES.find((r) => r.name === name);
  if (byName) return byName.reason;
  const text = haystack(i);
  if (INTEGRATED_WORDS.some((w) => w.test(text))) return 'a second brain: the Brain is the app\'s own';
  const all = terms([i.repo, i.summary ?? '', i.description ?? ''].join(' '));
  const own = terms(repoName(i.repo));
  for (const g of INTEGRATED_TERMS) {
    const matched = g.terms.filter((t) => all.has(t));
    if (matched.length >= INTEGRATED_MIN_TERMS && matched.some((t) => own.has(t))) return g.reason;
  }
  return undefined;
}

/** Drop every row that duplicates something the app already does. */
export function dropIntegrated(items) {
  return items.filter((i) => integratedReason(i) === undefined);
}

/** The whole chain, in order. Run once on findarepo's names and again on GitHub's resolved ones. */
export function filterChain(items, catalogRepos) {
  return dropIntegrated(dropByDenyTerms(dropKnown(items, catalogRepos)));
}

/** At most `n` rows per kind, by `starsGained` descending (ties by repo, for a stable file). */
export function capByMomentum(items, n) {
  const out = [];
  for (const kind of Object.keys(ALLOWED_SOURCE_FILES)) {
    const rows = items
      .filter((i) => i.kind === kind)
      .sort((a, b) => b.starsGained - a.starsGained || a.repo.localeCompare(b.repo));
    out.push(...rows.slice(0, n));
  }
  return out;
}

/**
 * The document written to `external-leads.json`. Every field is picked by name: nothing
 * else of a row (above all findarepo's `summary`) can reach the file.
 */
export function toLeads(items, { dataDate, generatedAt }) {
  return {
    generatedAt,
    source: 'findarepo',
    attribution: ATTRIBUTION,
    dataDate: typeof dataDate === 'string' ? dataDate : null,
    license: 'CC-BY-4.0',
    candidates: items
      .filter((i) => REPO_RE.test(i.repo))
      .map((i) => ({
        repo: i.repo,
        kind: i.kind,
        stars: num(i.stars),
        starsGained: num(i.starsGained),
        measuredWindowDays: num(i.measuredWindowDays),
        description: typeof i.description === 'string' ? i.description.slice(0, MAX_DESCRIPTION_CHARS) : null,
        licenseSpdx: typeof i.licenseSpdx === 'string' ? i.licenseSpdx : null,
        createdAt: typeof i.createdAt === 'string' ? i.createdAt : null,
        url: `https://github.com/${i.repo}`,
        installable: i.kind !== 'mcp',
      })),
  };
}
