/**
 * Sync da Jira Cloud al Firestore di MY-GANTT.
 * Eseguito dal workflow GitHub Actions "jira-sync.yml".
 *
 * Env richiesti (passati dai GitHub Secrets):
 *   JIRA_DOMAIN              es. "mioteam.atlassian.net"
 *   JIRA_EMAIL               email del proprio account Atlassian
 *   JIRA_API_TOKEN           token creato su id.atlassian.com/manage-profile/security/api-tokens
 *   JIRA_PROJECT_KEY         es. "PROJ"
 *   JIRA_START_DATE_FIELD    opzionale, default "customfield_10015"
 *   FIREBASE_SERVICE_ACCOUNT JSON intero della service account Firebase
 *
 * Opzionali (dall'input del workflow_dispatch):
 *   JIRA_PROJECT_KEY_OVERRIDE  per override on-the-fly
 */

import admin from 'firebase-admin';

const {
  JIRA_DOMAIN,
  JIRA_EMAIL,
  JIRA_API_TOKEN,
  JIRA_PROJECT_KEY,
  JIRA_PROJECT_KEY_OVERRIDE,
  JIRA_START_DATE_FIELD,
  FIREBASE_SERVICE_ACCOUNT
} = process.env;

const projectKey = (JIRA_PROJECT_KEY_OVERRIDE || JIRA_PROJECT_KEY || '').trim();
const startDateField = (JIRA_START_DATE_FIELD || 'customfield_10015').trim();

function abort(msg) {
  console.error('❌', msg);
  process.exit(1);
}

if (!JIRA_DOMAIN)             abort('Manca JIRA_DOMAIN (es. mioteam.atlassian.net)');
if (!JIRA_EMAIL)              abort('Manca JIRA_EMAIL');
if (!JIRA_API_TOKEN)          abort('Manca JIRA_API_TOKEN');
if (!projectKey)              abort('Manca JIRA_PROJECT_KEY');
if (!FIREBASE_SERVICE_ACCOUNT) abort('Manca FIREBASE_SERVICE_ACCOUNT');

const PALETTE = [
  '#2563eb','#16a34a','#dc2626','#9333ea','#ea580c',
  '#0891b2','#db2777','#65a30d','#b45309','#0f766e'
];

function generaId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// ===== Init Firebase Admin =====
let serviceAccount;
try {
  serviceAccount = JSON.parse(FIREBASE_SERVICE_ACCOUNT);
} catch (e) {
  abort('FIREBASE_SERVICE_ACCOUNT non è JSON valido: ' + e.message);
}
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();
const docRef = db.collection('workspaces').doc('main');

// ===== Fetch da Jira con paginazione =====

const JIRA_FIELDS = [
  'summary', 'status', 'issuetype', 'parent', 'assignee',
  'duedate', 'created', 'timetracking', 'priority', 'labels',
  startDateField
].join(',');

async function jiraGet(path) {
  const auth = Buffer.from(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`).toString('base64');
  const resp = await fetch(`https://${JIRA_DOMAIN}${path}`, {
    headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' }
  });
  if (resp.status === 401 || resp.status === 403) {
    abort('Credenziali Jira non valide o permessi insufficienti (' + resp.status + ').');
  }
  if (resp.status === 404) {
    abort('Endpoint Jira non trovato (404): controlla domain e project key.');
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    abort(`Jira ha risposto ${resp.status}: ${text.slice(0, 300)}`);
  }
  return resp.json();
}

async function fetchAllIssues() {
  const PAGE_SIZE = 100;
  const jql = encodeURIComponent(`project = "${projectKey}" ORDER BY created ASC`);
  let startAt = 0;
  let total = Infinity;
  const out = [];
  while (startAt < total) {
    const page = await jiraGet(
      `/rest/api/3/search?jql=${jql}&fields=${JIRA_FIELDS}&maxResults=${PAGE_SIZE}&startAt=${startAt}`
    );
    total = Number(page.total) || 0;
    const arr = page.issues || [];
    out.push(...arr);
    console.log(`  pagina startAt=${startAt}: +${arr.length} (totale Jira: ${total})`);
    startAt += arr.length;
    if (arr.length === 0) break;
  }
  return out;
}

// ===== Mapping Jira issue → task MY-GANTT =====

function mapStato(issue) {
  const cat = issue.fields?.status?.statusCategory?.key;
  if (cat === 'done') return 'done';
  if (cat === 'indeterminate') return 'in-progress';
  // 'blocked' non è una status category standard di Jira; gli utenti spesso
  // creano uno status "Blocked" custom dentro le category. Match per nome.
  const name = (issue.fields?.status?.name || '').toLowerCase();
  if (name.includes('block')) return 'blocked';
  return 'todo';
}

function arrotondaOreA05(ore) {
  return Math.round(ore * 2) / 2;
}

function buildTask(issue, existing, nextOrdine) {
  const f = issue.fields || {};
  const isEpic = f.issuetype?.name === 'Epic';
  const tipo = isEpic ? 'epica' : 'task';
  const statoNuovo = mapStato(issue);
  const orig = Number(f.timetracking?.originalEstimateSeconds || 0);
  const stimaOre = arrotondaOreA05(orig / 3600);
  // Date: per le epiche lasciamo vuote (frontend le calcola dai figli)
  const start = isEpic ? null : (f[startDateField] || (f.created || '').slice(0, 10) || null);
  const due   = isEpic ? null : (f.duedate || start || null);

  // Campi MY-GANTT-only mai sovrascritti dal sync
  const preserved = existing ? {
    completamento: existing.completamento ?? 0,
    importanza:    existing.importanza ?? 3,
    urgenza:       existing.urgenza ?? 3,
    dipendenze:    Array.isArray(existing.dipendenze) ? existing.dipendenze.slice() : []
  } : {
    completamento: statoNuovo === 'done' ? 100 : 0,
    importanza: 3,
    urgenza: 3,
    dipendenze: []
  };

  return {
    id: existing?.id || generaId(),
    nome: f.summary || existing?.nome || '(senza titolo)',
    inizio: start,
    fine: due,
    stato: statoNuovo,
    stimaOre: stimaOre || (existing?.stimaOre || 0),
    assegnazioni: [],   // riempito dopo (resolveAssignee)
    parentId: null,     // risolto dopo (2nd pass)
    tipo,
    ordine: existing?.ordine ?? nextOrdine,
    ...preserved,
    jiraKey: issue.key,
    jiraUrl: `https://${JIRA_DOMAIN}/browse/${issue.key}`,
    jiraUpdated: new Date().toISOString()
  };
}

function resolveAssignee(issue, persone, personeNuove) {
  const a = issue.fields?.assignee;
  if (!a || !a.emailAddress) return [];
  // Match per email o accountId
  let p = [...persone, ...personeNuove].find(x =>
    (x.email && a.emailAddress && x.email.toLowerCase() === a.emailAddress.toLowerCase()) ||
    (x.jiraAccountId && a.accountId && x.jiraAccountId === a.accountId)
  );
  if (!p) {
    p = {
      id: generaId(),
      nome: a.displayName || (a.emailAddress || '').split('@')[0] || 'Nuovo',
      ruolo: 'Da Jira',
      fte: 1.0,
      colore: PALETTE[(persone.length + personeNuove.length) % PALETTE.length],
      costoOrario: 0,
      ferie: [],
      email: a.emailAddress,
      jiraAccountId: a.accountId || null
    };
    personeNuove.push(p);
  } else if (!p.email && a.emailAddress) {
    // Aggiorna l'email se mancante
    p.email = a.emailAddress;
  }
  return [{ personaId: p.id, effort: 100 }];
}

// ===== Run =====

async function main() {
  console.log(`▶ Sync Jira → Firestore`);
  console.log(`  Domain: ${JIRA_DOMAIN}`);
  console.log(`  Project: ${projectKey}`);
  console.log(`  Start-date field: ${startDateField}`);

  console.log('▶ Fetch issue da Jira...');
  const issues = await fetchAllIssues();
  console.log(`✓ ${issues.length} issue ricevute`);

  console.log('▶ Lettura stato Firestore...');
  const snap = await docRef.get();
  const stato = snap.exists ? snap.data() : { persone: [], task: [], festivita: [] };
  if (!Array.isArray(stato.task))    stato.task = [];
  if (!Array.isArray(stato.persone)) stato.persone = [];

  const byJiraKey = new Map(stato.task.filter(t => t.jiraKey).map(t => [t.jiraKey, t]));
  const maxOrdine = stato.task.reduce((m, t) => Math.max(m, Number(t.ordine) || 0), 0);
  let nextOrdine = maxOrdine + 1;
  const personeNuove = [];

  // 1st pass: build task + assegnazioni
  const jiraKeyToTask = new Map();
  let creati = 0, aggiornati = 0;
  for (const issue of issues) {
    const existing = byJiraKey.get(issue.key);
    const task = buildTask(issue, existing, nextOrdine);
    if (!existing) { creati++; nextOrdine++; } else { aggiornati++; }
    task.assegnazioni = resolveAssignee(issue, stato.persone, personeNuove);
    jiraKeyToTask.set(issue.key, task);
  }

  // 2nd pass: parent.key → parentId
  for (const issue of issues) {
    const pk = issue.fields?.parent?.key;
    if (pk && jiraKeyToTask.has(pk)) {
      jiraKeyToTask.get(issue.key).parentId = jiraKeyToTask.get(pk).id;
    }
  }

  // Merge: task manuali (senza jiraKey) preservati intoccati, jira-tasks ricostruiti
  const taskManuali = stato.task.filter(t => !t.jiraKey);
  const taskJira = [...jiraKeyToTask.values()];
  stato.task = [...taskManuali, ...taskJira];
  stato.persone = [...stato.persone, ...personeNuove];

  console.log(`▶ Scrittura su Firestore: ${stato.task.length} task totali (${taskManuali.length} manuali + ${taskJira.length} da Jira)`);
  await docRef.set(stato);

  console.log('');
  console.log(`✅ Sync completato`);
  console.log(`   ${creati} task nuovi`);
  console.log(`   ${aggiornati} task aggiornati`);
  console.log(`   ${personeNuove.length} persone auto-create`);
}

main().catch(err => {
  console.error('💥 Sync fallito:', err);
  process.exit(1);
});
