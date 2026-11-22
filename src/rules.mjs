/**
 * Reine's rules: a GitHub setting, its expected value, and WHY it matters.
 * Each rule knows how to read itself on a repository (`read`) and how to fix itself (`fix`: API
 * calls). `read` returns the current value, or `undefined` when it is not available (for example a
 * feature reserved to public repositories on a free account): the rule is then "not applicable".
 * Rule ids are public: they are used in reine.json.
 */
const patchSettings = (fields) => (repo) => [{ method: 'PATCH', path: `/repos/${repo.full_name}`, body: fields }];
const ACTIONS_SETTINGS = { default_workflow_permissions: 'read', can_approve_pull_request_reviews: true };
const putActionsSettings = (repo) => [{ method: 'PUT', path: `/repos/${repo.full_name}/actions/permissions/workflow`, body: ACTIONS_SETTINGS }];

export const RULES = [
  {
    id: 'fusion-squash-seule',
    title: 'Fusion en squash uniquement',
    reason: "Un commit par PR, dont le titre est lu par release-please. Les fusions classiques et rebase mélangent l'historique et contournent le titre vérifié par Constance.",
    expected: { allow_squash_merge: true, allow_merge_commit: false, allow_rebase_merge: false },
    read: (repo) => ({ allow_squash_merge: repo.allow_squash_merge, allow_merge_commit: repo.allow_merge_commit, allow_rebase_merge: repo.allow_rebase_merge }),
    fix: patchSettings({ allow_squash_merge: true, allow_merge_commit: false, allow_rebase_merge: false }),
  },
  {
    id: 'squash-titre-de-la-pr',
    title: 'Squash : titre et description de la PR',
    reason: "Sinon, une PR qui n'a qu'un commit prend le message de ce commit : le titre vérifié par Constance est ignoré et release-please peut se tromper de version.",
    expected: { squash_merge_commit_title: 'PR_TITLE', squash_merge_commit_message: 'PR_BODY' },
    read: (repo) => (repo.squash_merge_commit_title === undefined
      ? undefined
      : { squash_merge_commit_title: repo.squash_merge_commit_title, squash_merge_commit_message: repo.squash_merge_commit_message }),
    fix: patchSettings({ squash_merge_commit_title: 'PR_TITLE', squash_merge_commit_message: 'PR_BODY' }),
  },
  {
    id: 'supprimer-branche-fusionnee',
    title: 'Supprimer la branche après fusion',
    reason: 'Les branches fusionnées s’accumulent et brouillent la liste ; on peut toujours restaurer une branche supprimée depuis la PR.',
    expected: true,
    read: (repo) => repo.delete_branch_on_merge,
    fix: patchSettings({ delete_branch_on_merge: true }),
  },
  {
    id: 'actions-lecture-seule',
    title: 'GitHub Actions : jeton en lecture seule par défaut',
    reason: 'Moindre privilège : chaque workflow demande lui-même les droits dont il a besoin (permissions:). Un workflow piégé ne peut pas écrire partout.',
    expected: 'read',
    read: (repo, extra) => extra.actions && extra.actions.default_workflow_permissions,
    // Safeguard: a workflow without "permissions:" that writes (release-please…) would break.
    blocker: (repo, extra) => (extra.workflowsWithoutPermissions && extra.workflowsWithoutPermissions.length
      ? `workflows sans « permissions: » : ${extra.workflowsWithoutPermissions.join(', ')} (ajoutez-leur leurs droits d'abord)`
      : null),
    fix: putActionsSettings,
  },
  {
    id: 'actions-peut-ouvrir-des-pr',
    title: 'GitHub Actions peut ouvrir des PR',
    reason: "release-please ouvre la PR de version : sans cette autorisation, il échoue (« GitHub Actions is not permitted to create or approve pull requests »).",
    expected: true,
    read: (repo, extra) => extra.actions && extra.actions.can_approve_pull_request_reviews,
    fix: putActionsSettings,
  },
  {
    id: 'alertes-dependabot',
    title: 'Alertes de sécurité Dependabot',
    reason: 'Être prévenue quand une dépendance a une faille connue. Ce sont des alertes, pas des PR automatiques.',
    expected: true,
    read: (repo, extra) => extra.alerts,
    fix: (repo) => [{ method: 'PUT', path: `/repos/${repo.full_name}/vulnerability-alerts` }],
  },
  {
    id: 'detection-secrets',
    title: 'Détection des secrets et blocage au push',
    reason: 'GitHub repère les clés et jetons poussés par erreur, et bloque le push avant qu’ils soient publics. En plus de gitleaks dans Constance.',
    expected: { secret_scanning: 'enabled', secret_scanning_push_protection: 'enabled' },
    read: (repo) => {
      const security = repo.security_and_analysis;
      if (!security || !security.secret_scanning) return undefined; // private repository on a free account: not available
      const pushProtection = security.secret_scanning_push_protection;
      return { secret_scanning: security.secret_scanning.status, secret_scanning_push_protection: pushProtection && pushProtection.status };
    },
    fix: patchSettings({ security_and_analysis: { secret_scanning: { status: 'enabled' }, secret_scanning_push_protection: { status: 'enabled' } } }),
  },
  {
    id: 'analyse-codeql',
    title: 'Analyse de code CodeQL',
    reason: 'GitHub analyse le code à chaque PR et suit les données d’un bout à l’autre : injection SQL, HTML injecté, secrets qui fuient. Ce qu’une recherche de motifs (Constance) ne voit pas. Gratuit pour les dépôts publics, configuré par GitHub, sans fichier à ajouter.',
    expected: 'configured',
    read: (repo, extra) => extra.codeScanning,
    fix: (repo) => [{ method: 'PATCH', path: `/repos/${repo.full_name}/code-scanning/default-setup`, body: { state: 'configured' } }],
  },
  {
    id: 'wiki-desactive',
    title: 'Wiki désactivé',
    reason: 'La documentation vit dans le dépôt (README, docs/), versionnée et relue en PR. Un wiki à côté se périme sans que personne ne le voie. Le désactiver masque ses pages sans les supprimer.',
    expected: false,
    read: (repo) => repo.has_wiki,
    fix: patchSettings({ has_wiki: false }),
  },
];

const sameValue = (left, right) => JSON.stringify(left) === JSON.stringify(right);

/**
 * Checks a repository. `config`: { desactivees: [id…], exceptions: { "<repo>": [id…] } }.
 * Returns [{ rule, status: "ok" | "mismatch" | "unavailable" | "ignored" | "blocked", current }].
 */
export function checkRepository(repo, extra, config = {}) {
  const disabled = new Set(config.desactivees || []);
  const exceptions = new Set((config.exceptions || {})[repo.name] || []);
  return RULES.map((rule) => {
    if (disabled.has(rule.id) || exceptions.has(rule.id)) return { rule, status: 'ignored' };
    const current = rule.read(repo, extra);
    if (current === undefined || current === null) return { rule, status: 'unavailable', current };
    if (sameValue(current, rule.expected)) return { rule, status: 'ok', current };
    const blocker = rule.blocker ? rule.blocker(repo, extra) : null;
    return blocker ? { rule, status: 'blocked', current, blocker } : { rule, status: 'mismatch', current };
  });
}

/** The API calls that fix a repository's mismatches, without duplicates. */
export function fixes(repo, results) {
  const seen = new Set();
  return results
    .filter((result) => result.status === 'mismatch')
    .flatMap((result) => result.rule.fix(repo))
    .filter((call) => {
      const callKey = call.method + call.path + JSON.stringify(call.body || {});
      if (seen.has(callKey)) return false;
      seen.add(callKey);
      return true;
    });
}
