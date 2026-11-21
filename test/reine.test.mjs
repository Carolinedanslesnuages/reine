import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RULES, checkRepository, fixes } from '../src/rules.mjs';

const BINARY = fileURLToPath(new URL('../bin/reine.mjs', import.meta.url));
const compliantRepo = () => ({
  name: 'propre', full_name: 'moi/propre', owner: { login: 'moi' }, visibility: 'public', archived: false, fork: false,
  allow_squash_merge: true, allow_merge_commit: false, allow_rebase_merge: false,
  squash_merge_commit_title: 'PR_TITLE', squash_merge_commit_message: 'PR_BODY', delete_branch_on_merge: true, has_wiki: false,
  security_and_analysis: { secret_scanning: { status: 'enabled' }, secret_scanning_push_protection: { status: 'enabled' } },
});
const compliantExtra = () => ({ actions: { default_workflow_permissions: 'read', can_approve_pull_request_reviews: true }, alerts: true, workflowsWithoutPermissions: [] });
const writableActions = { default_workflow_permissions: 'write', can_approve_pull_request_reviews: false };
const statuses = (results) => Object.fromEntries(results.map((result) => [result.rule.id, result.status]));

test('un dépôt bien réglé est conforme partout', () => {
  assert.ok(checkRepository(compliantRepo(), compliantExtra()).every((result) => result.status === 'ok'));
});

test('chaque écart est repéré', () => {
  const repo = { ...compliantRepo(), allow_merge_commit: true, squash_merge_commit_title: 'COMMIT_OR_PR_TITLE', has_wiki: true };
  const found = statuses(checkRepository(repo, { ...compliantExtra(), alerts: false, actions: writableActions }));
  for (const ruleId of ['fusion-squash-seule', 'squash-titre-de-la-pr', 'wiki-desactive', 'alertes-dependabot', 'actions-lecture-seule', 'actions-peut-ouvrir-des-pr']) {
    assert.equal(found[ruleId], 'mismatch', ruleId);
  }
});

test('réglage illisible : non applicable, pas un écart', () => {
  const repo = { ...compliantRepo() };
  delete repo.security_and_analysis;
  assert.equal(statuses(checkRepository(repo, compliantExtra()))['detection-secrets'], 'unavailable');
});

test('garde-fou : pas de jeton en lecture seule si un workflow ne déclare pas ses droits', () => {
  const extra = { ...compliantExtra(), actions: { default_workflow_permissions: 'write', can_approve_pull_request_reviews: true }, workflowsWithoutPermissions: ['release.yml'] };
  const results = checkRepository(compliantRepo(), extra);
  const blocked = results.find((result) => result.rule.id === 'actions-lecture-seule');
  assert.equal(blocked.status, 'blocked');
  assert.match(blocked.blocker, /release\.yml/);
  assert.deepEqual(fixes(compliantRepo(), results), [], 'rien n’est corrigé');
});

test('config : règle désactivée partout, ou exception pour un dépôt', () => {
  const repo = { ...compliantRepo(), has_wiki: true };
  assert.equal(statuses(checkRepository(repo, compliantExtra(), { desactivees: ['wiki-desactive'] }))['wiki-desactive'], 'ignored');
  assert.equal(statuses(checkRepository(repo, compliantExtra(), { exceptions: { propre: ['wiki-desactive'] } }))['wiki-desactive'], 'ignored');
  assert.equal(statuses(checkRepository(repo, compliantExtra(), { exceptions: { autre: ['wiki-desactive'] } }))['wiki-desactive'], 'mismatch');
});

test('corrections : les bons appels, sans doublon', () => {
  const repo = { ...compliantRepo(), has_wiki: true };
  const results = checkRepository(repo, { ...compliantExtra(), alerts: false, actions: writableActions });
  const calls = fixes(repo, results).map((call) => `${call.method} ${call.path}`).sort();
  assert.deepEqual(calls, ['PATCH /repos/moi/propre', 'PUT /repos/moi/propre/actions/permissions/workflow', 'PUT /repos/moi/propre/vulnerability-alerts'].sort());
});

test('chaque règle dit pourquoi', () => {
  for (const rule of RULES) assert.ok(rule.reason.length > 40, rule.id);
});

/** Fake GitHub API: two repositories, one of them to fix; records every write. */
function fakeApi() {
  const repositories = {
    propre: compliantRepo(),
    brouillon: { ...compliantRepo(), name: 'brouillon', full_name: 'moi/brouillon', has_wiki: true, delete_branch_on_merge: false },
  };
  const alerts = { propre: true, brouillon: false };
  const writes = [];
  const server = createServer((request, response) => {
    let rawBody = '';
    request.on('data', (chunk) => (rawBody += chunk));
    request.on('end', () => {
      const send = (status, data) => {
        response.writeHead(status, { 'Content-Type': 'application/json' });
        response.end(data === undefined ? '' : JSON.stringify(data));
      };
      const path = request.url.split('?')[0];
      let match;
      if (path === '/user') return send(200, { login: 'moi' });
      if (path === '/user/repos') {
        return send(200, Object.values(repositories).map((repo) => ({ name: repo.name, full_name: repo.full_name, owner: repo.owner, visibility: repo.visibility, archived: false, fork: false })));
      }
      if ((match = /^\/repos\/moi\/([^/]+)$/.exec(path))) {
        if (request.method === 'PATCH') {
          writes.push(`PATCH ${match[1]}`);
          Object.assign(repositories[match[1]], JSON.parse(rawBody));
        }
        return send(200, repositories[match[1]]);
      }
      if (/^\/repos\/moi\/[^/]+\/actions\/permissions\/workflow$/.test(path)) return send(200, { default_workflow_permissions: 'read', can_approve_pull_request_reviews: true });
      if ((match = /^\/repos\/moi\/([^/]+)\/vulnerability-alerts$/.exec(path))) {
        if (request.method === 'PUT') {
          writes.push(`PUT alertes ${match[1]}`);
          alerts[match[1]] = true;
          return send(204);
        }
        return alerts[match[1]] ? send(204) : send(404, { message: 'Not Found' });
      }
      if (/\/contents\/\.github\/workflows$/.test(path)) return send(404, { message: 'Not Found' });
      return send(404, { message: 'inconnu' });
    });
  });
  return new Promise((resolve) => server.listen(0, () => resolve({ server, apiBase: `http://127.0.0.1:${server.address().port}`, writes })));
}

const runCli = (apiBase, args, workingDirectory) => new Promise((resolve) => {
  const child = spawn(process.execPath, [BINARY, ...args], { cwd: workingDirectory, env: { ...process.env, REINE_API_BASE: apiBase, GITHUB_TOKEN: 'faux' } });
  let output = '';
  child.stdout.on('data', (chunk) => (output += chunk));
  child.stderr.on('data', (chunk) => (output += chunk));
  child.on('close', (code) => resolve({ code, output }));
});

test('commande : verifier ne change rien ; appliquer corrige puis revérifie', async () => {
  const { server, apiBase, writes } = await fakeApi();
  const folder = mkdtempSync(join(tmpdir(), 'reine-'));
  try {
    const check = await runCli(apiBase, ['verifier'], folder);
    assert.equal(check.code, 1);
    assert.match(check.output, /✗ brouillon\s+supprimer-branche-fusionnee, alertes-dependabot, wiki-desactive/);
    assert.match(check.output, /✓ propre\s+conforme/);
    assert.deepEqual(writes, [], 'verifier n’écrit rien');
    const json = JSON.parse((await runCli(apiBase, ['verifier', '--json'], folder)).output);
    assert.deepEqual(Object.keys(json[0]), ['depot', 'resultats'], 'format JSON inchangé');
    assert.ok(json.find((entry) => entry.depot === 'moi/brouillon').resultats.some((result) => result.statut === 'ecart'));
    const withoutYes = await runCli(apiBase, ['appliquer'], folder);
    assert.match(withoutYes.output, /ajoutez --oui/);
    assert.deepEqual(writes, []);
    writeFileSync(join(folder, 'reine.json'), JSON.stringify({ exceptions: { brouillon: ['wiki-desactive'] } }));
    const apply = await runCli(apiBase, ['appliquer', '--oui'], folder);
    assert.equal(apply.code, 0, apply.output);
    assert.deepEqual(writes.sort(), ['PATCH brouillon', 'PUT alertes brouillon']);
    assert.match(apply.output, /Après correction :\n✓ brouillon\s+conforme/);
  } finally {
    server.close();
  }
});
