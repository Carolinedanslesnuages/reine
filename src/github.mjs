/** Accès à l'API GitHub avec votre jeton (GITHUB_TOKEN, GH_TOKEN, ou celui de « gh »). */
import { execFileSync } from 'node:child_process';

export function jeton() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
  try {
    return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    throw new Error('Aucun jeton GitHub : connectez-vous avec « gh auth login », ou définissez GITHUB_TOKEN.');
  }
}

export function client(token = jeton(), base = process.env.REINE_API_BASE || 'https://api.github.com') {
  async function appel(methode, chemin, corps) {
    const r = await fetch(base + chemin, {
      method: methode,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'reine', ...(corps ? { 'Content-Type': 'application/json' } : {}) },
      body: corps ? JSON.stringify(corps) : undefined,
    });
    if (r.status === 204) return { statut: 204, donnees: null };
    const texte = await r.text();
    const donnees = texte ? JSON.parse(texte) : null;
    return { statut: r.status, donnees };
  }
  return {
    appel,
    async moi() {
      const r = await appel('GET', '/user');
      if (r.statut !== 200) throw new Error(`Jeton refusé par GitHub (${r.statut}).`);
      return r.donnees.login;
    },
    async depots(compte) {
      const tous = [];
      for (let page = 1; ; page++) {
        const r = await appel('GET', `/user/repos?per_page=100&page=${page}&affiliation=owner`);
        if (r.statut !== 200) throw new Error(`Liste des dépôts impossible (${r.statut}).`);
        tous.push(...r.donnees);
        if (r.donnees.length < 100) break;
      }
      return tous.filter((d) => d.owner.login.toLowerCase() === compte.toLowerCase());
    },
    async depot(nomComplet) {
      const r = await appel('GET', `/repos/${nomComplet}`);
      if (r.statut !== 200) throw new Error(`Dépôt introuvable ou inaccessible : ${nomComplet} (${r.statut}).`);
      return r.donnees;
    },
    /** Réglages qui ne sont pas dans la fiche du dépôt. */
    async extra(nomComplet) {
      const [a, v] = await Promise.all([appel('GET', `/repos/${nomComplet}/actions/permissions/workflow`), appel('GET', `/repos/${nomComplet}/vulnerability-alerts`)]);
      return { actions: a.statut === 200 ? a.donnees : undefined, alertes: v.statut === 204 ? true : v.statut === 404 ? false : undefined, workflowsSansPermissions: await this.workflowsSansPermissions(nomComplet) };
    },
    /** Workflows qui ne déclarent aucun « permissions: » (ni global, ni par job). */
    async workflowsSansPermissions(nomComplet) {
      const l = await appel('GET', `/repos/${nomComplet}/contents/.github/workflows`);
      if (l.statut !== 200 || !Array.isArray(l.donnees)) return [];
      const sans = [];
      for (const f of l.donnees.filter((x) => /\.ya?ml$/.test(x.name))) {
        const c = await appel('GET', `/repos/${nomComplet}/contents/.github/workflows/${encodeURIComponent(f.name)}`);
        const texte = c.donnees && c.donnees.content ? Buffer.from(c.donnees.content, 'base64').toString('utf8') : '';
        if (!/^\s*permissions\s*:/m.test(texte)) sans.push(f.name);
      }
      return sans;
    },
  };
}
