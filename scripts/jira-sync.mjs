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

// Lista di project keys da sincronizzare. Precedenza:
//   1. JIRA_PROJECT_KEY_OVERRIDE (workflow_dispatch input, comma-separated)
//   2. /config/jira.projects su Firestore (configurata dall'app)
//   3. JIRA_PROJECT_KEY secret (single, fallback per single-project)
function parseList(s) {
  return (s || '').split(',').map(x => x.trim()).filter(Boolean);
}
const projectKeysOverride = parseList(JIRA_PROJECT_KEY_OVERRIDE);
const startDateField = (JIRA_START_DATE_FIELD || 'customfield_10015').trim();

function abort(msg) {
  console.error('❌', msg);
  process.exit(1);
}

if (!JIRA_DOMAIN)             abort('Manca JIRA_DOMAIN (es. mioteam.atlassian.net)');
if (!JIRA_EMAIL)              abort('Manca JIRA_EMAIL');
if (!JIRA_API_TOKEN)          abort('Manca JIRA_API_TOKEN');
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
async function fetchAllIssues(projectKey) {
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

function buildTask(issue, existing, nextOrdine, projectKey) {
  const f = issue.fields || {};
  const isEpic = f.issuetype?.name === 'Epic';
  const tipo = isEpic ? 'epica' : 'task';
  const statoNuovo = mapStato(issue);
  const orig = Number(f.timetracking?.originalEstimateSeconds || 0);
  const stimaOre = arrotondaOreA05(orig / 3600);
  // Date: importiamo start/due da Jira sia per epiche che per task.
  // Per le epiche aggregaEpica nel frontend useranno i figli SE presenti;
  // se l'epica non ha ancora figli linkati, viene comunque renderizzata
  // come barra usando le date che Jira ha sull'epic stessa.
  const startRaw = f[resolvedStartDateField];
  let start = typeof startRaw === 'string' ? startRaw.slice(0, 10) : null;
  let due   = f.duedate || null;
  const norm = normalizzaDate(start, due);
  start = norm.inizio;
  due   = norm.fine;

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
    jiraProject: projectKey,
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

// Risoluzione lista progetti da sincronizzare (in ordine di precedenza)
async function risolviProgetti() {
  if (projectKeysOverride.length) {
    return { source: 'override', list: projectKeysOverride };
  }
  // Da Firestore /config/jira.projects
  try {
    const cfgRef = db.collection('config').doc('jira');
    const snap = await cfgRef.get();
    if (snap.exists) {
      const list = Array.isArray(snap.data()?.projects) ? snap.data().projects : [];
      if (list.length) return { source: 'firestore', list };
    }
  } catch (e) {
    console.warn('  ⚠ Lettura /config/jira fallita:', e.message);
  }
  // Fallback: env secret
  if (JIRA_PROJECT_KEY) {
    return { source: 'env', list: parseList(JIRA_PROJECT_KEY) };
  }
  return { source: 'none', list: [] };
}

async function main() {
  console.log(`▶ Sync Jira → Firestore`);
  console.log(`  Domain: ${JIRA_DOMAIN}`);

  // Modalità del run: pull = solo Jira→MY-GANTT, push = solo MY-GANTT→Jira,
  // both = entrambe (default per retro-compatibilità).
  const DIRECTION = (process.env.SYNC_DIRECTION || 'both').toLowerCase();
  console.log(`  Modalità: ${DIRECTION}`);

  const { source, list: projectKeys } = await risolviProgetti();
  if (!projectKeys.length) {
    abort('Nessun progetto da sincronizzare. Configura /config/jira.projects dall\'app oppure setta JIRA_PROJECT_KEY come secret.');
  }
  console.log(`  Progetti (${source}): ${projectKeys.join(', ')}`);

  console.log('▶ Rilevo campo Start date...');
  await autoDetectStartDateField();

  console.log('▶ Lettura stato Firestore...');
  const snapPre = await docRef.get();
  const statoPre = snapPre.exists ? snapPre.data() : null;

  // ===== MODALITÀ PUSH =====
  // Solo invio le modifiche locali di start/end a Jira. Riallinea anche
  // jiraSyncedX dopo il push (così detection delta riparte da zero).
  if (DIRECTION === 'push') {
    if (!statoPre || !Array.isArray(statoPre.task)) {
      console.log('  Niente da pushare: Firestore vuoto.');
      return;
    }
    const { ok } = await pushModificheDate(statoPre);
    if (ok > 0) {
      // Aggiorna jiraSyncedInizio/Fine sui task pushati così la prossima
      // detection delta non li ri-rileva.
      statoPre.task.forEach(t => {
        if (!t.jiraKey || t.tipo !== 'task') return;
        if (t.inizio && t.inizio !== t.jiraSyncedInizio) t.jiraSyncedInizio = t.inizio;
        if (t.fine   && t.fine   !== t.jiraSyncedFine)   t.jiraSyncedFine   = t.fine;
      });
      console.log('▶ Aggiorno snapshot jiraSyncedX su Firestore...');
      await docRef.set(statoPre);
    }
    return; // niente fetch, niente merge
  }

  // ===== MODALITÀ BOTH (legacy) =====
  // Spinge le modifiche locali PRIMA del fetch (così il fetch include
  // anche le nostre modifiche appena scritte).
  if (DIRECTION === 'both' && statoPre && Array.isArray(statoPre.task)) {
    await pushModificheDate(statoPre);
  }

  // ===== MODALITÀ PULL / BOTH: fetch da Jira (loop multi-progetto) =====
  const stato = statoPre || { persone: [], task: [], festivita: [] };
  if (!Array.isArray(stato.task))    stato.task = [];
  if (!Array.isArray(stato.persone)) stato.persone = [];

  const personeNuove = [];
  let creatiTot = 0, aggiornatiTot = 0;

  // Per ogni progetto: fetch issue, mergea i task di QUEL progetto, lascia
  // intatti i task degli altri progetti e quelli manuali.
  for (const projectKey of projectKeys) {
    console.log(`\n▶ Progetto: ${projectKey}`);
    console.log(`  Fetch issue da Jira...`);
    let issues;
    try {
      issues = await fetchAllIssues(projectKey);
    } catch (e) {
      console.log(`  ✗ Fetch fallito: ${e.message}. Salto il progetto.`);
      continue;
    }
    console.log(`  ✓ ${issues.length} issue ricevute per ${projectKey}`);

    // Diagnostica date sulle issue del progetto corrente
    const nonEpics = issues.filter(it => it.fields?.issuetype?.name !== 'Epic');
    const conStart = nonEpics.filter(it => it.fields?.[resolvedStartDateField]).length;
    const conDue   = nonEpics.filter(it => it.fields?.duedate).length;
    console.log(`  Date: ${conStart}/${nonEpics.length} con Start, ${conDue}/${nonEpics.length} con Due`);

    // Indice dei task ESISTENTI per jiraKey (ALL projects, non solo questo).
    // Serve a trovare task importati PRIMA della feature multi-progetto
    // (con jiraProject null) e aggiornarli senza creare duplicati.
    const byJiraKey = new Map(
      stato.task.filter(t => t.jiraKey).map(t => [t.jiraKey, t])
    );
    const maxOrdine = stato.task.reduce((m, t) => Math.max(m, Number(t.ordine) || 0), 0);
    let nextOrdine = maxOrdine + 1;

    // 1st pass: build task + merge assegnazioni
    const jiraKeyToTask = new Map();
    let creati = 0, aggiornati = 0;
    for (const issue of issues) {
      const existing = byJiraKey.get(issue.key);
      const task = buildTask(issue, existing, nextOrdine, projectKey);
      if (!existing) { creati++; nextOrdine++; } else { aggiornati++; }
      const daJira    = resolveAssignee(issue, stato.persone, personeNuove);
      const esistenti = existing ? (existing.assegnazioni || []) : [];
      task.assegnazioni = mergeAssegnazioni(daJira, esistenti);
      jiraKeyToTask.set(issue.key, task);
    }

    // 2nd pass: risolvi parent (parent.key o customfield_10014)
    let orphans = 0;
    for (const issue of issues) {
      const direct   = issue.fields?.parent?.key;
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
      console.log(`  ⚠ ${orphans} issue con parent fuori dal progetto ${projectKey} (top-level)`);
    }

    // Rimuovo i task il cui jiraKey e' nel nuovo set (indipendentemente
    // dal loro vecchio jiraProject — potrebbe essere null sui vecchi import).
    // Quelli manuali (senza jiraKey) e di ALTRI progetti restano intoccati.
    const newKeys = new Set(jiraKeyToTask.keys());
    const altri = stato.task.filter(t => !t.jiraKey || !newKeys.has(t.jiraKey));
    stato.task = [...altri, ...jiraKeyToTask.values()];
    console.log(`  ${projectKey}: ${creati} nuovi, ${aggiornati} aggiornati`);
    creatiTot += creati;
    aggiornatiTot += aggiornati;
  }

  stato.persone = [...stato.persone, ...personeNuove];

  console.log(`\n▶ Scrittura su Firestore: ${stato.task.length} task totali`);
  await docRef.set(stato);

  console.log('');
  console.log(`✅ Sync completato`);
  console.log(`   ${creatiTot} task nuovi (totale su tutti i progetti)`);
  console.log(`   ${aggiornatiTot} task aggiornati`);
  console.log(`   ${personeNuove.length} persone auto-create`);
}

main().catch(err => {
  console.error('💥 Sync fallito:', err);
  process.exit(1);
});
