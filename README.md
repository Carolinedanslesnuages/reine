# Reine

Les mêmes réglages GitHub dans tous vos dépôts. Reine vérifie chaque dépôt, explique **pourquoi**
chaque réglage compte, et corrige les écarts quand vous le demandez.

Le nom rend hommage à Nicole-Reine Lepaute (1723-1788), astronome et calculatrice, qui a contribué
au *Traité d'horlogerie* de son mari : des réglages précis, identiques et vérifiés.

## Les règles

| Règle | Pourquoi |
|---|---|
| Fusion en squash uniquement | Un commit par PR, dont le titre est lu par release-please. |
| Squash : titre et description de la PR | Sinon, une PR d'un seul commit garde le message de ce commit : le titre vérifié est ignoré. |
| Supprimer la branche après fusion | Les branches fusionnées s'accumulent ; on peut toujours les restaurer depuis la PR. |
| Actions : jeton en lecture seule par défaut | Moindre privilège : chaque workflow demande les droits dont il a besoin. |
| Actions peut ouvrir des PR | release-please ouvre la PR de version ; sans cela, il échoue. |
| Alertes de sécurité Dependabot | Être prévenue quand une dépendance a une faille connue (alertes, pas de PR automatiques). |
| Détection des secrets et blocage au push | GitHub bloque un jeton poussé par erreur avant qu'il soit public. |
| Analyse de code CodeQL | GitHub suit les données d'un bout à l'autre (injection SQL, HTML injecté, secrets qui fuient). Gratuit pour les dépôts publics, sans fichier à ajouter. |
| Wiki désactivé | La doc vit dans le dépôt, versionnée et relue. Désactiver masque le wiki sans le supprimer. |

`reine regles` affiche le détail.

### Les garde-fous

- **`verifier` ne change jamais rien.** `appliquer` montre la liste des changements et demande
  confirmation.
- **Jeton en lecture seule** : Reine lit d'abord les workflows du dépôt. Si l'un d'eux ne déclare
  pas ses droits (`permissions:`), elle refuse ce changement et dit lequel corriger : sinon,
  release-please et les autres workflows qui écrivent échoueraient.
- Un réglage illisible (par exemple la détection des secrets sur un dépôt privé d'un compte
  gratuit) est « non applicable », pas un écart.
- Après correction, Reine revérifie et affiche le résultat.

## Utilisation

Il faut Node.js 20 ou plus récent, et être connectée avec `gh auth login` (ou `GITHUB_TOKEN`).

```sh
npx github:Carolinedanslesnuages/reine verifier              # tous vos dépôts publics
npx github:Carolinedanslesnuages/reine verifier constance val
npx github:Carolinedanslesnuages/reine appliquer             # confirme, corrige, revérifie
npx github:Carolinedanslesnuages/reine verifier --tous --json
```

```text
✗ constance   alertes-dependabot, wiki-desactive
✓ val         conforme
✗ ancien      supprimer-branche-fusionnee
    ⚠ actions-lecture-seule non corrigeable tel quel : workflows sans « permissions: » : release.yml
```

### Exceptions

Un fichier `reine.json` dans le dossier courant :

```json
{
  "desactivees": ["wiki-desactive"],
  "exceptions": { "mon-site": ["fusion-squash-seule"] }
}
```

## Développer

```sh
npm test    # contre une fausse API GitHub locale : aucun vrai dépôt n'est touché
```

## Licence

[MIT](LICENSE).
