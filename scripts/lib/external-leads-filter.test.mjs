// Run with: node --test scripts/lib/external-leads-filter.test.mjs (no dependencies).
// Fixture repos are REAL findarepo entries seen on 2026-10-03; the summaries are short
// paraphrases written here, never findarepo's own text (condition (d): no summary is
// redistributed, not even in a test fixture).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALLOWED_SOURCE_FILES,
  FORBIDDEN_SOURCE_FILES,
  DENY_TERM_GROUPS,
  INTEGRATED_NAMES,
  INTEGRATED_TERMS,
  MAX_LEADS_PER_KIND,
  parseFindarepoItems,
  dropKnown,
  dropByDenyTerms,
  dropIntegrated,
  capByMomentum,
  filterChain,
  toLeads,
} from './external-leads-filter.mjs';

const item = (repo, summary = '', starsGained = 10, kind = 'skill') => ({
  repo,
  kind,
  summary,
  stars: 100,
  starsGained,
  measuredWindowDays: 7,
});
const repos = (items) => items.map((i) => i.repo);

test('reads only skills.json and mcp.json, never categories.json (condition f)', () => {
  assert.deepEqual(ALLOWED_SOURCE_FILES, { skill: 'skills.json', mcp: 'mcp.json' });
  assert.ok(FORBIDDEN_SOURCE_FILES.includes('categories.json'));
  assert.ok(!Object.values(ALLOWED_SOURCE_FILES).includes('categories.json'));
  assert.throws(() => parseFindarepoItems({ items: [] }, 'categories'), /kind/);
});

test('parseFindarepoItems: an envelope without items[] is rejected, junk rows are skipped', () => {
  assert.equal(parseFindarepoItems({ count: 0 }, 'skill'), null);
  assert.equal(parseFindarepoItems(null, 'mcp'), null);
  const out = parseFindarepoItems(
    {
      items: [
        { repo: 'Graphify-Labs/graphify', summary: 'x', stars: 5, starsGained: 3, measuredWindowDays: 7 },
        { repo: 'not a repo' },
        { repo: '../etc/passwd' },
        'string',
      ],
    },
    'skill',
  );
  assert.deepEqual(repos(out), ['Graphify-Labs/graphify']);
  assert.equal(out[0].kind, 'skill');
});

test('dropKnown: a repo already in catalog.json never comes out (case-insensitive)', () => {
  const known = new Set(['anthropics/skills']);
  const out = dropKnown([item('Anthropics/Skills'), item('mksglu/context-mode')], known);
  assert.deepEqual(repos(out), ['mksglu/context-mode']);
});

test('dropByDenyTerms: every group has a reason and drops its real-world fixtures', () => {
  const fixtures = {
    'subscription-relay': [
      item('router-for-me/CLIProxyAPI', 'Turns a CLI subscription into an API for other apps.'),
      item('Wei-Shaw/sub2api', 'A relay service over several assistant subscriptions.'),
      item('Wei-Shaw/claude-relay-service', 'Self-hosted mirror and relay for assistants.'),
      item('justlovemaki/AIClient2API', 'Self-hosted multi-protocol API proxy for many providers.'),
      item('lidge-jun/opencodex', 'Universal provider proxy for coding agents.'),
    ],
    'prompt-leak': [
      item('asgeirtj/system_prompts_leaks', 'Internal instructions extracted from assistants.'),
      item('x1xhlol/system-prompts-and-models-of-ai-tools', 'Leaked instructions of AI tools.'),
      item('Piebald-AI/claude-code-system-prompts', 'Every part of an assistant system prompt.'),
    ],
    'tos-bypass': [
      item('feder-cr/invisible_playwright_mcp', 'Browser automation undetected by anti-bot checks and captchas.', 9, 'mcp'),
      item('vibheksoni/stealth-browser-mcp', 'Browser automation that gets past anti-bot systems.', 9, 'mcp'),
      item('verygoodplugins/whatsapp-mcp', 'Read and send WhatsApp messages from an agent.', 9, 'mcp'),
    ],
    'offensive-or-reverse-engineering': [
      item('zhaoxuya520/reverse-skill', 'Router pack for reverse engineering and penetration testing.'),
      item('SnailSploit/Claude-Red', 'Library of offensive security skills.'),
      item('SimoneAvogadro/android-reverse-engineering-skill', 'Helps take Android apps apart.'),
      item('bethington/ghidra-mcp', 'Tools that drive Ghidra.', 9, 'mcp'),
      item('mrexodia/ida-pro-mcp', 'Bridges IDA Pro with a model.', 9, 'mcp'),
      item('zhizhuodemao/js-reverse-mcp', 'JS reverse tooling with a headed browser.', 9, 'mcp'),
      item('1-3-7/disrobe', 'Decompiler, deobfuscator and unpacker for malware analysis.', 9, 'mcp'),
      item('miscusi-peek/cheatengine-mcp-bridge', 'Drives Cheat Engine from an agent.', 9, 'mcp'),
      item('LING71671/open-reverselab', 'Agent platform for Ghidra, Frida and x64dbg.', 9, 'mcp'),
    ],
  };
  const reasons = DENY_TERM_GROUPS.map((g) => g.reason).sort();
  assert.deepEqual(reasons, Object.keys(fixtures).sort());
  for (const g of DENY_TERM_GROUPS) {
    assert.ok(g.patterns.length > 0, `group ${g.reason} has patterns`);
    for (const fx of fixtures[g.reason]) {
      assert.deepEqual(repos(dropByDenyTerms([fx])), [], `${fx.repo} should be dropped as ${g.reason}`);
    }
  }
});

test('dropByDenyTerms keeps ordinary skills and MCP servers', () => {
  const keep = [
    item('nidhinjs/prompt-master', 'Writes accurate prompts for any AI tool.'),
    item('firecrawl/firecrawl-mcp-server', 'Official web scraping and search server.', 9, 'mcp'),
    item('mksglu/context-mode', 'Context window optimization for coding agents.', 9, 'mcp'),
  ];
  assert.deepEqual(repos(dropByDenyTerms(keep)), repos(keep));
});

test('dropIntegrated: the five contested by the owner never come out', () => {
  for (const n of ['ponytail', 'caveman', 'claude-obsidian', 'graphify', 'obsidian-second-brain']) {
    assert.ok(INTEGRATED_NAMES.some((r) => r.name === n), `${n} listed`);
  }
  const contested = [
    item('someone/ponytail', 'Lazy minimal coding.'),
    item('someone/caveman', 'Talk like a caveman to save tokens.'),
    item('AgriciDaniel/claude-obsidian', 'Self-organizing notes for a vault.'),
    item('Graphify-Labs/graphify', 'Turn a codebase into a queryable graph.'),
    item('eugeniughelbur/obsidian-second-brain', 'Notes vault for agents.'),
    item('someone/my-second-brain', 'Personal notes.'),
    item('YishenTu/claudian', 'An Obsidian plugin that embeds an agent in your vault.'),
  ];
  assert.deepEqual(repos(dropIntegrated(contested)), []);
});

test('dropIntegrated: INTEGRATED_TERMS works like the native gate (two terms, one in the name)', () => {
  for (const g of INTEGRATED_TERMS) assert.ok(g.reason && g.feature && g.terms.length > 1);
  const out = dropIntegrated([
    // two brain terms (memory, persistent), one in the name ⇒ dropped
    item('okf-memory/okf-agent-memory', 'Git-native persistent memory for coding agents.', 9, 'mcp'),
    item('DeusData/codebase-memory-mcp', 'Indexes codebases into a persistent knowledge graph.', 9, 'mcp'),
    // terms only in the summary, none in the name ⇒ kept
    item('mksglu/context-mode', 'Sandboxes tool output and persists session memory.', 9, 'mcp'),
    // one term in the name, no second term ⇒ kept
    item('someone/memory-of-colors', 'Palette picker.'),
  ]);
  assert.deepEqual(repos(out), ['mksglu/context-mode', 'someone/memory-of-colors']);
});

test('capByMomentum: at most 30 per kind, by starsGained descending', () => {
  assert.equal(MAX_LEADS_PER_KIND, 30);
  const many = [];
  for (let i = 0; i < 40; i++) many.push(item(`s/skill-${i}`, '', i, 'skill'));
  for (let i = 0; i < 40; i++) many.push(item(`m/mcp-${i}`, '', i, 'mcp'));
  const out = capByMomentum(many, MAX_LEADS_PER_KIND);
  assert.equal(out.filter((i) => i.kind === 'skill').length, 30);
  assert.equal(out.filter((i) => i.kind === 'mcp').length, 30);
  assert.equal(out[0].starsGained, 39);
  const skillGains = out.filter((i) => i.kind === 'skill').map((i) => i.starsGained);
  assert.deepEqual(skillGains, [...skillGains].sort((a, b) => b - a));
  assert.ok(!out.some((i) => i.starsGained < 10));
});

test('filterChain runs dropKnown, dropByDenyTerms and dropIntegrated together', () => {
  const out = filterChain(
    [item('anthropics/skills'), item('SnailSploit/Claude-Red', 'offensive security'), item('Graphify-Labs/graphify'), item('ok/fine-skill')],
    new Set(['anthropics/skills']),
  );
  assert.deepEqual(repos(out), ['ok/fine-skill']);
});

test('toLeads: no findarepo summary, url only https://github.com/<repo>, mcp not installable', () => {
  const doc = toLeads(
    [
      {
        ...item('ok/fine-skill', 'FINDAREPO SUMMARY TEXT', 5, 'skill'),
        description: 'From GitHub.',
        licenseSpdx: 'MIT',
        createdAt: '2026-01-01T00:00:00Z',
      },
      { ...item('ok/fine-mcp', 'FINDAREPO SUMMARY TEXT', 4, 'mcp'), description: null, licenseSpdx: null, createdAt: null },
    ],
    { dataDate: '2026-10-03', generatedAt: '2026-10-05T05:00:00.000Z' },
  );
  assert.equal(doc.source, 'findarepo');
  assert.equal(doc.attribution, 'findarepo (findarepo.com) · CC BY 4.0');
  assert.equal(doc.license, 'CC-BY-4.0');
  assert.equal(doc.dataDate, '2026-10-03');
  assert.ok(!JSON.stringify(doc).includes('FINDAREPO SUMMARY TEXT'));
  for (const lead of doc.candidates) {
    assert.ok(!('summary' in lead));
    assert.equal(lead.url, `https://github.com/${lead.repo}`);
  }
  assert.equal(doc.candidates[0].installable, true);
  assert.equal(doc.candidates[1].installable, false);
  assert.equal(doc.candidates[0].description, 'From GitHub.');
});

test('toLeads: descriptions are capped at 300 characters', () => {
  const doc = toLeads([{ ...item('ok/long'), description: 'x'.repeat(500), licenseSpdx: null, createdAt: null }], {
    dataDate: 'd',
    generatedAt: 'g',
  });
  assert.equal(doc.candidates[0].description.length, 300);
});
