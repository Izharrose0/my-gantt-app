/**
 * Cloud Functions per MY-GANTT.
 * Proxy CORS verso Jira Cloud REST API v3, accessibile solo all'owner.
 *
 * Deploy:
 *   cd functions && npm install
 *   firebase deploy --only functions
 *
 * Note:
 * - Le funzioni sono "callable" (firebase-functions/v2/https.onCall):
 *   gestiscono CORS automaticamente e ricevono context.auth con UID/email
 *   verificati. Niente token Firebase manuale da gestire.
 * - Le credenziali Jira (email + api token) arrivano ad ogni chiamata e
 *   NON vengono mai persistite. Restano in localStorage del solo client.
 */

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { logger } = require('firebase-functions/v2');

const OWNER_EMAIL = 'i.coletti@invrsion.com';

// Campi richiesti a Jira (la lista di campi limita la dimensione della
// response; "customfield_10015" e' tipicamente il Start Date, configurabile
// dal client perche' puo' variare per istanza)
const DEFAULT_JIRA_FIELDS = [
  'summary',
  'status',
  'issuetype',
  'parent',
  'assignee',
  'duedate',
  'created',
  'timetracking',
  'priority',
  'labels'
];

/**
 * Verifica che il chiamante sia l'owner. Throwa HttpsError altrimenti.
 */
function requireOwner(request) {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Devi essere loggato per sincronizzare.');
  }
  const email = request.auth.token?.email;
  const verified = request.auth.token?.email_verified;
  if (email !== OWNER_EMAIL) {
    throw new HttpsError('permission-denied', 'Solo l\'owner può sincronizzare con Jira.');
  }
  if (verified !== true) {
    throw new HttpsError('permission-denied', 'Email non verificata.');
  }
}

/**
 * Esegue una chiamata GET autenticata a Jira REST API.
 * Lancia HttpsError con codice/messaggio leggibile in caso di errore.
 */
async function jiraGet(jiraDomain, path, email, apiToken) {
  const url = `https://${jiraDomain}${path}`;
  const auth = Buffer.from(`${email}:${apiToken}`).toString('base64');
  let resp;
  try {
    resp = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Accept': 'application/json'
      }
    });
  } catch (e) {
    logger.error('Errore di rete verso Jira', { url, message: e.message });
    throw new HttpsError('unavailable', `Errore di rete verso Jira: ${e.message}`);
  }

  if (resp.status === 401 || resp.status === 403) {
    throw new HttpsError('permission-denied',
      'Credenziali Jira non valide o permessi insufficienti (401/403).');
  }
  if (resp.status === 404) {
    throw new HttpsError('not-found',
      'Endpoint Jira non trovato (404): controlla domain e project key.');
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    logger.error('Jira non OK', { status: resp.status, body: text.slice(0, 500) });
    throw new HttpsError('internal', `Jira ha risposto ${resp.status}: ${text.slice(0, 300)}`);
  }
  return resp.json();
}

/**
 * Cloud Function callable: sincronizza le issue di un progetto Jira.
 * Input:
 *   {
 *     jiraDomain: "miaazienda.atlassian.net",
 *     email: "user@miaazienda.com",
 *     apiToken: "<api token Atlassian>",
 *     projectKey: "PROJ",
 *     startDateField: "customfield_10015"   // opzionale
 *   }
 * Output:
 *   {
 *     issues: [...],            // issues Jira normalizzate
 *     totalImported: N,
 *     projectKey: "PROJ"
 *   }
 */
exports.jiraSync = onCall(
  {
    region: 'us-central1',
    timeoutSeconds: 60,
    memory: '256MiB'
  },
  async (request) => {
    requireOwner(request);

    const data = request.data || {};
    const jiraDomain    = (data.jiraDomain    || '').trim().replace(/^https?:\/\//, '');
    const jiraEmail     = (data.email         || '').trim();
    const apiToken      = (data.apiToken      || '').trim();
    const projectKey    = (data.projectKey    || '').trim();
    const startDateFld  = (data.startDateField || 'customfield_10015').trim();

    if (!jiraDomain)  throw new HttpsError('invalid-argument', 'jiraDomain mancante (es. tuosito.atlassian.net)');
    if (!jiraEmail)   throw new HttpsError('invalid-argument', 'email Jira mancante');
    if (!apiToken)    throw new HttpsError('invalid-argument', 'apiToken Jira mancante');
    if (!projectKey)  throw new HttpsError('invalid-argument', 'projectKey mancante');

    const fields = DEFAULT_JIRA_FIELDS.concat([startDateFld]).join(',');
    const jql = encodeURIComponent(`project = "${projectKey}" ORDER BY created ASC`);

    // Paginazione: Jira Cloud restituisce max 100 issue per chiamata
    const PAGE_SIZE = 100;
    let startAt = 0;
    let total = Infinity;
    const issues = [];

    while (startAt < total) {
      const path = `/rest/api/3/search?jql=${jql}&fields=${fields}&maxResults=${PAGE_SIZE}&startAt=${startAt}`;
      const page = await jiraGet(jiraDomain, path, jiraEmail, apiToken);
      total = Number(page.total) || 0;
      const pageIssues = page.issues || [];
      // Normalizzo: estraggo solo i campi che il frontend usa
      pageIssues.forEach(it => {
        issues.push({
          key: it.key,
          self: it.self,
          summary:      it.fields?.summary || '',
          status: {
            name: it.fields?.status?.name || '',
            category: it.fields?.status?.statusCategory?.key || 'new'
          },
          issuetype: {
            name: it.fields?.issuetype?.name || '',
            subtask: !!it.fields?.issuetype?.subtask
          },
          parentKey:   it.fields?.parent?.key || null,
          assignee: it.fields?.assignee ? {
            accountId:    it.fields.assignee.accountId || null,
            emailAddress: it.fields.assignee.emailAddress || null,
            displayName:  it.fields.assignee.displayName || ''
          } : null,
          startDate:    it.fields?.[startDateFld] || null,
          dueDate:      it.fields?.duedate || null,
          created:      it.fields?.created || null,
          originalEstimateSeconds:
            it.fields?.timetracking?.originalEstimateSeconds || 0,
          priority:     it.fields?.priority?.name || null,
          labels:       Array.isArray(it.fields?.labels) ? it.fields.labels : []
        });
      });
      startAt += pageIssues.length;
      if (pageIssues.length === 0) break; // safety: nessuna pagina vuota infinita
    }

    logger.info('jiraSync OK', { projectKey, total, importate: issues.length });
    return {
      issues,
      totalImported: issues.length,
      total,
      projectKey
    };
  }
);
