#!/usr/bin/env node
/** Reine : les mêmes réglages GitHub dans tous vos dépôts. */
import { readFileSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { REGLES, verifierDepot, corrections } from '../src/regles.mjs';
import { client } from '../src/github.mjs';

const AIDE = `Reine · les mêmes réglages GitHub dans tous vos dépôts

  reine regles                    les règles, et pourquoi chacune compte
  reine verifier [dépôts…]        vérifie, sans rien changer
  reine appliquer [dépôts…]       montre les changements, demande confirmation, corrige

  Sans dépôt nommé : tous vos dépôts publics (ni archivés, ni fourches).
  --prives / --tous               les dépôts privés, ou tous
  --config <fichier>              règles désactivées et exceptions (défaut : ./reine.json)
  --oui                           appliquer sans demander (scripts)
  --json                          résultat en JSON

Jeton : celui de « gh » (gh auth login), ou GITHUB_TOKEN.`;

function options(args) {
  const o = { depots: [], visibilite: 'public', config: 'reine.json' };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--prives') o.visibilite = 'private';
    else if (a === '--tous') o.visibilite = 'all';
    else if (a === '--oui') o.oui = true;
    else if (a === '--json') o.json = true;
    else if (a === '--config') o.config = args[++i];
    else if (a.startsWith('--')) throw new Error(`Option inconnue : ${a}. Tapez « reine aide ».`);
    else o.depots.push(a);
  }
  return o;
}

function lireConfig(chemin) {
  if (!existsSync(chemin)) return {};
  try {
    return JSON.parse(readFileSync(chemin, 'utf8'));
  } catch (e) {
    throw new Error(`${chemin} illisible : ${e.message}`);
  }
}

async function cibles(gh, o) {
  const compte = await gh.moi();
  if (o.depots.length) return Promise.all(o.depots.map((n) => gh.depot(n.includes('/') ? n : `${compte}/${n}`)));
  const tous = await gh.depots(compte);
  // La liste ne contient pas les réglages de fusion ni de sécurité : on lit la fiche complète de chaque dépôt.
  const choisis = tous.filter((d) => !d.archived && !d.fork && (o.visibilite === 'all' || d.visibility === o.visibilite)).sort((a, b) => a.name.localeCompare(b.name));
  return Promise.all(choisis.map((d) => gh.depot(d.full_name)));
}

async function bilan(gh, depots, config) {
  const lignes = [];
  for (const d of depots) {
    const resultats = verifierDepot(d, await gh.extra(d.full_name), config);
    lignes.push({ depot: d, resultats });
  }
  return lignes;
}

function afficher(lignes) {
  const larg = Math.max(...lignes.map((l) => l.depot.name.length));
  for (const { depot, resultats } of lignes) {
    const ecarts = resultats.filter((x) => x.statut === 'ecart');
    const bloquees = resultats.filter((x) => x.statut === 'bloquee');
    const na = resultats.filter((x) => x.statut === 'na').length;
    console.log(`${ecarts.length || bloquees.length ? '✗' : '✓'} ${depot.name.padEnd(larg)}  ${ecarts.length ? ecarts.map((x) => x.regle.id).join(', ') : bloquees.length ? '' : 'conforme'}${na ? `  (${na} non applicable${na > 1 ? 's' : ''})` : ''}`);
    for (const b of bloquees) console.log(`    ⚠ ${b.regle.id} non corrigeable tel quel : ${b.blocage}`);
  }
  const total = lignes.reduce((n, l) => n + l.resultats.filter((x) => x.statut === 'ecart').length, 0);
  const conformes = lignes.filter((l) => !l.resultats.some((x) => x.statut === 'ecart')).length;
  console.log(`\n${lignes.length} dépôt${lignes.length > 1 ? 's' : ''} · ${conformes} conforme${conformes > 1 ? 's' : ''} · ${total} écart${total > 1 ? 's' : ''}`);
  return total;
}

async function principal() {
  const [commande, ...reste] = process.argv.slice(2);
  if (!commande || ['aide', '--aide', '-h', '--help'].includes(commande)) return console.log(AIDE);
  const o = options(reste);
  if (commande === 'regles') {
    for (const r of REGLES) console.log(`• ${r.titre} (${r.id})\n  ${r.pourquoi}\n`);
    return;
  }
  if (!['verifier', 'appliquer'].includes(commande)) throw new Error(`Commande inconnue : ${commande}. Tapez « reine aide ».`);
  const config = lireConfig(o.config);
  const gh = client();
  const depots = await cibles(gh, o);
  if (!depots.length) return console.log('Aucun dépôt à vérifier.');
  const lignes = await bilan(gh, depots, config);

  if (o.json) {
    console.log(JSON.stringify(lignes.map((l) => ({ depot: l.depot.full_name, resultats: l.resultats.map((x) => ({ regle: x.regle.id, statut: x.statut, actuel: x.actuel, attendu: x.regle.attendu })) })), null, 2));
    if (commande === 'verifier' && lignes.some((l) => l.resultats.some((x) => x.statut === 'ecart'))) process.exitCode = 1;
    return;
  }
  const total = afficher(lignes);
  if (commande === 'verifier') {
    if (total) {
      console.log('\nDétail : reine regles · Corriger : reine appliquer');
      process.exitCode = 1;
    }
    return;
  }
  if (!total) return;

  const plan = lignes.map((l) => ({ depot: l.depot, appels: corrections(l.depot, l.resultats), ecarts: l.resultats.filter((x) => x.statut === 'ecart') })).filter((p) => p.appels.length);
  console.log('\nChangements prévus :');
  for (const p of plan) for (const e of p.ecarts) console.log(`  ${p.depot.name} · ${e.regle.titre}`);
  if (!o.oui) {
    if (!process.stdin.isTTY) throw new Error('Pas de terminal pour confirmer : ajoutez --oui.');
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const ok = /^o/i.test((await rl.question('\nAppliquer ces changements ? (o/N) ')).trim());
    rl.close();
    if (!ok) return console.log('Rien n’a été changé.');
  }
  let echecs = 0;
  for (const p of plan) {
    for (const a of p.appels) {
      const r = await gh.appel(a.methode, a.chemin, a.corps);
      if (r.statut >= 300) {
        echecs++;
        console.log(`  ✗ ${p.depot.name} : ${a.methode} ${a.chemin.split('/').slice(4).join('/') || 'réglages'} refusé (${r.statut}${r.donnees && r.donnees.message ? ' : ' + r.donnees.message : ''})`);
      }
    }
  }
  console.log('\nAprès correction :');
  const apres = await bilan(gh, await Promise.all(plan.map((p) => gh.depot(p.depot.full_name))), config);
  afficher(apres);
  if (echecs) process.exitCode = 1;
}

principal().catch((e) => {
  console.error(`reine : ${e.message}`);
  process.exit(1);
});
