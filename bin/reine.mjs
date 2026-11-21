#!/usr/bin/env node
/** Reine: the same GitHub settings in all your repositories. */
import { readFileSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { RULES, checkRepository, fixes } from '../src/rules.mjs';
import { client } from '../src/github.mjs';

const HELP = `Reine · les mêmes réglages GitHub dans tous vos dépôts

  reine regles                    les règles, et pourquoi chacune compte
  reine verifier [dépôts…]        vérifie, sans rien changer
  reine appliquer [dépôts…]       montre les changements, demande confirmation, corrige

  Sans dépôt nommé : tous vos dépôts publics (ni archivés, ni fourches).
  --prives / --tous               les dépôts privés, ou tous
  --config <fichier>              règles désactivées et exceptions (défaut : ./reine.json)
  --oui                           appliquer sans demander (scripts)
  --json                          résultat en JSON

Jeton : celui de « gh » (gh auth login), ou GITHUB_TOKEN.`;

/** Status names in the --json output (public format, kept in French). */
const JSON_STATUS = { ok: 'ok', mismatch: 'ecart', unavailable: 'na', ignored: 'ignoree', blocked: 'bloquee' };

function parseOptions(args) {
  const options = { repositories: [], visibility: 'public', config: 'reine.json' };
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--prives') options.visibility = 'private';
    else if (argument === '--tous') options.visibility = 'all';
    else if (argument === '--oui') options.yes = true;
    else if (argument === '--json') options.json = true;
    else if (argument === '--config') options.config = args[++index];
    else if (argument.startsWith('--')) throw new Error(`Option inconnue : ${argument}. Tapez « reine aide ».`);
    else options.repositories.push(argument);
  }
  return options;
}

function readConfig(path) {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`${path} illisible : ${error.message}`);
  }
}

async function targets(github, options) {
  const owner = await github.currentUser();
  if (options.repositories.length) {
    return Promise.all(options.repositories.map((name) => github.repository(name.includes('/') ? name : `${owner}/${name}`)));
  }
  const listed = await github.repositories(owner);
  // The listing lacks merge and security settings: read the full record of each repository.
  const selected = listed
    .filter((repo) => !repo.archived && !repo.fork && (options.visibility === 'all' || repo.visibility === options.visibility))
    .sort((left, right) => left.name.localeCompare(right.name));
  return Promise.all(selected.map((repo) => github.repository(repo.full_name)));
}

async function review(github, repositories, config) {
  const reports = [];
  for (const repo of repositories) {
    reports.push({ repo, results: checkRepository(repo, await github.extra(repo.full_name), config) });
  }
  return reports;
}

const plural = (count, word) => `${count} ${word}${count > 1 ? 's' : ''}`;
const withStatus = (results, status) => results.filter((result) => result.status === status);

function print(reports) {
  const width = Math.max(...reports.map((report) => report.repo.name.length));
  for (const { repo, results } of reports) {
    const mismatches = withStatus(results, 'mismatch');
    const blocked = withStatus(results, 'blocked');
    const unavailable = withStatus(results, 'unavailable').length;
    const summary = mismatches.length ? mismatches.map((result) => result.rule.id).join(', ') : blocked.length ? '' : 'conforme';
    const unavailableNote = unavailable ? `  (${unavailable} non applicable${unavailable > 1 ? 's' : ''})` : '';
    console.log(`${mismatches.length || blocked.length ? '✗' : '✓'} ${repo.name.padEnd(width)}  ${summary}${unavailableNote}`);
    for (const result of blocked) console.log(`    ⚠ ${result.rule.id} non corrigeable tel quel : ${result.blocker}`);
  }
  const total = reports.reduce((count, report) => count + withStatus(report.results, 'mismatch').length, 0);
  const compliant = reports.filter((report) => !withStatus(report.results, 'mismatch').length).length;
  console.log(`\n${plural(reports.length, 'dépôt')} · ${plural(compliant, 'conforme')} · ${plural(total, 'écart')}`);
  return total;
}

function printJson(command, reports) {
  const output = reports.map((report) => ({
    depot: report.repo.full_name,
    resultats: report.results.map((result) => ({ regle: result.rule.id, statut: JSON_STATUS[result.status], actuel: result.current, attendu: result.rule.expected })),
  }));
  console.log(JSON.stringify(output, null, 2));
  if (command === 'verifier' && reports.some((report) => withStatus(report.results, 'mismatch').length)) process.exitCode = 1;
}

async function confirm(options) {
  if (options.yes) return true;
  if (!process.stdin.isTTY) throw new Error('Pas de terminal pour confirmer : ajoutez --oui.');
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  const accepted = /^o/i.test((await prompt.question('\nAppliquer ces changements ? (o/N) ')).trim());
  prompt.close();
  return accepted;
}

async function apply(github, reports, options, config) {
  const plan = reports
    .map((report) => ({ repo: report.repo, calls: fixes(report.repo, report.results), mismatches: withStatus(report.results, 'mismatch') }))
    .filter((step) => step.calls.length);
  console.log('\nChangements prévus :');
  for (const step of plan) for (const mismatch of step.mismatches) console.log(`  ${step.repo.name} · ${mismatch.rule.title}`);
  if (!(await confirm(options))) return console.log('Rien n’a été changé.');
  let failures = 0;
  for (const step of plan) {
    for (const call of step.calls) {
      const result = await github.call(call.method, call.path, call.body);
      if (result.status >= 300) {
        failures++;
        const target = call.path.split('/').slice(4).join('/') || 'réglages';
        const detail = result.data && result.data.message ? ' : ' + result.data.message : '';
        console.log(`  ✗ ${step.repo.name} : ${call.method} ${target} refusé (${result.status}${detail})`);
      }
    }
  }
  console.log('\nAprès correction :');
  print(await review(github, await Promise.all(plan.map((step) => github.repository(step.repo.full_name))), config));
  if (failures) process.exitCode = 1;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || ['aide', '--aide', '-h', '--help'].includes(command)) return console.log(HELP);
  const options = parseOptions(rest);
  if (command === 'regles') {
    for (const rule of RULES) console.log(`• ${rule.title} (${rule.id})\n  ${rule.reason}\n`);
    return;
  }
  if (!['verifier', 'appliquer'].includes(command)) throw new Error(`Commande inconnue : ${command}. Tapez « reine aide ».`);
  const config = readConfig(options.config);
  const github = client();
  const repositories = await targets(github, options);
  if (!repositories.length) return console.log('Aucun dépôt à vérifier.');
  const reports = await review(github, repositories, config);
  if (options.json) return printJson(command, reports);
  const total = print(reports);
  if (command === 'verifier') {
    if (total) {
      console.log('\nDétail : reine regles · Corriger : reine appliquer');
      process.exitCode = 1;
    }
    return;
  }
  if (total) await apply(github, reports, options, config);
}

main().catch((error) => {
  console.error(`reine : ${error.message}`);
  process.exit(1);
});
