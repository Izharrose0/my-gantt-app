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

// PUT autenticato su Jira: ritorna null su 204 (no content). Diversamente
// da jiraRequest, NON aborta lo script su errore — il chiamante gestisce.
async function jiraPut(path, body) {
  const auth = Buffer.from(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`).toString('base64');
  const resp = await fetch(`https://${JIRA_DOMAIN}${path}`, {
    method: 'PUT',
    headers: {
      Authorization: `Basic ${auth}`,
      Accept: 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`PUT ${path} → ${resp.status}: ${text.slice(0, 200)}`);
  }
  if (resp.status === 204) return null;
  return resp.json().catch(() => null);
}

// Pusha verso Jira SOLO le date (inizio/fine) modificate manualmente in
// MY-GANTT dopo l'ultimo sync. Confronta t.inizio vs t.jiraSyncedInizio.
// Solo task con jiraKey + tipo='task' + valori validi. Errori per singolo
// task vengono loggati ma non interrompono il sync.
async function pushModificheDate(stato) {
  const candidati = stato.task.filter(t =>
    t.jiraKey && t.tipo === 'task' &&
    ((t.inizio && t.inizio !== t.jiraSyncedInizio) ||
     (t.fine   && t.fine   !== t.jiraSyncedFine))
  );
  if (candidati.length === 0) {
    console.log('  Nessuna modifica locale di date da spingere su Jira.');
    return { ok: 0, ko: 0 };
  }
  console.log(`▶ Push date verso Jira: ${candidati.length} task modificati in MY-GANTT...`);
  let ok = 0, ko = 0;
  for (const t of candidati) {
    const fields = {};
    if (t.inizio) fields[resolvedStartDateField] = t.inizio;
    if (t.fine)   fields.duedate = t.fine;
    try {
      await jiraPut(`/rest/api/3/issue/${encodeURIComponent(t.jiraKey)}`, { fields });
      console.log(`    ✓ ${t.jiraKey}: inizio ${t.jiraSyncedInizio || '∅'}→${t.inizio || '∅'}, fine ${t.jiraSyncedFine || '∅'}→${t.fine || '∅'}`);
      ok++;
    } catch (e) {
      console.log(`    ✗ ${t.jiraKey}: ${e.message}`);
      ko++;
    }
  }
  console.log(`  Push completato: ${ok} OK, ${ko} errori`);
  return { ok, ko };
}

// Trova il customfield che rappresenta la "Start date" interrogando i
// metadati Jira. Strategia:
//   1. Variabile d'ambiente JIRA_START_DATE_FIELD (override esplicito)
//   2. Match per schema.custom (più affidabile, ignora i nomi localizzati)
//   3. Match per nome (case-insensitive, varianti italiane/inglesi)
async function autoDetectStartDateField() {
  if (process.env.JIRA_START_DATE_FIELD) {
    console.log(`  Start date field: ${resolvedStartDateField} (forzato da env)`);
    return;
  }
  try {
    const fields = await jiraRequest('/rest/api/3/field');

    // Match preferito: schema.custom (la "Start date" di Jira Cloud Software
    // è jpo-custom-field-baseline-start, quella legacy è "datepicker" + nome)
    const schemaSubstr = [
      'jpo-custom-field-baseline-start',
      'baseline-start',
      'start-date'
    ];

    const nameCandidates = [
      'start date', 'start_date', 'startdate',
      'data inizio', 'data di inizio', 'inizio',
      'inizio pianificato', 'target start'
    ];

    let match = fields.find(f => {
      if (!f.id?.startsWith('customfield_')) return false;
      const sc = (f.schema?.custom || '').toLowerCase();
      return schemaSubstr.some(s => sc.includes(s));
    });

    if (!match) {
      match = fields.find(f =>
        f.id?.startsWith('customfield_')
        && nameCandidates.includes((f.name || '').toLowerCase())
      );
    }

    if (match) {
      resolvedStartDateField = match.id;
      console.log(`  Start date field: ${match.id} ("${match.name}") — auto-rilevato`);
    } else {
      console.log(`  ⚠ Nessun campo Start date trovato. Uso default: ${resolvedStartDateField}`);
      console.log(`    Custom field con "date" o "inizio" nel nome (per scegliere manualmente):`);
      fields
        .filter(f => f.id?.startsWith('customfield_'))
        .filter(f => {
          const n = (f.name || '').toLowerCase();
          return n.includes('date') || n.includes('inizio') || n.includes('start');
        })
        .forEach(f => console.log(`      ${f.id}  →  "${f.name}"  (schema: ${f.schema?.custom || 'n/a'})`));
      console.log(`    Per forzare manualmente, setta il secret JIRA_START_DATE_FIELD a uno dei sopra.`);
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

// Normalizza le date di un task: usa quelle di Jira tal quali (Start date e
// Due date). Unico aggiustamento: se UNA delle due manca, copiamo l'altra
// così il task viene comunque renderizzato sul Gantt come barra di 1 giorno.
// Nessuna estensione/spostamento basato sulle ore stimate.
function normalizzaDate(inizio, fine) {
  let i = inizio || null;
  let f = fine || null;
  if (i && !f) f = i;
  if (!i && f) i = f;
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
  // Per i task: Start date e Due date da Jira tal quali. Nessuna correzione
  // basata sulle ore stimate — l'utente si fida del piano in Jira.
  let start = null;
  let due = null;
  if (!isEpic) {
    const startRaw = f[resolvedStartDateField];
    start = typeof startRaw === 'string' ? startRaw.slice(0, 10) : null;
    due   = f.duedate || null;
    const norm = normalizzaDate(start, due);
    start = norm.inizio;
    due   = norm.fine;
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
    jiraUpdated: new Date().toISOString(),
    // Snapshot per detection dei delta manuali al prossimo sync
    jiraSyncedInizio: start,
    jiraSyncedFine:   due
  };
}

// Normalizza un nome per il match: minuscolo, niente spazi multipli,
// niente spazi ai bordi.
function normNome(s) {
  return (s || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

// Unisce l'assegnatario Jira con le assegnazioni esistenti in MY-GANTT.
// Regole:
//   - Se la task non aveva nessuna assegnazione → usa quella di Jira tal quale
//   - Se l'assegnatario Jira è già presente nelle esistenti → conserva tutto
//     intatto (anche l'effort scelto manualmente dall'utente: MY-GANTT vince)
//   - Se l'assegnatario Jira NON è ancora presente → lo aggiungiamo in coda
//     senza toccare gli effort esistenti (effort 100 di default, l'utente
//     può aggiustare in MY-GANTT)
//   - Se non c'è assegnatario su Jira → conserviamo le assegnazioni manuali
function mergeAssegnazioni(daJira, esistenti) {
  const ex = Array.isArray(esistenti) ? esistenti.filter(a => a && a.personaId) : [];
  const jr = Array.isArray(daJira)    ? daJira.filter(a => a && a.personaId)    : [];

  if (ex.length === 0) return jr.map(a => ({ ...a }));
  if (jr.length === 0) return ex.map(a => ({ ...a }));

  const jiraPersonaId = jr[0].personaId;
  const hasJira = ex.some(a => a.personaId === jiraPersonaId);
  if (hasJira) return ex.map(a => ({ ...a }));

  // Aggiunge l'assegnatario Jira in coda (effort 100). L'utente può
  // riequilibrare manualmente; i suoi extra restano intatti.
  return [...ex.map(a => ({ ...a })), { personaId: jiraPersonaId, effort: 100 }];
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

  // Step 1: leggi lo stato corrente da Firestore. Serve per detection dei
  // delta locali (date modificate in MY-GANTT che vanno re-pushate su Jira).
  console.log('▶ Lettura stato Firestore (pre-push)...');
  const snapPre = await docRef.get();
  const statoPre = snapPre.exists ? snapPre.data() : null;

  // Step 2: pusha le modifiche locali di start/end verso Jira (solo dei
  // task che hanno t.inizio/t.fine diversi dallo snapshot jiraSyncedX).
  if (statoPre && Array.isArray(statoPre.task)) {
    await pushModificheDate(statoPre);
  }

  // Step 3: fetch fresco da Jira (ora include eventuali nostre modifiche).
  console.log('▶ Fetch issue da Jira...');
  const issues = await fetchAllIssues();
  console.log(`✓ ${issues.length} issue ricevute`);

  // Diagnostica delle date.
  // Conteggio: quanti task non-Epic hanno start/due popolati?
  const nonEpics = issues.filter(it => it.fields?.issuetype?.name !== 'Epic');
  const conStart = nonEpics.filter(it => it.fields?.[resolvedStartDateField]).length;
  const conDue   = nonEpics.filter(it => it.fields?.duedate).length;
  console.log(`▶ Diagnostica date (campo Start = ${resolvedStartDateField}):`);
  console.log(`    Task non-Epic totali: ${nonEpics.length}`);
  console.log(`    con Start date popolata: ${conStart} / ${nonEpics.length}`);
  console.log(`    con Due date popolata:   ${conDue} / ${nonEpics.length}`);

  // Sample dei 5 più recenti (in fondo all'array, fetch è ORDER BY created ASC)
  const recenti = nonEpics.slice(-5);
  if (recenti.length) {
    console.log(`    Ultimi 5 task non-Epic creati (per debug):`);
    recenti.forEach(it => {
      const f = it.fields || {};
      const sRaw = f[resolvedStartDateField];
      console.log(`      ${it.key.padEnd(12)} start=${JSON.stringify(sRaw) || 'null'}  due=${JSON.stringify(f.duedate) || 'null'}`);
    });
  }
  // Se Start risulta sempre null ma esistono Due date popolate, scarica
  // l'ultima issue con TUTTI i campi (la search/jql restituisce solo i
  // campi richiesti) per individuare il custom field giusto.
  if (conStart === 0 && conDue > 0 && nonEpics.length > 0) {
    const lastKey = nonEpics[nonEpics.length - 1].key;
    console.log(`    ⚠ Tutti i task hanno Start = null ma alcuni hanno Due popolata.`);
    console.log(`    Scarico ${lastKey} con TUTTI i campi per identificare quello giusto...`);
    try {
      const full = await jiraRequest(`/rest/api/3/issue/${encodeURIComponent(lastKey)}?fields=*all`);
      console.log(`    Campi non vuoti su ${lastKey} che potrebbero essere "Start date":`);
      Object.entries(full.fields || {}).forEach(([k, v]) => {
        if (v === null || v === undefined || v === '') return;
        if (Array.isArray(v) && v.length === 0) return;
        if (typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0) return;
        // Concentrati sui customfield e su campi data
        const isDateLike = typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v);
        if (k.startsWith('customfield_') || isDateLike) {
          const preview = typeof v === 'string' ? v.slice(0, 30) : JSON.stringify(v).slice(0, 60);
          console.log(`      ${k}  =  ${preview}`);
        }
      });
      console.log(`    Trovato il campo Start date qui sopra? Settalo come secret JIRA_START_DATE_FIELD nel repo GitHub.`);
    } catch (e) {
      console.log(`    Impossibile fare il dump (${e.message}).`);
    }
  }

  // Riutilizzo lo statoPre letto prima del push (le scritture su Firestore
  // avvengono solo dal frontend, lo script non lo modifica fino al set finale)
  const stato = statoPre || { persone: [], task: [], festivita: [] };
  if (!Array.isArray(stato.task))    stato.task = [];
  if (!Array.isArray(stato.persone)) stato.persone = [];

  const byJiraKey = new Map(stato.task.filter(t => t.jiraKey).map(t => [t.jiraKey, t]));
  const maxOrdine = stato.task.reduce((m, t) => Math.max(m, Number(t.ordine) || 0), 0);
  let nextOrdine = maxOrdine + 1;
  const personeNuove = [];

  // 1st pass: build task + merge assegnazioni
  const jiraKeyToTask = new Map();
  let creati = 0, aggiornati = 0;
  for (const issue of issues) {
    const existing = byJiraKey.get(issue.key);
    const task = buildTask(issue, existing, nextOrdine);
    if (!existing) { creati++; nextOrdine++; } else { aggiornati++; }
    const daJira     = resolveAssignee(issue, stato.persone, personeNuove);
    const esistenti  = existing ? (existing.assegnazioni || []) : [];
    task.assegnazioni = mergeAssegnazioni(daJira, esistenti);
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
