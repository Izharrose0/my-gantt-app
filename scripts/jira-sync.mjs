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

// customfield_10014 = Epic Link nei classic project di Jira (link
// custom Story -> Epic). Nei next-gen project si usa fields.parent.key
// che e' gia' supportato.
const EPIC_LINK_FIELD = 'customfield_10014';

// Risolto a runtime via /rest/api/3/field (auto-detection). Inizializzato
// con il valore env (se settato) o il default.
let resolvedStartDateField = startDateField;

function jiraFields() {
  return [
    'summary', 'status', 'issuetype', 'parent', 'assignee',
    'duedate', 'created', 'timetracking', 'priority', 'labels',
    resolvedStartDateField, EPIC_LINK_FIELD
  ];
}

async function jiraRequest(path, { method = 'GET', body } = {}) {
  const auth = Buffer.from(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`).toString('base64');
  const init = {
    method,
    headers: {
      Authorization: `Basic ${auth}`,
      Accept: 'application/json'
    }
  };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const resp = await fetch(`https://${JIRA_DOMAIN}${path}`, init);
  if (resp.status === 401 || resp.status === 403) {
    abort('Credenziali Jira non valide o permessi insufficienti (' + resp.status + ').');
  }
  if (resp.status === 404) {
    abort('Endpoint Jira non trovato (404): controlla domain e project key.');
  }
  if (resp.status === 410) {
    const text = await resp.text().catch(() => '');
    abort(`Jira API 410 Gone: ${text.slice(0, 300)}`);
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    abort(`Jira ha risposto ${resp.status}: ${text.slice(0, 300)}`);
  }
  return resp.json();
}

// Trova il customfield che rappresenta la "Start date" interrogando i
// metadati Jira. Cerca per nome ("Start date" / "Data inizio") e fallisce
// in modo silenzioso lasciando il default.
async function autoDetectStartDateField() {
  // Se l'utente ha forzato un campo via env var, rispettalo
  if (process.env.JIRA_START_DATE_FIELD) {
    console.log(`  Start date field: ${resolvedStartDateField} (forzato da env)`);
    return;
  }
  try {
    const fields = await jiraRequest('/rest/api/3/field');
    const candidates = [
      'Start date',
      'Start Date',
      'Data inizio',
      'Data di inizio',
      'startDate',
      'Target start'
    ].map(s => s.toLowerCase());
    const match = fields.find(f =>
      candidates.includes((f.name || '').toLowerCase())
      && f.id && f.id.startsWith('customfield_')
    );
    if (match) {
      resolvedStartDateField = match.id;
      console.log(`  Start date field: ${match.id} ("${match.name}") — auto-rilevato`);
    } else {
      console.log(`  ⚠ Nessun campo "Start date" trovato nei metadati Jira. Uso default: ${resolvedStartDateField}`);
      console.log(`    Custom field disponibili in questa istanza:`);
      fields
        .filter(f => f.id?.startsWith('customfield_'))
        .slice(0, 30)
        .forEach(f => console.log(`      ${f.id}  →  "${f.name}"`));
    }
  } catch (e) {
    console.log(`  ⚠ Auto-detect Start date fallito (${e.message}). Uso: ${resolvedStartDateField}`);
  }
}

// Usa il nuovo endpoint /rest/api/3/search/jql (l'API legacy /search è
// stata rimossa da Atlassian — CHANGE-2046). Paginazione a cursore con
// nextPageToken invece di startAt/total.
async function fetchAllIssues() {
  const PAGE_SIZE = 100;
  const jql = `project = "${projectKey}" ORDER BY created ASC`;
  let nextPageToken = undefined;
  let pageNum = 0;
  const out = [];
  while (true) {
    const body = {
      jql,
      fields: jiraFields(),
      maxResults: PAGE_SIZE
    };
    if (nextPageToken) body.nextPageToken = nextPageToken;

    const page = await jiraRequest('/rest/api/3/search/jql', { method: 'POST', body });
    const arr = page.issues || [];
    out.push(...arr);
    pageNum++;
    console.log(`  pagina ${pageNum}: +${arr.length} (cumulato: ${out.length})`);
    nextPageToken = page.nextPageToken || null;
    if (page.isLast || !nextPageToken || arr.length === 0) break;
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

// Aggiunge N giorni di calendario a una data ISO (YYYY-MM-DD).
function aggiungiGiorni(isoDate, n) {
  if (!isoDate) return isoDate;
  const d = new Date(isoDate + 'T12:00:00Z'); // mezzogiorno UTC: evita DST/off-by-one
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Auto-correzione date in base alle ore stimate.
// Regola: 8h/giorno calendario. needed = ceil(stimaOre / 8).
//   - Se manca solo l'inizio → inizio = fine - needed
//   - Se manca solo la fine  → fine  = inizio + needed
//   - Se entrambi presenti   → fine = max(fine, inizio + needed)
//                              (l'inizio non viene mai modificato se gia' valido)
//   - Se ore = 0 o entrambe le date assenti → date lasciate come sono
function autoCorreggiDate(inizio, fine, stimaOre) {
  const ore = Math.max(0, Number(stimaOre) || 0);
  const needed = ore > 0 ? Math.ceil(ore / 8) : 0;
  let i = inizio || null;
  let f = fine || null;

  if (needed === 0) {
    // Senza ore non possiamo dedurre nulla. Se manca una delle due la
    // settiamo uguale all'altra per coerenza minima del Gantt.
    if (i && !f) f = i;
    if (!i && f) i = f;
    return { inizio: i, fine: f };
  }

  if (i && !f) {
    f = aggiungiGiorni(i, needed);
  } else if (!i && f) {
    i = aggiungiGiorni(f, -needed);
  } else if (i && f) {
    const minF = aggiungiGiorni(i, needed);
    if (f < minF) f = minF;
  }
  return { inizio: i, fine: f };
}

function buildTask(issue, existing, nextOrdine) {
  const f = issue.fields || {};
  const isEpic = f.issuetype?.name === 'Epic';
  const tipo = isEpic ? 'epica' : 'task';
  const statoNuovo = mapStato(issue);
  const orig = Number(f.timetracking?.originalEstimateSeconds || 0);
  const stimaOre = arrotondaOreA05(orig / 3600);
  // Date: per le epiche lasciamo vuote (frontend le calcola dai figli).
  // Per i task: start = Start date Jira (campo auto-rilevato); end = Due date.
  // NON usiamo piu' f.created come fallback: e' fuorviante perche' la data
  // creazione spesso non coincide con la start date pianificata.
  let start = null;
  let due = null;
  if (!isEpic) {
    const startRaw = f[resolvedStartDateField];
    // Il campo puo' essere una stringa "2026-05-15" o un timestamp ISO completo;
    // teniamo solo la parte data.
    start = typeof startRaw === 'string' ? startRaw.slice(0, 10) : null;
    due   = f.duedate || null;
    const corrette = autoCorreggiDate(start, due, stimaOre);
    start = corrette.inizio;
    due   = corrette.fine;
  }

  // Campi MY-GANTT-only mai sovrascritti dal sync
  const preserved = existing ? {
    completamento: existing.completamento ?? 0,
    importanza:    existing.importanza ?? 3,
    urgenza:       existing.urgenza ?? 3,
    dipendenze:    Array.isArray(existing.dipendenze) ? existing.dipendenze.slice() : [],
    nascosta:      existing.nascosta === true
  } : {
    completamento: statoNuovo === 'done' ? 100 : 0,
    importanza: 3,
    urgenza: 3,
    dipendenze: [],
    nascosta: false
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

// Normalizza un nome per il match: minuscolo, niente spazi multipli,
// niente spazi ai bordi.
function normNome(s) {
  return (s || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function resolveAssignee(issue, persone, personeNuove) {
  const a = issue.fields?.assignee;
  if (!a) return [];

  const accountId = a.accountId || null;
  const email     = (a.emailAddress || '').trim().toLowerCase();
  const displayN  = normNome(a.displayName);

  const all = [...persone, ...personeNuove];

  // Match in ordine di affidabilità:
  //   1. jiraAccountId (la chiave canonica di Jira, sempre presente)
  //   2. email (case-insensitive) — spesso null su Jira Cloud per privacy
  //   3. displayName (case-insensitive) — fallback quando l'email manca
  let p = accountId
    ? all.find(x => x.jiraAccountId && x.jiraAccountId === accountId)
    : null;
  if (!p && email) {
    p = all.find(x => (x.email || '').toLowerCase() === email);
  }
  if (!p && displayN) {
    p = all.find(x => normNome(x.nome) === displayN);
  }

  if (!p) {
    // Nuova persona: auto-create con i metadati Jira
    p = {
      id: generaId(),
      nome: a.displayName || email.split('@')[0] || 'Nuovo',
      ruolo: 'Da Jira',
      fte: 1.0,
      colore: PALETTE[(persone.length + personeNuove.length) % PALETTE.length],
      costoOrario: 0,
      ferie: [],
      email: a.emailAddress || null,
      jiraAccountId: accountId
    };
    personeNuove.push(p);
  } else {
    // Aggiorna in-place i metadati Jira sulla persona esistente
    // (cosi' i prossimi sync matchano per accountId, piu' robusto del nome)
    if (!p.jiraAccountId && accountId) p.jiraAccountId = accountId;
    if (!p.email && a.emailAddress)    p.email = a.emailAddress;
  }
  return [{ personaId: p.id, effort: 100 }];
}

// ===== Run =====

async function main() {
  console.log(`▶ Sync Jira → Firestore`);
  console.log(`  Domain: ${JIRA_DOMAIN}`);
  console.log(`  Project: ${projectKey}`);

  console.log('▶ Rilevo campo Start date...');
  await autoDetectStartDateField();

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

  // 2nd pass: risolvi parent. In ordine:
  //   1. fields.parent.key (next-gen, sub-task->parent, Story->Epic moderno)
  //   2. fields[customfield_10014] (Epic Link classico: Story->Epic)
  let orphans = 0;
  for (const issue of issues) {
    const direct = issue.fields?.parent?.key;
    const epicLink = issue.fields?.[EPIC_LINK_FIELD] || null;
    const parentKey = direct || epicLink;
    if (!parentKey) continue;
    if (jiraKeyToTask.has(parentKey)) {
      jiraKeyToTask.get(issue.key).parentId = jiraKeyToTask.get(parentKey).id;
    } else {
      orphans++;
    }
  }
  if (orphans > 0) {
    console.log(`  ⚠ ${orphans} issue hanno un parent fuori dal progetto importato (resteranno top-level)`);
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
