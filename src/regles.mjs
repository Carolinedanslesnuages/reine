/**
 * Les règles de Reine : un réglage GitHub, sa valeur attendue, et POURQUOI.
 * Chaque règle sait se lire sur un dépôt (lire), et se corriger (corriger : appels à l'API).
 * `lire` renvoie la valeur actuelle, ou `undefined` si elle n'est pas disponible (ex. fonction
 * réservée aux dépôts publics sur un compte gratuit) : la règle est alors « non applicable ».
 */
const patch = (champs) => (d) => [{ methode: 'PATCH', chemin: `/repos/${d.full_name}`, corps: champs }];

export const REGLES = [
  {
    id: 'fusion-squash-seule',
    titre: 'Fusion en squash uniquement',
    pourquoi: "Un commit par PR, dont le titre est lu par release-please. Les fusions classiques et rebase mélangent l'historique et contournent le titre vérifié par Constance.",
    attendu: { allow_squash_merge: true, allow_merge_commit: false, allow_rebase_merge: false },
    lire: (d) => ({ allow_squash_merge: d.allow_squash_merge, allow_merge_commit: d.allow_merge_commit, allow_rebase_merge: d.allow_rebase_merge }),
    corriger: patch({ allow_squash_merge: true, allow_merge_commit: false, allow_rebase_merge: false }),
  },
  {
    id: 'squash-titre-de-la-pr',
    titre: 'Squash : titre et description de la PR',
    pourquoi: "Sinon, une PR qui n'a qu'un commit prend le message de ce commit : le titre vérifié par Constance est ignoré et release-please peut se tromper de version.",
    attendu: { squash_merge_commit_title: 'PR_TITLE', squash_merge_commit_message: 'PR_BODY' },
    lire: (d) => (d.squash_merge_commit_title === undefined ? undefined : { squash_merge_commit_title: d.squash_merge_commit_title, squash_merge_commit_message: d.squash_merge_commit_message }),
    corriger: patch({ squash_merge_commit_title: 'PR_TITLE', squash_merge_commit_message: 'PR_BODY' }),
  },
  {
    id: 'supprimer-branche-fusionnee',
    titre: 'Supprimer la branche après fusion',
    pourquoi: 'Les branches fusionnées s’accumulent et brouillent la liste ; on peut toujours restaurer une branche supprimée depuis la PR.',
    attendu: true,
    lire: (d) => d.delete_branch_on_merge,
    corriger: patch({ delete_branch_on_merge: true }),
  },
  {
    id: 'actions-lecture-seule',
    titre: 'GitHub Actions : jeton en lecture seule par défaut',
    pourquoi: 'Moindre privilège : chaque workflow demande lui-même les droits dont il a besoin (permissions:). Un workflow piégé ne peut pas écrire partout.',
    attendu: 'read',
    lire: (d, x) => x.actions && x.actions.default_workflow_permissions,
    // Garde-fou : un workflow sans « permissions: » qui écrit (release-please…) casserait.
    bloquant: (d, x) => (x.workflowsSansPermissions && x.workflowsSansPermissions.length ? `workflows sans « permissions: » : ${x.workflowsSansPermissions.join(', ')} (ajoutez-leur leurs droits d'abord)` : null),
    corriger: (d) => [{ methode: 'PUT', chemin: `/repos/${d.full_name}/actions/permissions/workflow`, corps: { default_workflow_permissions: 'read', can_approve_pull_request_reviews: true } }],
  },
  {
    id: 'actions-peut-ouvrir-des-pr',
    titre: 'GitHub Actions peut ouvrir des PR',
    pourquoi: "release-please ouvre la PR de version : sans cette autorisation, il échoue (« GitHub Actions is not permitted to create or approve pull requests »).",
    attendu: true,
    lire: (d, x) => x.actions && x.actions.can_approve_pull_request_reviews,
    corriger: (d) => [{ methode: 'PUT', chemin: `/repos/${d.full_name}/actions/permissions/workflow`, corps: { default_workflow_permissions: 'read', can_approve_pull_request_reviews: true } }],
  },
  {
    id: 'alertes-dependabot',
    titre: 'Alertes de sécurité Dependabot',
    pourquoi: 'Être prévenue quand une dépendance a une faille connue. Ce sont des alertes, pas des PR automatiques.',
    attendu: true,
    lire: (d, x) => x.alertes,
    corriger: (d) => [{ methode: 'PUT', chemin: `/repos/${d.full_name}/vulnerability-alerts` }],
  },
  {
    id: 'detection-secrets',
    titre: 'Détection des secrets et blocage au push',
    pourquoi: 'GitHub repère les clés et jetons poussés par erreur, et bloque le push avant qu’ils soient publics. En plus de gitleaks dans Constance.',
    attendu: { secret_scanning: 'enabled', secret_scanning_push_protection: 'enabled' },
    lire: (d) => {
      const s = d.security_and_analysis;
      if (!s || !s.secret_scanning) return undefined; // dépôt privé sur un compte gratuit : non disponible
      return { secret_scanning: s.secret_scanning.status, secret_scanning_push_protection: s.secret_scanning_push_protection && s.secret_scanning_push_protection.status };
    },
    corriger: patch({ security_and_analysis: { secret_scanning: { status: 'enabled' }, secret_scanning_push_protection: { status: 'enabled' } } }),
  },
  {
    id: 'wiki-desactive',
    titre: 'Wiki désactivé',
    pourquoi: 'La documentation vit dans le dépôt (README, docs/), versionnée et relue en PR. Un wiki à côté se périme sans que personne ne le voie. Le désactiver masque ses pages sans les supprimer.',
    attendu: false,
    lire: (d) => d.has_wiki,
    corriger: patch({ has_wiki: false }),
  },
];

const egal = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Vérifie un dépôt. `config` : { desactivees: [id…], exceptions: { "<dépôt>": [id…] } }.
 * Renvoie [{ regle, statut: "ok" | "ecart" | "na" | "ignoree", actuel }].
 */
export function verifierDepot(depot, extra, config = {}) {
  const desactivees = new Set(config.desactivees || []);
  const exceptions = new Set((config.exceptions || {})[depot.name] || []);
  return REGLES.map((r) => {
    if (desactivees.has(r.id) || exceptions.has(r.id)) return { regle: r, statut: 'ignoree' };
    const actuel = r.lire(depot, extra);
    if (actuel === undefined || actuel === null) return { regle: r, statut: 'na', actuel };
    if (egal(actuel, r.attendu)) return { regle: r, statut: 'ok', actuel };
    const blocage = r.bloquant ? r.bloquant(depot, extra) : null;
    return blocage ? { regle: r, statut: 'bloquee', actuel, blocage } : { regle: r, statut: 'ecart', actuel };
  });
}

/** Les appels à faire pour corriger les écarts d'un dépôt (dédoublonnés). */
export function corrections(depot, resultats) {
  const vus = new Set();
  return resultats
    .filter((x) => x.statut === 'ecart')
    .flatMap((x) => x.regle.corriger(depot))
    .filter((a) => {
      const cle = a.methode + a.chemin + JSON.stringify(a.corps || {});
      if (vus.has(cle)) return false;
      vus.add(cle);
      return true;
    });
}
