import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REGLES, verifierDepot, corrections } from '../src/regles.mjs';

const BIN = fileURLToPath(new URL('../bin/reine.mjs', import.meta.url));
const conforme = () => ({
  name: 'propre', full_name: 'moi/propre', owner: { login: 'moi' }, visibility: 'public', archived: false, fork: false,
  allow_squash_merge: true, allow_merge_commit: false, allow_rebase_merge: false,
  squash_merge_commit_title: 'PR_TITLE', squash_merge_commit_message: 'PR_BODY', delete_branch_on_merge: true, has_wiki: false,
  security_and_analysis: { secret_scanning: { status: 'enabled' }, secret_scanning_push_protection: { status: 'enabled' } },
});
const extraOk = () => ({ actions: { default_workflow_permissions: 'read', can_approve_pull_request_reviews: true }, alertes: true, workflowsSansPermissions: [] });
const statuts = (r) => Object.fromEntries(r.map((x) => [x.regle.id, x.statut]));

test('un dépôt bien réglé est conforme partout', () => {
  assert.ok(verifierDepot(conforme(), extraOk()).every((x) => x.statut === 'ok'));
});

test('chaque écart est repéré', () => {
  const d = { ...conforme(), allow_merge_commit: true, squash_merge_commit_title: 'COMMIT_OR_PR_TITLE', has_wiki: true };
  const s = statuts(verifierDepot(d, { ...extraOk(), alertes: false, actions: { default_workflow_permissions: 'write', can_approve_pull_request_reviews: false } }));
  for (const id of ['fusion-squash-seule', 'squash-titre-de-la-pr', 'wiki-desactive', 'alertes-dependabot', 'actions-lecture-seule', 'actions-peut-ouvrir-des-pr']) assert.equal(s[id], 'ecart', id);
});

test('réglage illisible : non applicable, pas un écart', () => {
  const d = { ...conforme() };
  delete d.security_and_analysis;
  assert.equal(statuts(verifierDepot(d, extraOk()))['detection-secrets'], 'na');
});

test('garde-fou : pas de jeton en lecture seule si un workflow ne déclare pas ses droits', () => {
  const r = verifierDepot(conforme(), { ...extraOk(), actions: { default_workflow_permissions: 'write', can_approve_pull_request_reviews: true }, workflowsSansPermissions: ['release.yml'] });
  const b = r.find((x) => x.regle.id === 'actions-lecture-seule');
  assert.equal(b.statut, 'bloquee');
  assert.match(b.blocage, /release\.yml/);
  assert.deepEqual(corrections(conforme(), r), [], 'rien n’est corrigé');
});

test('config : règle désactivée partout, ou exception pour un dépôt', () => {
  const d = { ...conforme(), has_wiki: true };
  assert.equal(statuts(verifierDepot(d, extraOk(), { desactivees: ['wiki-desactive'] }))['wiki-desactive'], 'ignoree');
  assert.equal(statuts(verifierDepot(d, extraOk(), { exceptions: { propre: ['wiki-desactive'] } }))['wiki-desactive'], 'ignoree');
  assert.equal(statuts(verifierDepot(d, extraOk(), { exceptions: { autre: ['wiki-desactive'] } }))['wiki-desactive'], 'ecart');
});

test('corrections : les bons appels, sans doublon', () => {
  const d = { ...conforme(), has_wiki: true };
  const r = verifierDepot(d, { ...extraOk(), alertes: false, actions: { default_workflow_permissions: 'write', can_approve_pull_request_reviews: false } });
  const a = corrections(d, r);
  assert.deepEqual(a.map((x) => `${x.methode} ${x.chemin}`).sort(), ['PATCH /repos/moi/propre', 'PUT /repos/moi/propre/actions/permissions/workflow', 'PUT /repos/moi/propre/vulnerability-alerts'].sort());
});

test('chaque règle dit pourquoi', () => {
  for (const r of REGLES) assert.ok(r.pourquoi.length > 40, r.id);
});

/** Fausse API GitHub : deux dépôts, dont un à corriger ; enregistre les écritures. */
function fausseApi() {
  const depots = { propre: conforme(), brouillon: { ...conforme(), name: 'brouillon', full_name: 'moi/brouillon', has_wiki: true, delete_branch_on_merge: false } };
  const alertes = { propre: true, brouillon: false };
  const ecritures = [];
  const serveur = createServer((req, res) => {
    let corps = '';
    req.on('data', (c) => (corps += c));
    req.on('end', () => {
      const envoyer = (statut, donnees) => { res.writeHead(statut, { 'Content-Type': 'application/json' }); res.end(donnees === undefined ? '' : JSON.stringify(donnees)); };
      const u = req.url.split('?')[0];
      let m;
      if (u === '/user') return envoyer(200, { login: 'moi' });
      if (u === '/user/repos') return envoyer(200, Object.values(depots).map((d) => ({ name: d.name, full_name: d.full_name, owner: d.owner, visibility: d.visibility, archived: false, fork: false })));
      if ((m = /^\/repos\/moi\/([^/]+)$/.exec(u))) {
        if (req.method === 'PATCH') { ecritures.push(`PATCH ${m[1]}`); Object.assign(depots[m[1]], JSON.parse(corps)); }
        return envoyer(200, depots[m[1]]);
      }
      if ((m = /^\/repos\/moi\/([^/]+)\/actions\/permissions\/workflow$/.exec(u))) return envoyer(200, { default_workflow_permissions: 'read', can_approve_pull_request_reviews: true });
      if ((m = /^\/repos\/moi\/([^/]+)\/vulnerability-alerts$/.exec(u))) {
        if (req.method === 'PUT') { ecritures.push(`PUT alertes ${m[1]}`); alertes[m[1]] = true; return envoyer(204); }
        return alertes[m[1]] ? envoyer(204) : envoyer(404, { message: 'Not Found' });
      }
      if (/\/contents\/\.github\/workflows$/.test(u)) return envoyer(404, { message: 'Not Found' });
      return envoyer(404, { message: 'inconnu' });
    });
  });
  return new Promise((ok) => serveur.listen(0, () => ok({ serveur, base: `http://127.0.0.1:${serveur.address().port}`, ecritures })));
}
const lancer = (base, args, cwd) => new Promise((ok) => {
  const p = spawn(process.execPath, [BIN, ...args], { cwd, env: { ...process.env, REINE_API_BASE: base, GITHUB_TOKEN: 'faux' } });
  let sortie = '';
  p.stdout.on('data', (d) => (sortie += d));
  p.stderr.on('data', (d) => (sortie += d));
  p.on('close', (code) => ok({ code, sortie }));
});

test('commande : verifier ne change rien ; appliquer corrige puis revérifie', async () => {
  const { serveur, base, ecritures } = await fausseApi();
  const dossier = mkdtempSync(join(tmpdir(), 'reine-'));
  try {
    const v = await lancer(base, ['verifier'], dossier);
    assert.equal(v.code, 1);
    assert.match(v.sortie, /✗ brouillon\s+supprimer-branche-fusionnee, alertes-dependabot, wiki-desactive/);
    assert.match(v.sortie, /✓ propre\s+conforme/);
    assert.deepEqual(ecritures, [], 'verifier n’écrit rien');
    const sansOui = await lancer(base, ['appliquer'], dossier);
    assert.match(sansOui.sortie, /ajoutez --oui/);
    assert.deepEqual(ecritures, []);
    writeFileSync(join(dossier, 'reine.json'), JSON.stringify({ exceptions: { brouillon: ['wiki-desactive'] } }));
    const a = await lancer(base, ['appliquer', '--oui'], dossier);
    assert.equal(a.code, 0, a.sortie);
    assert.deepEqual(ecritures.sort(), ['PATCH brouillon', 'PUT alertes brouillon']);
    assert.match(a.sortie, /Après correction :\n✓ brouillon\s+conforme/);
  } finally {
    serveur.close();
  }
});
