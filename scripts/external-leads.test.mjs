// Run with: node --test scripts/external-leads.test.mjs (no dependencies, no network:
// every fetch is simulated, every write is captured).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, statSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  run,
  SOURCE_TIMEOUT_MS,
  USER_AGENT,
  MAX_GITHUB_CALLS,
  DEFAULT_SOURCE_BASE,
} from './external-leads.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const SCRIPT_URL = pathToFileURL(join(HERE, 'external-leads.mjs')).href;
const BASE = 'http://source.test/data';
const OUT = join('data-branch', 'external-leads.json');

const row = (repo, starsGained = 10, summary = 'A plain helper.') => ({
  repo,
  github: `https://github.com/${repo}`,
  findarepo: `https://findarepo.com/repo/${repo}/`,
  summary,
  stars: 1000,
  starsGained,
  measuredWindowDays: 7,
});
const envelope = (items) => ({
  source: 'findarepo.com',
  attribution: 'Cite as findarepo (findarepo.com).',
  generated: '2026-10-03T10:30:51.699Z',
  dataDate: '2026-10-03',
  count: items.length,
  items,
});
const ghRepo = (repo, extra = {}) => ({
  full_name: repo,
  description: `GitHub description of ${repo}`,
  license: { spdx_id: 'MIT' },
  archived: false,
  private: false,
  fork: false,
  created_at: '2025-01-01T00:00:00Z',
  html_url: `https://github.com/${repo}`,
  ...extra,
});

/** A simulated network: findarepo files by name, GitHub repos by `owner/repo`. */
function fakeNet({ skills = envelope([]), mcp = envelope([]), github = (r) => ghRepo(r) } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const u = String(url);
    const reply = (body) =>
      typeof body === 'number'
        ? new Response('nope', { status: body })
        : body instanceof Error
          ? Promise.reject(body)
          : new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    if (u === `${BASE}/skills.json`) return reply(skills);
    if (u === `${BASE}/mcp.json`) return reply(mcp);
    const m = u.match(/^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)$/);
    if (m) return reply(github(decodeURIComponent(m[1])));
    return new Response('unexpected', { status: 599 });
  };
  return { calls, fetchImpl };
}

async function go(net, argv = ['--out', OUT, '--source-base', BASE], extra = {}) {
  const writes = new Map();
  const timeouts = [];
  const lines = [];
  const code = await run(argv, {
    env: { GITHUB_TOKEN: 'ghs_FAKE_TOKEN_0123456789' },
    fetchImpl: net.fetchImpl,
    timeoutSignal: (ms) => {
      timeouts.push(ms);
      return AbortSignal.timeout(ms);
    },
    readCatalog: () => ({ skills: [{ sourceUrl: 'https://github.com/anthropics/skills' }] }),
    writeFileImpl: (p, text) => writes.set(p, text),
    log: (s) => lines.push(String(s)),
    warn: (s) => lines.push(String(s)),
    now: () => new Date('2026-10-05T05:00:00.000Z'),
    ...extra,
  });
  return { code, writes, timeouts, lines };
}

// ---- (1) the workflow, read as text --------------------------------------------------

test('weekly-discovery.yml: one cron, external-leads step isolated, no new secret, permissions unchanged', () => {
  const yml = readFileSync(join(ROOT, '.github/workflows/weekly-discovery.yml'), 'utf8');
  assert.equal((yml.match(/^\s*-?\s*cron:/gm) ?? []).length, 1, 'exactly one cron');
  assert.match(yml, /cron: '0 5 \* \* 1'/);
  const secrets = [...yml.matchAll(/secrets\.([A-Za-z0-9_]+)/g)].map((m) => m[1]);
  assert.ok(secrets.length >= 2 && secrets.every((s) => s === 'GITHUB_TOKEN'), `only GITHUB_TOKEN: ${secrets}`);
  assert.equal((yml.match(/^permissions:/gm) ?? []).length, 1);
  assert.match(yml, /^permissions:\n {2}contents: write\n\n/m);
  assert.equal((yml.match(/^\s+[a-z-]+: (?:write|read)$/gm) ?? []).length, 1, 'no extra permission');
  const steps = yml.split(/\n(?= {6}- )/);
  const idx = steps.findIndex((s) => s.includes('scripts/external-leads.mjs'));
  assert.ok(idx > 0, 'an external-leads step exists');
  const step = steps[idx];
  assert.match(step, /\n {8}continue-on-error: true\n/);
  assert.match(step, /\n {10}GITHUB_TOKEN: \$\{\{ secrets\.GITHUB_TOKEN \}\}\n/);
  assert.match(step, /node scripts\/external-leads\.mjs --out \.\.\/data-branch\/external-leads\.json/);
  assert.ok(steps[idx - 1].includes('scripts/discover.mjs'), 'right after Run discovery');
  assert.ok(steps[idx + 1].includes('git add -A'), 'right before the data-branch commit');
  assert.equal((yml.match(/^ {6}- name:/gm) ?? []).length, 5, 'one step more than before (4 named + 1)');
});

test('validate-entry.yml runs the store tests with explicit files, never a folder', () => {
  const yml = readFileSync(join(ROOT, '.github/workflows/validate-entry.yml'), 'utf8');
  assert.match(yml, /run: node --test scripts\/\*\.test\.mjs scripts\/lib\/\*\.test\.mjs\n/);
  assert.doesNotMatch(yml, /node --test scripts\/?\s*$/m);
  assert.equal((yml.match(/secrets\./g) ?? []).length, 0);
  assert.match(yml, /^permissions:\n {2}contents: read\n/m);
});

test('discover.mjs states the real GITHUB_TOKEN budget (1 000/h per repository), never 5000/h', () => {
  const src = readFileSync(join(HERE, 'discover.mjs'), 'utf8');
  assert.ok(!src.includes('5000/h'), '5000/h still in discover.mjs');
  assert.ok((src.match(/1 000\/h per repository/g) ?? []).length >= 2);
});

// ---- (2) the token never reaches stdout / stderr --------------------------------------

test('with a fake GITHUB_TOKEN neither stdout nor stderr (nor the file) contain it', () => {
  const token = 'ghs_LEAKCANARY_9f8e7d6c5b4a';
  const harness = `
    const { run } = await import(${JSON.stringify(SCRIPT_URL)});
    const env = (items) => ({ dataDate: 'd', items });
    const row = (repo) => ({ repo, summary: 's', stars: 1, starsGained: 1, measuredWindowDays: 7 });
    let n = 0;
    const fetchImpl = async (url, init) => {
      const u = String(url);
      if (u.endsWith('/skills.json')) return new Response(JSON.stringify(env([row('a/one'), row('b/two')])));
      if (u.endsWith('/mcp.json')) return new Response(JSON.stringify(env([row('c/three')])));
      if (!String(init?.headers?.authorization ?? '').includes(process.env.GITHUB_TOKEN)) throw new Error('no auth');
      n++;
      if (n === 2) return new Response('rate limited ' + init.headers.authorization, { status: 403 });
      return new Response(JSON.stringify({ full_name: u.split('/repos/')[1], description: 'd', license: null }));
    };
    let written = '';
    const code = await run(['--out', 'x/external-leads.json', '--source-base', 'http://s.test/data'], {
      fetchImpl, readCatalog: () => ({ skills: [] }), writeFileImpl: (p, t) => { written = t; },
    });
    process.stdout.write('\\nWRITTEN:' + written.length + ':' + written.includes(process.env.GITHUB_TOKEN) + '\\n');
    process.exitCode = code;
  `;
  // spawnSync, not execFileSync: stderr must be captured on success too.
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', harness], {
    env: { ...process.env, GITHUB_TOKEN: token },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout = String(child.stdout ?? '');
  const stderr = String(child.stderr ?? '');
  assert.equal(child.status, 0, `harness failed: ${stderr.replaceAll(token, '<token>')}`);
  assert.match(stderr, /GitHub answered HTTP 403/, 'stderr is really captured');
  assert.match(stdout, /WRITTEN:[1-9]\d*:false/);
  assert.ok(!stdout.includes(token), 'token on stdout');
  assert.ok(!stderr.includes(token), 'token on stderr');
  assert.ok(!stdout.includes('LEAKCANARY'));
});

// ---- (4) the source fetch: one request per file, 20 s timeout, a User-Agent ---------

test('findarepo: one GET per file, 20 s timeout, User-Agent, only skills.json and mcp.json', async () => {
  assert.equal(SOURCE_TIMEOUT_MS, 20_000);
  assert.equal(USER_AGENT, 'puppeteer-skill-store (+https://github.com/gitgiovik/puppeteer-skill-store)');
  assert.equal(DEFAULT_SOURCE_BASE, 'https://findarepo.com/data');
  const net = fakeNet({ skills: envelope([row('ok/skill-one')]), mcp: envelope([row('ok/mcp-one')]) });
  const { code, timeouts } = await go(net);
  assert.equal(code, 0);
  const source = net.calls.filter((c) => c.url.startsWith(BASE));
  assert.deepEqual(source.map((c) => c.url).sort(), [`${BASE}/mcp.json`, `${BASE}/skills.json`]);
  for (const c of source) {
    assert.ok(c.init.signal instanceof AbortSignal, 'a timeout signal on every source request');
    assert.equal(c.init.headers['user-agent'], USER_AGENT);
    assert.equal(c.init.headers.authorization, undefined, 'no token sent to findarepo');
  }
  assert.ok(timeouts.length >= 2 && timeouts.every((ms) => ms === SOURCE_TIMEOUT_MS));
  assert.ok(!net.calls.some((c) => c.url.includes('categories.json')));
});

test('a source failure (500, 403, network error, no items[]) writes nothing, exits 0, never retries', async () => {
  for (const bad of [500, 403, new Error('ECONNRESET'), { dataDate: 'x', count: 0 }]) {
    const net = fakeNet({ skills: bad, mcp: envelope([row('ok/mcp-one')]) });
    const { code, writes, lines } = await go(net);
    assert.equal(code, 0, `exit 0 on ${bad}`);
    assert.equal(writes.size, 0, `nothing written on ${bad}`);
    assert.equal(net.calls.filter((c) => c.url === `${BASE}/skills.json`).length, 1, 'no retry');
    assert.ok(!net.calls.some((c) => c.url.includes('api.github.com')), 'no enrichment after a source failure');
    assert.ok(lines.some((l) => /external-leads:/.test(l)), 'the failure is logged');
  }
});

// ---- the output document ----------------------------------------------------------------

test('writes a separate external-leads.json: no summary, GitHub description and licence, mcp not installable', async () => {
  const net = fakeNet({
    skills: envelope([row('ok/skill-one', 50, 'FINDAREPO-SUMMARY-SKILL'), row('anthropics/skills', 99)]),
    mcp: envelope([row('ok/mcp-one', 40, 'FINDAREPO-SUMMARY-MCP')]),
  });
  const { code, writes } = await go(net);
  assert.equal(code, 0);
  assert.deepEqual([...writes.keys()], [OUT]);
  const text = writes.get(OUT);
  assert.ok(!text.includes('FINDAREPO-SUMMARY'), 'no findarepo summary in the file');
  const doc = JSON.parse(text);
  assert.equal(doc.source, 'findarepo');
  assert.equal(doc.attribution, 'findarepo (findarepo.com) · CC BY 4.0');
  assert.equal(doc.license, 'CC-BY-4.0');
  assert.equal(doc.dataDate, '2026-10-03');
  assert.equal(doc.generatedAt, '2026-10-05T05:00:00.000Z');
  assert.deepEqual(
    doc.candidates.map((c) => [c.repo, c.kind, c.installable]),
    [
      ['ok/skill-one', 'skill', true],
      ['ok/mcp-one', 'mcp', false],
    ],
  );
  const lead = doc.candidates[0];
  assert.equal(lead.description, 'GitHub description of ok/skill-one');
  assert.equal(lead.licenseSpdx, 'MIT');
  assert.equal(lead.url, 'https://github.com/ok/skill-one');
  assert.ok(!('summary' in lead));
  assert.ok(!net.calls.some((c) => c.url.endsWith('/repos/anthropics/skills')), 'catalogue repos are not enriched');
});

test('refuses to write discovery.json (the document the shipped apps read unfiltered)', async () => {
  for (const out of ['discovery.json', join('..', 'data-branch', 'discovery.json'), 'x/DISCOVERY.JSON']) {
    const net = fakeNet();
    const { code, writes } = await go(net, ['--out', out, '--source-base', BASE]);
    assert.notEqual(code, 0, `refused ${out}`);
    assert.equal(writes.size, 0);
    assert.equal(net.calls.length, 0, 'no network before the refusal');
  }
});

test('--out is mandatory; --dry-run makes no call and writes nothing', async () => {
  const net = fakeNet();
  assert.notEqual((await go(net, ['--source-base', BASE])).code, 0);
  const dry = await go(net, ['--dry-run', '--out', OUT]);
  assert.equal(dry.code, 0);
  assert.equal(dry.writes.size, 0);
  assert.equal(net.calls.length, 0);
  assert.ok(dry.lines.some((l) => l.includes('skills.json') && l.includes('mcp.json')));
});

// ---- (5) the GitHub budget --------------------------------------------------------------

test('MAX_GITHUB_CALLS = 60: never more GitHub calls than that, never Search', async () => {
  assert.equal(MAX_GITHUB_CALLS, 60);
  const many = (p, n) => Array.from({ length: n }, (_, i) => row(`${p}/repo-${i}`, i));
  const net = fakeNet({ skills: envelope(many('s', 45)), mcp: envelope(many('m', 45)) });
  const { code, writes } = await go(net);
  assert.equal(code, 0);
  const gh = net.calls.filter((c) => c.url.includes('api.github.com'));
  assert.ok(gh.length <= MAX_GITHUB_CALLS, `${gh.length} GitHub calls`);
  assert.ok(!gh.some((c) => c.url.includes('/search/')));
  for (const c of gh) assert.equal(c.init.headers.authorization, 'bearer ghs_FAKE_TOKEN_0123456789');
  const doc = JSON.parse(writes.get(OUT));
  assert.equal(doc.candidates.filter((c) => c.kind === 'skill').length, 30);
  assert.equal(doc.candidates.filter((c) => c.kind === 'mcp').length, 30);
});

// ---- (6) identity resolved by GitHub goes through the WHOLE chain again --------------

test('a rename towards an excluded or catalogued name does not pass', async () => {
  // Old names are NEUTRAL, so only the second pass (on the identity GitHub resolves) can stop them.
  const renames = {
    'old/tool-one': 'Graphify-Labs/graphify',
    'old/tool-two': 'Anthropics/Skills',
    'old/tool-three': 'SnailSploit/Claude-Red',
    'old/tool-four': 'someone/second-brain-kit',
    'old/plain-helper': 'decolua/9router',
  };
  // Neutral new name too: only the GitHub description (known after the resolution) gives it away.
  const described = {
    'old/tool-five': ['acme/neutral-kit', 'Offensive security toolkit for red team work.'],
    'old/tool-six': ['acme/neutral-notes', 'A second brain for your daily notes.'],
  };
  const net = fakeNet({
    skills: envelope([...Object.keys(renames), ...Object.keys(described)].map((r) => row(r)).concat(row('ok/stays'))),
    github: (r) =>
      described[r] ? ghRepo(described[r][0], { description: described[r][1] }) : ghRepo(renames[r] ?? r),
  });
  const { writes } = await go(net);
  const doc = JSON.parse(writes.get(OUT));
  assert.deepEqual(
    doc.candidates.map((c) => c.repo),
    ['ok/stays'],
  );
});

test('every GitHub call failing, or an empty envelope, writes nothing and exits 0 (lens m2)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'leads-'));
  const out = join(dir, 'external-leads.json');
  const before = '{"previous":"week"}\n';
  writeFileSync(out, before);
  const mtime = statSync(out).mtimeMs;
  try {
    const cases = {
      'github 403 on every call': fakeNet({
        skills: envelope([row('ok/a'), row('ok/b')]),
        mcp: envelope([row('ok/c')]),
        github: 403,
      }),
      'github unreachable on every call': fakeNet({
        skills: envelope([row('ok/a')]),
        github: new Error('ECONNRESET'),
      }),
      'items: [] in both files': fakeNet({ skills: envelope([]), mcp: envelope([]) }),
    };
    for (const [name, net] of Object.entries(cases)) {
      const lines = [];
      const code = await run(['--out', out, '--source-base', BASE], {
        env: {},
        fetchImpl: net.fetchImpl,
        readCatalog: () => ({ skills: [] }),
        log: (s) => lines.push(String(s)),
        warn: (s) => lines.push(String(s)),
        now: () => new Date('2026-10-05T05:00:00.000Z'),
      });
      assert.equal(code, 0, name);
      assert.equal(readFileSync(out, 'utf8'), before, `${name}: last week's file is untouched`);
      assert.equal(statSync(out).mtimeMs, mtime, `${name}: mtime untouched`);
      assert.ok(lines.some((l) => /nothing written/.test(l)), `${name}: logged`);
    }
    // a partial failure still writes the survivors
    const partial = fakeNet({
      skills: envelope([row('ok/a', 9), row('ok/b', 8)]),
      github: (r) => (r === 'ok/a' ? 500 : ghRepo(r)),
    });
    const { writes } = await go(partial);
    assert.deepEqual(JSON.parse(writes.get(OUT)).candidates.map((c) => c.repo), ['ok/b']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('archived, private, unreachable or malformed repos are dropped; duplicates collapse', async () => {
  const net = fakeNet({
    skills: envelope([row('ok/archived', 9), row('ok/private', 8), row('ok/gone', 7), row('ok/weird', 6), row('ok/a', 5)]),
    mcp: envelope([row('ok/b', 5)]),
    github: (r) =>
      r === 'ok/archived'
        ? ghRepo(r, { archived: true })
        : r === 'ok/private'
          ? ghRepo(r, { private: true })
          : r === 'ok/gone'
            ? 404
            : r === 'ok/weird'
              ? ghRepo('../../etc')
              : r === 'ok/b'
                ? ghRepo('ok/a')
                : ghRepo(r),
  });
  const { code, writes } = await go(net);
  assert.equal(code, 0);
  assert.deepEqual(
    JSON.parse(writes.get(OUT)).candidates.map((c) => c.repo),
    ['ok/a'],
  );
});
