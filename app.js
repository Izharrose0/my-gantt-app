// ===== STATO APPLICAZIONE =====
// Dati in memoria, sincronizzati con localStorage ad ogni modifica
let stato = {
  persone: [],   // [{ id, nome, ruolo, fte, colore, teamId, ordine }]
  task: [],      // [{ id, nome, inizio, fine, assegnazioni: [{personaId, effort}], stato }]
  team: []       // [{ id, nome, colore, ordine }]
};

// ===== AUTH / RUOLI =====
// Tre ruoli (vedi firestore.rules):
// - OWNER: i.coletti@invrsion.com, accesso totale
// - EDITOR: email in /config/auth.editorEmails, puo' modificare dati
// - VIEWER: email in /config/auth.viewerEmails, sola lettura
const OWNER_EMAIL = 'i.coletti@invrsion.com';
let utenteCorrente = null;     // firebase User | null
let editorEmailsCache = [];     // cache popolata al boot

function isOwner() {
  return utenteCorrente?.email === OWNER_EMAIL;
}
function isEditor() {
  if (!utenteCorrente?.email) return false;
  if (isOwner()) return true;
  return editorEmailsCache.includes(utenteCorrente.email);
}

// Override locale del ruolo per anteprima "vista come..." (per-utente,
// persistito in localStorage). Non puo' MAI espandere i permessi reali.
const RUOLO_PREVIEW_KEY = 'gantt-app-ruolo-preview';
function ruoloEffettivoBase() {
  if (isOwner()) return 'owner';
  if (isEditor()) return 'editor';
  return 'viewer';
}
function ruoloPreview() {
  return localStorage.getItem(RUOLO_PREVIEW_KEY) || '';
}
function ruoloCorrente() {
  const base = ruoloEffettivoBase();
  const preview = ruoloPreview();
  if (!preview) return base;
  // L'override puo' solo RIDURRE i permessi visualizzati, mai aumentarli
  const ordine = { viewer: 0, editor: 1, owner: 2 };
  if ((ordine[preview] ?? 2) <= (ordine[base] ?? 0)) return preview;
  return base;
}
function setRuoloPreview(r) {
  if (!r || r === ruoloEffettivoBase()) localStorage.removeItem(RUOLO_PREVIEW_KEY);
  else localStorage.setItem(RUOLO_PREVIEW_KEY, r);
  aggiornaUIPermessi();
}

// Aggiorna la UI in base al ruolo: badge, classi sul body. Le regole CSS
// (.only-owner, .only-editor) fanno il vero hiding.
function aggiornaUIPermessi() {
  const role = ruoloCorrente();
  document.body.setAttribute('data-role', role);
  const badge = document.getElementById('role-badge');
  if (badge) {
    badge.classList.remove('role-owner', 'role-editor', 'role-viewer');
    badge.classList.add(`role-${role}`);
    const label = badge.querySelector('.role-label');
    if (label) label.textContent = role === 'owner' ? 'OWNER' : role === 'editor' ? 'EDITOR' : 'VIEW ONLY';
    const base = ruoloEffettivoBase();
    const previewing = role !== base;
    badge.title = previewing
      ? `Loggato come ${utenteCorrente.email} (${base}) — anteprima vista ${role}`
      : `Loggato come ${utenteCorrente.email} — ruolo ${role}`;
  }
  const logoutLabel = document.getElementById('logout-label');
  if (logoutLabel && utenteCorrente) {
    logoutLabel.textContent = `Esci (${utenteCorrente.email.split('@')[0]})`;
  }
  // Login/Logout: mostra/nascondi in base allo stato auth
  const btnLogin = document.getElementById('btn-login-email');
  const btnLogout = document.getElementById('btn-logout');
  if (btnLogin)  btnLogin.classList.toggle('hidden', !!utenteCorrente);
  if (btnLogout) btnLogout.classList.toggle('hidden', !utenteCorrente);
  // Highlight item attivo nel selector "Vista come"
  const preview = ruoloPreview();
  document.querySelectorAll('.kebab-vista-opt').forEach(el => {
    const v = el.dataset.vista;
    const active = (v === 'base' && !preview) || v === preview;
    el.classList.toggle('vista-attiva', active);
  });
  const formModifica = document.getElementById('form-modifica-task');
  if (formModifica) {
    const submit = formModifica.querySelector('button[type="submit"]');
    if (submit) submit.style.display = (role === 'owner' || role === 'editor') ? '' : 'none';
  }
}

// Chiave localStorage per memorizzare l'email in attesa del link
const EMAIL_LINK_STORAGE = 'gantt-app-pending-login-email';

// Sottoscrive lo stato di auth e attiva il flow email link
function inizializzaAuth() {
  const fb = window.__firebase;
  if (!fb || !fb.auth) {
    aggiornaUIPermessi();
    return;
  }
  fb.onAuthStateChanged(fb.auth, async user => {
    utenteCorrente = user;
    console.log('[AUTH] onAuthStateChanged →', user?.email || 'logged out');
    if (user) {
      // Carica la lista editor (per isEditor() lato client) PRIMA di
      // aggiornare la UI, cosi' i permessi sono corretti al primo render.
      try { await ricaricaCacheRuoli(); } catch {}
      aggiornaUIPermessi();
      rimuoviBannerAccesso();
      try { avviaSyncFirestore(); } catch {}
    } else {
      editorEmailsCache = [];
      aggiornaUIPermessi();
      // Logout (o stato iniziale "non loggato"): chiudo la sottoscrizione,
      // svuoto lo stato e mostro il banner di login.
      terminaSyncFirestore();
      mostraBannerAccesso();
    }
  });

  // Se l'utente è appena arrivato cliccando il link dall'email, completa il login
  if (fb.isSignInWithEmailLink(fb.auth, window.location.href)) {
    let email = localStorage.getItem(EMAIL_LINK_STORAGE);
    if (!email) {
      email = window.prompt('Conferma la tua email per completare l\'accesso:');
    }
    if (email) {
      fb.signInWithEmailLink(fb.auth, email, window.location.href)
        .then(() => {
          localStorage.removeItem(EMAIL_LINK_STORAGE);
          // Pulisci l'URL: rimuovi oobCode/mode dal querystring
          const cleanUrl = window.location.origin + window.location.pathname;
          window.history.replaceState({}, document.title, cleanUrl);
          console.log('[AUTH] signInWithEmailLink OK →', email);
        })
        .catch(e => {
          console.error('[AUTH] signInWithEmailLink ERRORE:', e);
          // Pulisco l'URL così l'utente non resta su un link "consumato"
          const cleanUrl = window.location.origin + window.location.pathname;
          window.history.replaceState({}, document.title, cleanUrl);
          // Notifica non-blocking (no alert, che bloccherebbe il rendering)
          mostraToast('❌ Login fallito: ' + (e.code || e.message || 'errore sconosciuto') +
                      '. Riprova facendo richiesta del link da questo browser.', 'error');
        });
    }
  }

  // Click "Accedi come owner (link via email)"
  document.getElementById('btn-login-email')?.addEventListener('click', async () => {
    const emailDefault = OWNER_EMAIL;
    const email = window.prompt('Inserisci la tua email (di owner):', emailDefault);
    if (!email) return;
    const actionCodeSettings = {
      url: window.location.origin + window.location.pathname,
      handleCodeInApp: true
    };
    try {
      await fb.sendSignInLinkToEmail(fb.auth, email, actionCodeSettings);
      localStorage.setItem(EMAIL_LINK_STORAGE, email);
      alert(
        'Link di accesso inviato a:\n' + email +
        '\n\nApri l\'email e clicca il link per completare l\'accesso.' +
        '\nIl link scade dopo 1 ora.'
      );
    } catch (e) {
      console.error('[AUTH] sendSignInLinkToEmail ERRORE:', e);
      alert('Invio link fallito: ' + (e.message || e.code || e));
    }
  });

  document.getElementById('btn-logout')?.addEventListener('click', async () => {
    try { await fb.signOut(fb.auth); } catch (e) {}
  });

  // Click "Gestisci visibilità persone"
  document.getElementById('btn-gestisci-vis-persone')?.addEventListener('click', apriModaleVisPersone);
  document.getElementById('btn-chiudi-modal-vis-persone')?.addEventListener('click', () =>
    document.getElementById('modal-vis-persone-overlay').classList.add('hidden'));
  document.getElementById('btn-vis-persone-tutti')?.addEventListener('click', () => setVisibilitaPersoneTutte(false));
  document.getElementById('btn-vis-persone-nessuno')?.addEventListener('click', () => setVisibilitaPersoneTutte(true));
  document.getElementById('btn-vis-persone-solo-assegnate')?.addEventListener('click', () => {
    stato.persone.forEach(p => {
      const hasTask = stato.task.some(t => (t.assegnazioni || []).some(a => a.personaId === p.id));
      p.nascosta = !hasTask;
    });
    salvaStato();
    renderListaVisPersone();
    aggiornaViste();
  });

  // Click "Gestisci team" → modal
  document.getElementById('btn-gestisci-team')?.addEventListener('click', apriModaleTeam);
  document.getElementById('btn-chiudi-modal-team')?.addEventListener('click', () =>
    document.getElementById('modal-team-overlay').classList.add('hidden'));
  document.getElementById('form-team-add')?.addEventListener('submit', e => {
    e.preventDefault();
    const nome = document.getElementById('team-nome-nuovo').value.trim();
    const colore = document.getElementById('team-colore-nuovo').value;
    if (!nome) return;
    aggiungiTeam(nome, colore);
    document.getElementById('team-nome-nuovo').value = '';
  });

  // Click "Progetti Jira" → modal di gestione
  document.getElementById('btn-progetti-jira')?.addEventListener('click', apriModaleProgettiJira);
  document.getElementById('btn-chiudi-modal-progetti-jira')?.addEventListener('click', () => {
    document.getElementById('modal-progetti-jira-overlay').classList.add('hidden');
  });
  document.getElementById('form-progetti-jira-add')?.addEventListener('submit', async e => {
    e.preventDefault();
    const input = document.getElementById('progetti-jira-nuovo');
    await aggiungiProgettoJira(input.value);
    input.value = '';
  });

  // Click "Pull da Jira" → triggera il workflow via API e monitora lo stato
  document.getElementById('btn-pull-jira')?.addEventListener('click', () =>
    triggeraWorkflow('jira-sync.yml', 'Pull da Jira'));
  // Click "Push MY-GANTT → Jira" → triggera il workflow Push
  document.getElementById('btn-push-jira')?.addEventListener('click', () =>
    triggeraWorkflow('jira-push.yml', 'Push verso Jira'));

  // Click "Gestisci visibilità epiche" → apri modale
  document.getElementById('btn-gestisci-visibilita')?.addEventListener('click', apriModaleVisibilita);
  document.getElementById('btn-chiudi-modal-visibilita')?.addEventListener('click', () => {
    document.getElementById('modal-visibilita-overlay').classList.add('hidden');
  });

  // Click "Associa persone Jira ↔ MY-GANTT" → apri modale
  document.getElementById('btn-associa-persone')?.addEventListener('click', apriModaleAssocPersone);
  document.getElementById('btn-chiudi-modal-assoc-persone')?.addEventListener('click', () => {
    document.getElementById('modal-assoc-persone-overlay').classList.add('hidden');
  });

  // "Vista come": override locale del ruolo per anteprima
  document.querySelectorAll('.kebab-vista-opt').forEach(btn => {
    btn.addEventListener('click', () => {
      const v = btn.dataset.vista;
      setRuoloPreview(v === 'base' ? '' : v);
      document.getElementById('kebab-dropdown')?.classList.add('hidden');
    });
  });

  // Click "Gestisci accessi" → apri modale whitelist
  document.getElementById('btn-gestisci-accessi')?.addEventListener('click', apriModaleAccessi);
  document.getElementById('btn-chiudi-modal-accessi')?.addEventListener('click', () => {
    document.getElementById('modal-accessi-overlay').classList.add('hidden');
  });
  document.getElementById('form-accessi-add')?.addEventListener('submit', async e => {
    e.preventDefault();
    const input = document.getElementById('accessi-email-nuova');
    const ruolo = document.getElementById('accessi-ruolo-nuovo')?.value || 'viewer';
    const email = (input.value || '').trim().toLowerCase();
    if (!email) return;
    await aggiungiAccessoEmail(email, ruolo);
    input.value = '';
  });
  document.getElementById('btn-vis-tutti')?.addEventListener('click', () => setVisibilitaTutte(false));
  document.getElementById('btn-vis-nessuno')?.addEventListener('click', () => setVisibilitaTutte(true));
  document.getElementById('btn-vis-solo-jira')?.addEventListener('click', () => {
    stato.task.forEach(t => {
      if (t.tipo !== 'epica') return;
      t.nascosta = !t.jiraKey; // solo le jira-epiche restano visibili
    });
    salvaStato();
    renderListaVisibilita();
    aggiornaViste();
  });
}

// ===== GESTIONE VISIBILITÀ PERSONE =====

function apriModaleVisPersone() {
  renderListaVisPersone();
  document.getElementById('modal-vis-persone-overlay').classList.remove('hidden');
}

function renderListaVisPersone() {
  const cont = document.getElementById('lista-vis-persone');
  if (!cont) return;
  const persone = stato.persone.slice().sort((a, b) => (a.nome || '').localeCompare(b.nome || ''));
  if (!persone.length) {
    cont.innerHTML = '<li class="empty-state">Nessuna persona.</li>';
    return;
  }
  cont.innerHTML = persone.map(p => {
    const visibile = !p.nascosta;
    const taskCount = stato.task.filter(t =>
      (t.assegnazioni || []).some(a => a.personaId === p.id)).length;
    const tm = (stato.team || []).find(t => t.id === p.teamId);
    const teamBadge = tm ? `<span class="label-fte">${escapeHtml(tm.nome)}</span>` : '';
    const jiraBadge = p.jiraAccountId
      ? '<span class="label-fte epica-badge">Jira</span>'
      : '';
    return `
      <li class="vis-row${visibile ? '' : ' vis-hidden'}">
        <label class="vis-toggle">
          <input type="checkbox" data-vis-persona="${p.id}" ${visibile ? 'checked' : ''}>
          ${avatar(p, 'sm')}
          <span class="vis-name">${escapeHtml(p.nome)}</span>
          ${teamBadge}
          ${jiraBadge}
          <span class="label-fte">${taskCount} task</span>
        </label>
      </li>`;
  }).join('');

  cont.querySelectorAll('input[data-vis-persona]').forEach(cb => {
    cb.addEventListener('change', () => {
      const p = stato.persone.find(x => x.id === cb.dataset.visPersona);
      if (!p) return;
      p.nascosta = !cb.checked;
      cb.closest('.vis-row')?.classList.toggle('vis-hidden', !cb.checked);
      salvaStato();
      aggiornaViste();
    });
  });
}

function setVisibilitaPersoneTutte(nascosta) {
  stato.persone.forEach(p => { p.nascosta = nascosta; });
  salvaStato();
  renderListaVisPersone();
  aggiornaViste();
}

// ===== GESTIONE TEAM =====

function apriModaleTeam() {
  renderListaTeam();
  document.getElementById('modal-team-overlay').classList.remove('hidden');
}

function renderListaTeam() {
  const ul = document.getElementById('lista-team');
  if (!ul) return;
  if (!stato.team.length) {
    ul.innerHTML = '<li class="empty-state">Nessun team creato.</li>';
    return;
  }
  ul.innerHTML = stato.team.slice().sort((a, b) => (a.ordine || 0) - (b.ordine || 0)).map(tm => {
    const n = stato.persone.filter(p => p.teamId === tm.id).length;
    return `
      <li class="acc-row">
        <div style="display:flex;align-items:center;gap:0.6rem">
          <span style="width:16px;height:16px;border-radius:3px;background:${escapeHtml(tm.colore)};flex-shrink:0"></span>
          <strong class="team-nome-edit" data-team-id="${tm.id}" style="cursor:pointer" title="Click per rinominare">${escapeHtml(tm.nome)}</strong>
          <small style="color:var(--color-text-muted)">${n} persone</small>
        </div>
        <div style="display:flex;gap:0.3rem">
          <button type="button" class="btn btn-edit btn-sm" data-rinomina-team="${tm.id}">Rinomina</button>
          <button type="button" class="btn btn-danger btn-sm" data-rimuovi-team="${tm.id}">Rimuovi</button>
        </div>
      </li>`;
  }).join('');
  ul.querySelectorAll('[data-rinomina-team]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.rinominaTeam;
      const tm = stato.team.find(t => t.id === id);
      if (!tm) return;
      const nuovoNome = prompt('Nuovo nome per il team:', tm.nome);
      if (!nuovoNome || !nuovoNome.trim()) return;
      tm.nome = nuovoNome.trim();
      salvaStato();
      renderListaTeam();
      aggiornaViste();
    });
  });
  ul.querySelectorAll('[data-rimuovi-team]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.rimuoviTeam;
      const tm = stato.team.find(t => t.id === id);
      if (!confirm(`Eliminare il team "${tm?.nome || id}"?\nLe persone torneranno "Non assegnate".`)) return;
      stato.persone.forEach(p => { if (p.teamId === id) p.teamId = null; });
      stato.team = stato.team.filter(t => t.id !== id);
      salvaStato();
      renderListaTeam();
      aggiornaViste();
    });
  });
}

function aggiungiTeam(nome, colore) {
  const maxOrd = stato.team.reduce((m, t) => Math.max(m, t.ordine || 0), 0);
  stato.team.push({
    id: generaId(),
    nome,
    colore: colore || '#5e6ad2',
    ordine: maxOrd + 1
  });
  salvaStato();
  renderListaTeam();
}

// Popola il dropdown "Team" nel modal Modifica persona
function popolaSelectTeamPersona(selectId, currentTeamId) {
  const sel = document.getElementById(selectId);
  if (!sel) return;
  sel.innerHTML = `<option value="">— Nessun team —</option>` +
    stato.team.slice().sort((a, b) => (a.ordine || 0) - (b.ordine || 0))
      .map(tm => `<option value="${tm.id}" ${currentTeamId === tm.id ? 'selected' : ''}>${escapeHtml(tm.nome)}</option>`)
      .join('');
}

// ===== GESTIONE PROGETTI JIRA =====
// La lista di project key da sincronizzare e' storata in Firestore:
// collection "config", doc "jira", campo "projects" (array di stringhe).
// Lo script di sync legge da qui.

const CONFIG_JIRA_PATH = ['config', 'jira'];

async function caricaProgettiJira() {
  const fb = window.__firebase;
  if (!fb || !fb.db || !fb.doc) return { projects: [] };
  try {
    const ref = fb.doc(fb.db, ...CONFIG_JIRA_PATH);
    const { getDoc } = await import('https://www.gstatic.com/firebasejs/12.13.0/firebase-firestore.js');
    const snap = await getDoc(ref);
    if (!snap.exists()) return { projects: [] };
    const data = snap.data() || {};
    return { projects: Array.isArray(data.projects) ? data.projects : [] };
  } catch (e) {
    console.warn('caricaProgettiJira:', e);
    return { projects: [] };
  }
}

async function salvaProgettiJira(projects) {
  const fb = window.__firebase;
  if (!fb || !fb.db || !fb.doc || !fb.setDoc) return false;
  try {
    const ref = fb.doc(fb.db, ...CONFIG_JIRA_PATH);
    await fb.setDoc(ref, { projects }, { merge: true });
    return true;
  } catch (e) {
    alert('Salvataggio fallito: ' + (e.message || e.code || e));
    return false;
  }
}

async function apriModaleProgettiJira() {
  document.getElementById('modal-progetti-jira-overlay').classList.remove('hidden');
  await renderListaProgettiJira();
}

async function renderListaProgettiJira() {
  const ul = document.getElementById('lista-progetti-jira');
  if (!ul) return;
  ul.innerHTML = '<li class="empty-state">Caricamento…</li>';
  const cfg = await caricaProgettiJira();
  if (!cfg.projects.length) {
    ul.innerHTML = '<li class="empty-state">Nessun progetto configurato. Aggiungine uno per iniziare a sincronizzare.</li>';
    return;
  }
  ul.innerHTML = cfg.projects.slice().sort().map(p => {
    const n = stato.task.filter(t => t.jiraProject === p).length;
    return `
      <li class="acc-row">
        <div><code>${escapeHtml(p)}</code> <small style="color:var(--color-text-muted)">${n} task importati</small></div>
        <button type="button" class="btn btn-danger btn-sm" data-rimuovi-proj="${escapeHtml(p)}">Rimuovi</button>
      </li>`;
  }).join('');
  ul.querySelectorAll('[data-rimuovi-proj]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const p = btn.dataset.rimuoviProj;
      if (!confirm(`Rimuovere il progetto "${p}" dalla lista di sync?\n\nI task gia' importati restano in MY-GANTT (non vengono cancellati). Per cancellarli usa "Gestisci visibilita' epiche".`)) return;
      const cfg = await caricaProgettiJira();
      const updated = cfg.projects.filter(x => x !== p);
      if (await salvaProgettiJira(updated)) renderListaProgettiJira();
    });
  });
}

async function aggiungiProgettoJira(key) {
  const k = (key || '').trim().toUpperCase();
  if (!k) return;
  const cfg = await caricaProgettiJira();
  if (cfg.projects.includes(k)) {
    alert(`Il progetto "${k}" e' gia' configurato.`);
    return;
  }
  const updated = [...cfg.projects, k];
  if (await salvaProgettiJira(updated)) renderListaProgettiJira();
}

// Restituisce l'elenco unico dei project key presenti nei task importati
function progettiPresenti() {
  return [...new Set(stato.task.map(t => t.jiraProject).filter(Boolean))].sort();
}

// ===== GESTIONE ACCESSI (WHITELIST EMAIL) =====
// La whitelist è storata in Firestore: collection "config", doc "auth",
// campo "viewerEmails" (array di stringhe). Le rules consultano questo
// doc tramite get() per autorizzare i read sulle /workspaces.

const CONFIG_AUTH_PATH = ['config', 'auth'];

async function caricaWhitelist() {
  const fb = window.__firebase;
  if (!fb || !fb.db || !fb.doc) return { viewerEmails: [], editorEmails: [] };
  try {
    const ref = fb.doc(fb.db, ...CONFIG_AUTH_PATH);
    const { getDoc } = await import('https://www.gstatic.com/firebasejs/12.13.0/firebase-firestore.js');
    const snap = await getDoc(ref);
    if (!snap.exists()) return { viewerEmails: [], editorEmails: [] };
    const data = snap.data() || {};
    return {
      viewerEmails: Array.isArray(data.viewerEmails) ? data.viewerEmails : [],
      editorEmails: Array.isArray(data.editorEmails) ? data.editorEmails : []
    };
  } catch (e) {
    console.warn('caricaWhitelist:', e);
    return { viewerEmails: [], editorEmails: [] };
  }
}

async function salvaWhitelist(payload) {
  // payload: { viewerEmails?: [], editorEmails?: [] } — merge solo i campi passati
  const fb = window.__firebase;
  if (!fb || !fb.db || !fb.doc || !fb.setDoc) return false;
  try {
    const ref = fb.doc(fb.db, ...CONFIG_AUTH_PATH);
    await fb.setDoc(ref, payload, { merge: true });
    return true;
  } catch (e) {
    alert('Salvataggio fallito: ' + (e.message || e.code || e));
    return false;
  }
}

// Carica gli editor email e li mette in cache (per isEditor() lato client).
// Chiamata dopo l'autenticazione.
async function ricaricaCacheRuoli() {
  const cfg = await caricaWhitelist();
  editorEmailsCache = cfg.editorEmails || [];
}

async function apriModaleAccessi() {
  document.getElementById('modal-accessi-overlay').classList.remove('hidden');
  await renderListaAccessi();
}

async function renderListaAccessi() {
  const ulV = document.getElementById('lista-accessi');
  const ulE = document.getElementById('lista-accessi-editor');
  if (!ulV) return;
  ulV.innerHTML = '<li class="empty-state">Caricamento…</li>';
  if (ulE) ulE.innerHTML = '<li class="empty-state">Caricamento…</li>';
  const cfg = await caricaWhitelist();

  // Viewer
  if (!cfg.viewerEmails.length) {
    ulV.innerHTML = '<li class="empty-state">Nessun viewer oltre all\'owner/editor.</li>';
  } else {
    ulV.innerHTML = cfg.viewerEmails.slice().sort().map(e => `
      <li class="acc-row">
        <code>${escapeHtml(e)}</code>
        <button type="button" class="btn btn-danger btn-sm" data-rimuovi-viewer="${escapeHtml(e)}">Rimuovi</button>
      </li>`).join('');
    ulV.querySelectorAll('[data-rimuovi-viewer]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const email = btn.dataset.rimuoviViewer;
        if (!confirm(`Rimuovere "${email}" dai viewer?`)) return;
        const c = await caricaWhitelist();
        const updated = c.viewerEmails.filter(x => x !== email);
        if (await salvaWhitelist({ viewerEmails: updated })) renderListaAccessi();
      });
    });
  }

  // Editor
  if (ulE) {
    if (!cfg.editorEmails.length) {
      ulE.innerHTML = '<li class="empty-state">Nessun editor configurato.</li>';
    } else {
      ulE.innerHTML = cfg.editorEmails.slice().sort().map(e => `
        <li class="acc-row">
          <code>${escapeHtml(e)}</code>
          <button type="button" class="btn btn-danger btn-sm" data-rimuovi-editor="${escapeHtml(e)}">Rimuovi</button>
        </li>`).join('');
      ulE.querySelectorAll('[data-rimuovi-editor]').forEach(btn => {
        btn.addEventListener('click', async () => {
          const email = btn.dataset.rimuoviEditor;
          if (!confirm(`Rimuovere "${email}" dagli editor?`)) return;
          const c = await caricaWhitelist();
          const updated = c.editorEmails.filter(x => x !== email);
          if (await salvaWhitelist({ editorEmails: updated })) {
            await ricaricaCacheRuoli();
            renderListaAccessi();
          }
        });
      });
    }
  }
}

async function aggiungiAccessoEmail(email, ruolo = 'viewer') {
  const cfg = await caricaWhitelist();
  const key = ruolo === 'editor' ? 'editorEmails' : 'viewerEmails';
  if (cfg[key].includes(email)) {
    alert(`Email gia' presente come ${ruolo}.`);
    return;
  }
  const updated = [...cfg[key], email];
  if (await salvaWhitelist({ [key]: updated })) {
    if (ruolo === 'editor') await ricaricaCacheRuoli();
    renderListaAccessi();
  }
}

// ===== TRIGGER WORKFLOW GITHUB ACTIONS DA APP =====

const GH_REPO = 'Izharrose0/my-gantt-app';
const GH_PAT_KEY = 'gantt-app-github-pat';

function chiediPatSeMancante() {
  let pat = (localStorage.getItem(GH_PAT_KEY) || '').trim();
  if (pat) return pat;
  const msg =
    'Per avviare i workflow direttamente dall\'app serve un GitHub Personal Access Token.\n\n' +
    'Crealo qui (link aperto in pagina separata):\n' +
    'https://github.com/settings/tokens/new\n\n' +
    'Scope necessario: "workflow" (classic) oppure Actions:read+write (fine-grained).\n\n' +
    'Il token resta SOLO nel tuo browser (localStorage). Premi Annulla per usare il fallback (apre la pagina di GitHub Actions).';
  pat = window.prompt(msg, '');
  if (!pat) return null;
  pat = pat.trim();
  localStorage.setItem(GH_PAT_KEY, pat);
  return pat;
}

async function ghApi(path, opts = {}) {
  const pat = localStorage.getItem(GH_PAT_KEY);
  return fetch(`https://api.github.com${path}`, {
    ...opts,
    headers: {
      'Authorization': `Bearer ${pat}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(opts.headers || {})
    }
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function triggeraWorkflow(workflowFile, label) {
  const pat = chiediPatSeMancante();
  if (!pat) {
    // Fallback: apri la pagina di GitHub Actions in un'altra tab
    const slug = workflowFile.replace(/\.[^.]+$/, '');
    window.open(`https://github.com/${GH_REPO}/actions/workflows/${workflowFile}`, '_blank', 'noopener');
    return;
  }

  mostraRunBanner(`▶ Avvio "${label}"…`, 'running');
  const triggerTime = new Date(Date.now() - 5000); // 5s di tolleranza

  try {
    // 1. Dispatch
    const dispatchRes = await ghApi(
      `/repos/${GH_REPO}/actions/workflows/${workflowFile}/dispatches`,
      { method: 'POST', body: JSON.stringify({ ref: 'main' }) }
    );
    if (dispatchRes.status === 401 || dispatchRes.status === 403) {
      localStorage.removeItem(GH_PAT_KEY);
      mostraRunBanner('❌ Token non valido o senza permessi. Riprova: il prompt te lo richiederà.', 'error');
      return;
    }
    if (!dispatchRes.ok) {
      const text = await dispatchRes.text().catch(() => '');
      mostraRunBanner(`❌ Dispatch fallito (${dispatchRes.status}): ${text.slice(0, 100)}`, 'error');
      return;
    }

    // 2. Aspetta che il run appaia nell'elenco
    let runId = null, htmlUrl = null;
    for (let i = 0; i < 12; i++) {
      await sleep(2000);
      const r = await ghApi(`/repos/${GH_REPO}/actions/workflows/${workflowFile}/runs?per_page=5`);
      if (!r.ok) continue;
      const data = await r.json();
      const recente = (data.workflow_runs || []).find(x =>
        x.event === 'workflow_dispatch' && new Date(x.created_at) >= triggerTime
      );
      if (recente) { runId = recente.id; htmlUrl = recente.html_url; break; }
      mostraRunBanner(`▶ "${label}" — attendo che il runner avvii il job…`, 'running');
    }
    if (!runId) {
      mostraRunBanner('⚠ Run avviato ma non rilevato. Controlla manualmente su Actions.', 'error');
      return;
    }

    // 3. Polling stato
    while (true) {
      const r = await ghApi(`/repos/${GH_REPO}/actions/runs/${runId}`);
      if (!r.ok) { mostraRunBanner('⚠ Errore lettura stato run', 'error', htmlUrl); return; }
      const data = await r.json();
      const status = data.status;          // queued | in_progress | completed
      const conclusion = data.conclusion;  // success | failure | cancelled | null

      if (status === 'completed') {
        if (conclusion === 'success') {
          mostraRunBanner(`✅ "${label}" completato`, 'success', htmlUrl);
        } else {
          mostraRunBanner(`❌ "${label}" terminato: ${conclusion}`, 'error', htmlUrl);
        }
        return;
      }
      const labelStato = status === 'queued' ? 'in coda' : 'in esecuzione';
      mostraRunBanner(`▶ "${label}" — ${labelStato}…`, 'running', htmlUrl);
      await sleep(3000);
    }
  } catch (e) {
    mostraRunBanner(`💥 Errore: ${e.message}`, 'error');
  }
}

function mostraRunBanner(msg, tipo, url) {
  let el = document.getElementById('run-banner');
  if (!el) {
    el = document.createElement('div');
    el.id = 'run-banner';
    document.body.appendChild(el);
  }
  el.className = `run-banner run-banner-${tipo}`;
  const linkHtml = url
    ? `<a href="${url}" target="_blank" rel="noopener">apri log →</a>`
    : '';
  el.innerHTML = `
    <span class="run-banner-msg">${msg}</span>
    ${linkHtml}
    <button type="button" class="run-banner-close" aria-label="Chiudi">×</button>
  `;
  el.querySelector('.run-banner-close').addEventListener('click', () => el.remove());
  // Auto-rimozione dopo 8s solo per success/error
  if (tipo !== 'running') {
    clearTimeout(el._autoCloseTimer);
    el._autoCloseTimer = setTimeout(() => el.remove(), 12000);
  }
}

// ===== ASSOCIAZIONE PERSONE JIRA ↔ MY-GANTT =====

function apriModaleAssocPersone() {
  renderListaAssocPersone();
  document.getElementById('modal-assoc-persone-overlay').classList.remove('hidden');
}

function renderListaAssocPersone() {
  const cont = document.getElementById('lista-assoc-persone');
  if (!cont) return;
  const persone = stato.persone.slice().sort((a, b) =>
    (a.nome || '').localeCompare(b.nome || ''));
  if (!persone.length) {
    cont.innerHTML = '<li class="empty-state">Nessuna persona registrata.</li>';
    return;
  }
  cont.innerHTML = persone.map(p => {
    const taskCount = stato.task.filter(t =>
      (t.assegnazioni || []).some(a => a.personaId === p.id)
    ).length;
    const daJira = p.jiraAccountId ? 'sì' : 'no';
    const badge = p.jiraAccountId
      ? `<span class="label-fte epica-badge" title="Account Jira: ${escapeHtml(p.jiraAccountId)}">Da Jira</span>`
      : '<span class="label-fte" title="Creata manualmente">Manuale</span>';
    const options = persone
      .filter(x => x.id !== p.id)
      .map(x => `<option value="${x.id}">${escapeHtml(x.nome)} ${x.jiraAccountId ? '(Jira)' : '(manuale)'}</option>`)
      .join('');
    return `
      <li class="assoc-row">
        <div class="assoc-persona">
          ${avatar(p, 'md')}
          <div class="assoc-info">
            <strong>${escapeHtml(p.nome)}</strong>
            <small>${escapeHtml(p.ruolo || '')}${p.email ? ' · ' + escapeHtml(p.email) : ''}</small>
            <small class="assoc-meta">${badge} · Da Jira: ${daJira} · ${taskCount} task assegnati</small>
          </div>
        </div>
        <div class="assoc-azione">
          <label class="hint" style="font-size:0.7rem">Unisci in →</label>
          <select class="assoc-target" data-from-id="${p.id}">
            <option value="">— scegli persona —</option>
            ${options}
          </select>
          <button class="btn btn-secondary btn-sm assoc-confirm" data-from-id="${p.id}" disabled>Unisci</button>
        </div>
      </li>`;
  }).join('');

  cont.querySelectorAll('.assoc-target').forEach(sel => {
    sel.addEventListener('change', () => {
      const btn = cont.querySelector(`.assoc-confirm[data-from-id="${sel.dataset.fromId}"]`);
      if (btn) btn.disabled = !sel.value;
    });
  });
  cont.querySelectorAll('.assoc-confirm').forEach(btn => {
    btn.addEventListener('click', () => {
      const fromId = btn.dataset.fromId;
      const sel = cont.querySelector(`.assoc-target[data-from-id="${fromId}"]`);
      const toId = sel?.value;
      if (!toId || toId === fromId) return;
      const from = trovaPersona(fromId);
      const to   = trovaPersona(toId);
      if (!from || !to) return;
      if (!confirm(`Unire "${from.nome}" dentro "${to.nome}"?\n\nI ${stato.task.filter(t => (t.assegnazioni || []).some(a => a.personaId === fromId)).length} task assegnati verranno spostati su "${to.nome}".\n"${from.nome}" verrà eliminata.`)) return;
      unisciPersone(fromId, toId);
      renderListaAssocPersone();
    });
  });
}

// Unisce la persona `fromId` (verrà rimossa) dentro `toId` (sopravvive).
// Regola: campi vuoti del survivor vengono riempiti dal merged; se entrambi
// hanno un valore, vince il survivor (MY-GANTT prevale su Jira/duplicato).
function unisciPersone(fromId, toId) {
  if (fromId === toId) return;
  const from = stato.persone.find(p => p.id === fromId);
  const to   = stato.persone.find(p => p.id === toId);
  if (!from || !to) return;

  // 1. Merge dei campi: vince il survivor (to), riempiamo solo i suoi vuoti
  const fillIfEmpty = (k) => {
    if ((to[k] === undefined || to[k] === null || to[k] === '' ||
         (typeof to[k] === 'number' && !to[k])) && from[k] !== undefined && from[k] !== null && from[k] !== '') {
      to[k] = from[k];
    }
  };
  fillIfEmpty('email');
  fillIfEmpty('jiraAccountId');
  fillIfEmpty('ruolo');
  fillIfEmpty('costoOrario');
  // Ferie: union (entrambi possono aver registrato assenze valide)
  const ferieTo   = Array.isArray(to.ferie)   ? to.ferie   : [];
  const ferieFrom = Array.isArray(from.ferie) ? from.ferie : [];
  const ferieMap = new Map();
  [...ferieTo, ...ferieFrom].forEach(f => {
    if (f && f.inizio && f.fine) ferieMap.set(`${f.inizio}|${f.fine}`, f);
  });
  to.ferie = Array.from(ferieMap.values());

  // 2. Ricolloca tutti i riferimenti nelle assegnazioni task
  stato.task.forEach(t => {
    if (!Array.isArray(t.assegnazioni)) return;
    // Trova se il task era assegnato a entrambi: somma gli effort, deduplica
    const fromIdx = t.assegnazioni.findIndex(a => a.personaId === fromId);
    if (fromIdx === -1) return;
    const fromEffort = Number(t.assegnazioni[fromIdx].effort) || 0;
    const toAss = t.assegnazioni.find(a => a.personaId === toId);
    if (toAss) {
      toAss.effort = Math.min(100, (Number(toAss.effort) || 0) + fromEffort);
      t.assegnazioni.splice(fromIdx, 1);
    } else {
      t.assegnazioni[fromIdx].personaId = toId;
    }
  });

  // 3. Rimuovi la persona "from"
  stato.persone = stato.persone.filter(p => p.id !== fromId);

  salvaStato();
  aggiornaViste();
}

// ===== GESTIONE VISIBILITÀ EPICHE =====

function apriModaleVisibilita() {
  renderListaVisibilita();
  document.getElementById('modal-visibilita-overlay').classList.remove('hidden');
}

function setVisibilitaTutte(nascosta) {
  stato.task.forEach(t => {
    if (t.tipo === 'epica') t.nascosta = nascosta;
  });
  salvaStato();
  renderListaVisibilita();
  aggiornaViste();
}

function renderListaVisibilita() {
  const cont = document.getElementById('lista-visibilita-epiche');
  if (!cont) return;
  const epiche = stato.task.filter(t => t.tipo === 'epica');
  if (!epiche.length) {
    cont.innerHTML = '<li class="empty-state">Nessuna epica trovata.</li>';
    return;
  }

  // Raggruppa per jiraProject (con sezione "Manuali" per le epiche senza progetto)
  const gruppi = new Map();
  epiche.forEach(e => {
    const key = e.jiraProject || (e.jiraKey ? String(e.jiraKey).split('-')[0] : '__manual__');
    if (!gruppi.has(key)) gruppi.set(key, []);
    gruppi.get(key).push(e);
  });
  // Ordina: prima i progetti Jira alfabetici, poi "Manuali" in fondo
  const ordineGruppi = [...gruppi.keys()].sort((a, b) => {
    if (a === '__manual__') return 1;
    if (b === '__manual__') return -1;
    return a.localeCompare(b);
  });

  const sezioni = ordineGruppi.map(groupKey => {
    const lista = gruppi.get(groupKey).sort((a, b) => (a.nome || '').localeCompare(b.nome || ''));
    const visibili = lista.filter(e => !e.nascosta).length;
    const titolo = groupKey === '__manual__'
      ? `Manuali (${visibili}/${lista.length})`
      : `${groupKey} — Jira (${visibili}/${lista.length})`;
    const righe = lista.map(e => {
      const figli = stato.task.filter(t => t.parentId === e.id).length;
      const visibile = !e.nascosta;
      const badge = e.jiraKey
        ? `<span class="label-fte epica-badge" title="Importata da Jira">${escapeHtml(e.jiraKey)}</span>`
        : '<span class="label-fte" title="Creata manualmente">manuale</span>';
      return `
        <li class="vis-row${visibile ? '' : ' vis-hidden'}">
          <label class="vis-toggle">
            <input type="checkbox" data-vis-id="${e.id}" ${visibile ? 'checked' : ''}>
            <span class="vis-name">${escapeHtml(e.nome)}</span>
            ${badge}
            <span class="label-fte" title="Numero figli diretti">${figli} task</span>
          </label>
        </li>`;
    }).join('');
    return `
      <li class="vis-group">
        <details ${visibili < lista.length ? '' : 'open'}>
          <summary>
            <strong>${escapeHtml(titolo)}</strong>
            <span class="vis-group-actions">
              <button type="button" class="btn btn-secondary btn-sm" data-gruppo-tutti="${escapeHtml(groupKey)}">Tutti</button>
              <button type="button" class="btn btn-secondary btn-sm" data-gruppo-nessuno="${escapeHtml(groupKey)}">Nessuno</button>
            </span>
          </summary>
          <ul class="vis-sublist">${righe}</ul>
        </details>
      </li>`;
  }).join('');
  cont.innerHTML = sezioni;

  // Toggle singolo
  cont.querySelectorAll('input[data-vis-id]').forEach(cb => {
    cb.addEventListener('change', () => {
      const t = stato.task.find(x => x.id === cb.dataset.visId);
      if (!t) return;
      t.nascosta = !cb.checked;
      cb.closest('.vis-row')?.classList.toggle('vis-hidden', !cb.checked);
      salvaStato();
      aggiornaViste();
    });
  });
  // Bulk per gruppo
  cont.querySelectorAll('[data-gruppo-tutti]').forEach(b => {
    b.addEventListener('click', e => { e.preventDefault(); bulkVisibilitaGruppo(b.dataset.gruppoTutti, true); });
  });
  cont.querySelectorAll('[data-gruppo-nessuno]').forEach(b => {
    b.addEventListener('click', e => { e.preventDefault(); bulkVisibilitaGruppo(b.dataset.gruppoNessuno, false); });
  });
}

function bulkVisibilitaGruppo(groupKey, visibili) {
  stato.task.forEach(t => {
    if (t.tipo !== 'epica') return;
    const key = t.jiraProject || (t.jiraKey ? String(t.jiraKey).split('-')[0] : '__manual__');
    if (key !== groupKey) return;
    t.nascosta = !visibili;
  });
  salvaStato();
  renderListaVisibilita();
  aggiornaViste();
}

// ID del task in modifica nel modal
let taskInModifica = null;

// View mode corrente del Gantt: 'Day' | 'Week' | 'Month'
let viewModeCorrente = 'Week';

// Pixel per giorno per ciascuna view mode
const GANTT_DAY_W = { Day: 40, Week: 22, Month: 7 };

// Calcola dayW effettivo: lo zoom è un MINIMO. Se la timeline non riempie il
// container, allarghiamo i giorni per evitare whitespace a destra.
function calcolaDayWAdattivo(containerId, sideWidthApprox, giorniLen) {
  const baseDayW = GANTT_DAY_W[viewModeCorrente] || 22;
  const cont = document.getElementById(containerId);
  if (!cont || !giorniLen) return baseDayW;
  // Side column nascosta su mobile (≤900px): timeline a tutto schermo.
  // Sopra i 900px è più stretta che sul desktop standard.
  const w = window.innerWidth;
  const effectiveSide = w <= 900 ? 0 : sideWidthApprox;
  const disponibile = cont.clientWidth - effectiveSide - 4;
  if (disponibile <= 0) return baseDayW;
  const fitWidth = Math.floor(disponibile / giorniLen);
  // Su mobile: ENTRA tutta la timeline nel viewport (anche restringendo i
  // giorni sotto il minimo della view mode). Niente scroll orizzontale e
  // l'utente vede l'intero arco temporale a colpo d'occhio.
  if (w <= 900) {
    return Math.max(2, fitWidth);
  }
  return Math.max(baseDayW, fitWidth);
}

// Set di epiche collassate nel Gantt (transiente, non persistito)
let epicheCollassate = new Set();
// Set di progetti Jira collassati nel Gantt (header sezione)
let progettiCollassati = new Set();
// Flag che indica se abbiamo già fatto la collapse iniziale di tutte le epiche
let collassoInizialeFatto = false;

// Chiave di raggruppamento progetto per un task (epica)
// Ordine: t.jiraProject -> prefisso jiraKey -> "__manual__"
function chiaveProgetto(t) {
  if (t.jiraProject) return t.jiraProject;
  if (t.jiraKey) return String(t.jiraKey).split('-')[0];
  return '__manual__';
}
function etichettaProgetto(key) {
  return key === '__manual__' ? 'Manuali' : key;
}

// All'avvio chiudi tutte le epiche esistenti
function collassaTutteEpicheInizialmente() {
  if (collassoInizialeFatto) return;
  stato.task.forEach(t => {
    if (t.tipo === 'epica') epicheCollassate.add(t.id);
  });
  collassoInizialeFatto = true;
}

// Filtri (per vista). Persistiti in localStorage per sopravvivere ai reload.
let filtri = {
  gantt:      { persone: [], stati: [], epiche: [], progetti: [], epica: '', progetto: '', team: '', dataDa: '', dataA: '' },
  workload:   { persone: [], stati: [], epiche: [], progetti: [], epica: '', progetto: '', team: '', dataDa: '', dataA: '' },
  eisenhower: { persone: [], stati: [], epiche: [], progetti: [], epica: '', progetto: '', team: '', dataDa: '', dataA: '' }
};

const FILTRI_STORAGE_KEY = 'mygantt:filtri:v1';

function caricaFiltriLocale() {
  try {
    const raw = localStorage.getItem(FILTRI_STORAGE_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    if (!saved || typeof saved !== 'object') return;
    ['gantt','workload','eisenhower'].forEach(v => {
      if (saved[v] && typeof saved[v] === 'object') {
        Object.assign(filtri[v], saved[v]);
      }
    });
  } catch {}
}

function salvaFiltriLocale() {
  try { localStorage.setItem(FILTRI_STORAGE_KEY, JSON.stringify(filtri)); } catch {}
}

// Garantisce array epiche/progetti (migrazione da singoli) per ogni vista
function migrazioneFiltri() {
  ['gantt','workload','eisenhower'].forEach(v => {
    const f = filtri[v];
    if (!Array.isArray(f.epiche))   f.epiche   = f.epica   ? [f.epica]   : [];
    if (!Array.isArray(f.progetti)) f.progetti = f.progetto ? [f.progetto] : [];
  });
}
caricaFiltriLocale();
migrazioneFiltri();

// Modalità della matrice di Eisenhower: 'epiche' (default) | 'task' | 'tutti'
let eisenModo = 'epiche';

// Popola la tendina "Progetto" nella toolbar Eisenhower con i progetti
// effettivamente presenti nei dati. Mantiene la selezione corrente.
function popolaSelectProgettoEisen() {
  const sel = document.getElementById('eisen-progetto-select');
  if (!sel) return;
  const progetti = progettiPresenti();
  const current = filtri.eisenhower.progetto || '';
  sel.innerHTML = `<option value="">— Tutti —</option>` + progetti
    .map(p => `<option value="${escapeHtml(p)}" ${current === p ? 'selected' : ''}>${escapeHtml(p)}</option>`)
    .join('');
}

// Helper: formato ISO YYYY-MM-DD
function _fmtISODate(d) {
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Range di default per il Gantt: primo giorno del mese precedente
// → ultimo giorno del mese successivo (rispetto a oggi)
function rangeFiltroDefault() {
  const oggi = new Date();
  const inizio = new Date(oggi.getFullYear(), oggi.getMonth() - 1, 1);
  const fine   = new Date(oggi.getFullYear(), oggi.getMonth() + 2, 0);
  return { dataDa: _fmtISODate(inizio), dataA: _fmtISODate(fine) };
}

// Range di default per il Workload: settimana precedente + settimana corrente
// + 2 settimane successive (4 settimane totali, sempre dal lunedì al venerdì o domenica)
function rangeFiltroDefaultWorkload() {
  const oggi = new Date();
  // Lunedì della settimana corrente
  const giorno = oggi.getDay(); // 0=dom, 1=lun, ..., 6=sab
  const offsetLun = giorno === 0 ? -6 : 1 - giorno;
  const lunCorrente = new Date(oggi);
  lunCorrente.setDate(oggi.getDate() + offsetLun);
  // Inizio: lunedì della settimana precedente
  const inizio = new Date(lunCorrente);
  inizio.setDate(lunCorrente.getDate() - 7);
  // Fine: domenica fra 2 settimane (settimana corrente + 2 successive)
  const fine = new Date(lunCorrente);
  fine.setDate(lunCorrente.getDate() + 20); // lun + 20 = domenica della 3a settimana successiva
  return { dataDa: _fmtISODate(inizio), dataA: _fmtISODate(fine) };
}

// Restituisce il range di default per ciascuna vista
function rangeFiltroDefaultPerVista(vista) {
  if (vista === 'workload') return rangeFiltroDefaultWorkload();
  return rangeFiltroDefault();
}

function rerenderVista(vista) {
  salvaFiltriLocale();
  if (vista === 'gantt') renderGantt();
  else if (vista === 'workload') renderWorkload();
  else if (vista === 'eisenhower') renderEisenhower();
}

// Apre il dialog di stampa del browser (l'utente può salvare come PDF)
// ===== REPORT SETTIMANALE =====

// Restituisce {lun, ven} ISO della settimana corrente (lun-ven)
function settimanaCorrenteLunVen() {
  const oggi = new Date();
  const giorno = oggi.getDay(); // 0=dom, 1=lun, ..., 6=sab
  const lunOffset = giorno === 0 ? -6 : 1 - giorno;
  const lun = new Date(oggi);
  lun.setDate(oggi.getDate() + lunOffset);
  const ven = new Date(lun);
  ven.setDate(lun.getDate() + 4);
  return { lun: dataISO(lun), ven: dataISO(ven) };
}

// Calcola allocazione per persona nel range: [{persona, totaleH, items:[{taskNome, ore, giorni}]}]
function calcolaAllocazioniPeriodo(dataDa, dataA) {
  const out = [];
  const giorniRange = rangeDateISO(dataDa, dataA);
  stato.persone.forEach(p => {
    const items = [];
    let totaleH = 0;
    stato.task.forEach(t => {
      if (t.tipo === 'epica' || t.tipo === 'milestone') return;
      if (t.stato === 'done') return;
      if (!t.assegnazioni?.length) return;
      const oreTask = oreResidueTask(t);
      if (!oreTask) return;
      const a = t.assegnazioni.find(x => x.personaId === p.id);
      if (!a) return;
      // Date effettive (ereditate dal parent se mancanti)
      const { inizio: tInizio, fine: tFine } = dateEffettive(t);
      if (!tInizio || !tFine) return;
      // Intersezione tra range richiesto e durata task
      const inizioInt = tInizio > dataDa ? tInizio : dataDa;
      const fineInt = tFine < dataA ? tFine : dataA;
      if (inizioInt > fineInt) return;
      const giorniInter = rangeDateISO(inizioInt, fineInt);
      // Quanti giorni LAVORATIVI di p nel periodo sono coperti dal task
      const giorniEffettivi = giorniInter.filter(g => eGiornoLavorativo(g, p.id)).length;
      if (!giorniEffettivi) return;
      const orePerGiorno = oreGiornaliereAssegnazione(t, a);
      const oreTotali = orePerGiorno * giorniEffettivi;
      totaleH += oreTotali;
      items.push({ taskNome: t.nome, ore: oreTotali, giorni: giorniEffettivi, taskId: t.id });
    });
    items.sort((x, y) => y.ore - x.ore);
    out.push({ persona: p, totaleH, items });
  });
  return out;
}

function renderReportSettimana() {
  const da = document.getElementById('report-data-da').value;
  const a  = document.getElementById('report-data-a').value;
  const body = document.getElementById('report-body');
  if (!da || !a || da > a) {
    body.innerHTML = '<p class="empty-state">Seleziona un intervallo di date valido.</p>';
    return;
  }
  const allocazioni = calcolaAllocazioniPeriodo(da, a)
    // Escludi persone nascoste (modal "Gestisci visibilità persone")
    .filter(({ persona }) => !persona.nascosta)
    // Escludi persone senza allocazione nel periodo
    .filter(({ totaleH }) => totaleH > 0);

  const ggLavRange = giorniLavorativi(da, a);

  // Raggruppa per team (con sezione "Non assegnati" in fondo)
  const teamOrd = new Map((stato.team || []).map(t => [t.id, t]));
  const gruppi = new Map(); // teamId → [{persona, totaleH, items}]
  allocazioni.forEach(a => {
    const tid = a.persona.teamId || '__unassigned__';
    if (!gruppi.has(tid)) gruppi.set(tid, []);
    gruppi.get(tid).push(a);
  });
  const ordineGruppi = [...gruppi.keys()].sort((a, b) => {
    if (a === '__unassigned__') return 1;
    if (b === '__unassigned__') return -1;
    const oa = teamOrd.get(a)?.ordine ?? 999;
    const ob = teamOrd.get(b)?.ordine ?? 999;
    return oa - ob;
  });

  // Funzione per rendere una riga persona
  function rigaPersona({ persona: p, totaleH, items }) {
    const ggLavPersona = giorniLavorativi(da, a, p.id);
    const capacita = ggLavPersona * ORE_GIORNO_PIENE * p.fte;
    const perc = capacita > 0 ? Math.round(totaleH / capacita * 100) : 0;
    const cls = perc > 100 ? 'over' : perc >= 80 ? 'warn' : perc > 0 ? 'ok' : 'zero';
    const itemsConOre = items.filter(it => it.ore > 0);

    const orPerProg = {};
    itemsConOre.forEach(it => {
      const task = stato.task.find(t => t.id === it.taskId);
      const proj = task?.jiraProject || 'Manuale';
      orPerProg[proj] = (orPerProg[proj] || 0) + it.ore;
    });
    const progettiAlloc = Object.entries(orPerProg)
      .sort((a, b) => b[1] - a[1])
      .map(([proj, ore]) => {
        const pct = totaleH > 0 ? Math.round(ore / totaleH * 100) : 0;
        return `<span class="report-proj-badge">${escapeHtml(proj)} ${pct}%</span>`;
      }).join(' ');

    const taskList = itemsConOre.map(it =>
      `<div class="report-task-item">${escapeHtml(it.taskNome)} — <strong>${it.ore.toFixed(1)}h</strong> <small>(${it.giorni} gg)</small></div>`
    ).join('');

    return `
      <tr>
        <td>
          <span class="badge-colore" style="background:${escapeHtml(p.colore)}"></span>
          <strong>${escapeHtml(p.nome)}</strong><br>
          <small style="color:#64748b">${escapeHtml(p.ruolo)} · FTE ${p.fte}</small>
        </td>
        <td><strong>${capacita.toFixed(0)}h</strong><br><small>${ggLavPersona} gg</small></td>
        <td><strong>${totaleH.toFixed(1)}h</strong></td>
        <td><span class="report-perc ${cls}">${perc}%</span></td>
        <td class="report-proj-cell">${progettiAlloc || '—'}</td>
        <td class="report-task-cell">${taskList}</td>
      </tr>`;
  }

  // Genera le righe raggruppate per team
  const righe = ordineGruppi.map(tid => {
    const tm = teamOrd.get(tid);
    const teamNome = tm ? tm.nome : 'Non assegnati';
    const teamColore = tm ? tm.colore : '#64748b';
    const membri = gruppi.get(tid);
    const teamH = membri.reduce((s, a) => s + a.totaleH, 0);
    return `
      <tr class="report-team-header">
        <td colspan="6">
          <span style="display:inline-block;width:12px;height:12px;border-radius:3px;background:${escapeHtml(teamColore)};vertical-align:middle;margin-right:6px"></span>
          <strong>${escapeHtml(teamNome)}</strong>
          <small style="color:#94a3b8;margin-left:8px">${membri.length} persone · ${teamH.toFixed(1)}h totali</small>
        </td>
      </tr>
      ${membri.map(rigaPersona).join('')}`;
  }).join('');

  body.innerHTML = `
    <p class="hint">Allocazioni dal <strong>${formatDataBreve(da)}</strong> al <strong>${formatDataBreve(a)}</strong>
       (${ggLavRange} giorni lavorativi). Mostrando solo persone con allocazione &gt; 0.</p>
    <table class="report-tabella">
      <thead>
        <tr>
          <th>Persona</th>
          <th>Capacità</th>
          <th>Allocate</th>
          <th>Carico</th>
          <th>% Progetto</th>
          <th>Task assegnati</th>
        </tr>
      </thead>
      <tbody>${righe}</tbody>
    </table>
  `;
}

function apriModaleReport() {
  const { lun, ven } = settimanaCorrenteLunVen();
  const da = document.getElementById('report-data-da');
  const a  = document.getElementById('report-data-a');
  if (!da.value) da.value = lun;
  if (!a.value)  a.value  = ven;
  document.getElementById('modal-report-overlay').classList.remove('hidden');
  renderReportSettimana();
}

function chiudiModaleReport() {
  document.getElementById('modal-report-overlay').classList.add('hidden');
}

function esportaReportCSV() {
  const da = document.getElementById('report-data-da').value;
  const a  = document.getElementById('report-data-a').value;
  if (!da || !a) return;
  const allocazioni = calcolaAllocazioniPeriodo(da, a);

  // Una riga per ogni (persona, task). Più una riga totale per persona.
  const righe = [['Persona', 'Ruolo', 'FTE', 'Task', 'Ore', 'Giorni']];
  allocazioni.forEach(({ persona: p, totaleH, items }) => {
    if (!items.length) {
      righe.push([p.nome, p.ruolo, p.fte, '(nessuno)', 0, 0]);
    } else {
      items.forEach(it => righe.push([p.nome, p.ruolo, p.fte, it.taskNome, it.ore.toFixed(2), it.giorni]));
      righe.push([p.nome, p.ruolo, p.fte, 'TOTALE', totaleH.toFixed(2), '']);
    }
  });

  const csv = righe.map(r =>
    r.map(c => {
      const s = String(c ?? '');
      return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    }).join(';')
  ).join('\n');

  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `report-${da}-${a}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

function stampaReport() {
  const da = document.getElementById('report-data-da').value;
  const a  = document.getElementById('report-data-a').value;
  // Cambia il titolo della pagina per il nome del PDF
  const titoloOriginale = document.title;
  document.title = `MY-GANTT_Report_${da}_${a}`;
  document.body.setAttribute('data-printing', 'report');
  document.body.setAttribute('data-printing-titolo', `Report — ${da} → ${a}`);
  setTimeout(() => {
    window.print();
    setTimeout(() => {
      document.body.removeAttribute('data-printing');
      document.body.removeAttribute('data-printing-titolo');
      document.title = titoloOriginale;
    }, 200);
  }, 100);
}

// ===== EXPORT GANTT: helpers (lazy-load librerie CDN) =====
async function caricaHtml2Canvas() {
  if (window.html2canvas) return window.html2canvas;
  await new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js';
    s.onload = res;
    s.onerror = () => rej(new Error('Impossibile caricare html2canvas'));
    document.head.appendChild(s);
  });
  if (!window.html2canvas) throw new Error('html2canvas non disponibile');
  return window.html2canvas;
}

async function caricaJsPDF() {
  if (window.jspdf?.jsPDF) return window.jspdf.jsPDF;
  await new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js';
    s.onload = res;
    s.onerror = () => rej(new Error('Impossibile caricare jsPDF'));
    document.head.appendChild(s);
  });
  if (!window.jspdf?.jsPDF) throw new Error('jsPDF non disponibile');
  return window.jspdf.jsPDF;
}

// Cattura il #gantt-container con html2canvas espandendo l'intera timeline
// (rimuove temporaneamente max-height/overflow). Ritaglia in altezza a fine
// ultima riga della side column per evitare lo sfondo scuro vuoto. Usata da
// PNG e PDF.
async function catturaGanttCanvas() {
  const cont = document.getElementById('gantt-container');
  if (!cont) return null;
  const h2c = await caricaHtml2Canvas();
  const oldOverflow = cont.style.overflow;
  const oldMaxH = cont.style.maxHeight;
  const oldMinH = cont.style.minHeight;
  const oldH = cont.style.height;
  cont.style.overflow = 'visible';
  cont.style.maxHeight = 'none';
  cont.style.minHeight = 'auto';
  cont.style.height = 'auto';
  await new Promise(r => requestAnimationFrame(r));
  await new Promise(r => requestAnimationFrame(r));
  const fullW = cont.scrollWidth;
  const fullH = cont.scrollHeight;
  // Altezza reale del contenuto = bottom dell'ultima riga della side column.
  // Necessario perche' la timeline ha sfondo scuro che si estende oltre le
  // righe quando il container ha min-height impostato.
  let captureH = fullH;
  const sideRows = cont.querySelectorAll('.gantt-side .gantt-side-row');
  if (sideRows.length > 0) {
    const lastRow = sideRows[sideRows.length - 1];
    const contRect = cont.getBoundingClientRect();
    const lastRect = lastRow.getBoundingClientRect();
    const bottom = lastRect.bottom - contRect.top;
    if (bottom > 0 && bottom < captureH) captureH = Math.ceil(bottom);
  }
  const bg = getComputedStyle(document.body).backgroundColor || '#0b1220';
  try {
    return await h2c(cont, {
      backgroundColor: bg,
      scale: window.devicePixelRatio > 1 ? 2 : 1.5,
      useCORS: true,
      windowWidth: fullW,
      windowHeight: captureH,
      width: fullW,
      height: captureH,
      scrollX: 0,
      scrollY: 0
    });
  } finally {
    cont.style.overflow = oldOverflow;
    cont.style.maxHeight = oldMaxH;
    cont.style.minHeight = oldMinH;
    cont.style.height = oldH;
  }
}

async function esportaGanttPNG() {
  try {
    const canvas = await catturaGanttCanvas();
    if (!canvas) return;
    canvas.toBlob(blob => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `gantt-${dataISOoggi()}.png`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }, 'image/png');
  } catch (err) {
    alert('Errore export PNG: ' + (err?.message || err));
  }
}

// Export PDF A4 landscape.
// - Se il Gantt entra in una pagina sola (scala leggibile) -> pagina unica
//   con tutto il canvas centrato.
// - Altrimenti -> paginazione orizzontale con side column (Task) ripetuta
//   su ogni pagina come riferimento righe.
async function esportaGanttPDF() {
  try {
    const canvas = await catturaGanttCanvas();
    if (!canvas) return;
    const jsPDF = await caricaJsPDF();
    const pdf = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' });
    const pageW = pdf.internal.pageSize.getWidth();   // 841.89
    const pageH = pdf.internal.pageSize.getHeight();  // 595.28
    const margin = 24;
    const titleH = 22;
    const contentW = pageW - 2 * margin;
    const contentH = pageH - 2 * margin - titleH;

    const cw = canvas.width;
    const ch = canvas.height;
    const sideEl = document.querySelector('.gantt-side');
    const cont   = document.getElementById('gantt-container');
    const sideRatio = (sideEl && cont) ? sideEl.offsetWidth / cont.scrollWidth : 0.18;
    const sideWpx = Math.round(cw * sideRatio);
    const timelineCanvasWpx = cw - sideWpx;

    // Titolo (solo ASCII: helvetica embedded non supporta unicode arrow/em-dash)
    const f = filtri.gantt;
    const range = calcolaRangeGantt(f);
    const da = f.dataDa || range?.min || '';
    const aISO = f.dataA || range?.max || '';
    const fmt = iso => iso ? `${iso.slice(8,10)}/${iso.slice(5,7)}/${iso.slice(0,4)}` : '';
    const titoloBase = (da && aISO) ? `Gantt  ${fmt(da)}  -  ${fmt(aISO)}` : 'Gantt';

    // Scala single-page: fit-to-fit (rispetta aspect ratio del canvas)
    const singleScale = Math.min(contentW / cw, contentH / ch);
    // Soglia leggibilita': se la riga finale ha < ~10pt non e' leggibile
    const numRowsApprox = Math.max(1, sideEl ? sideEl.querySelectorAll('.gantt-side-row').length : 8);
    const rowHptSingle = (ch / numRowsApprox) * singleScale;
    const singlePage = rowHptSingle >= 10 && singleScale > 0;

    pdf.setFontSize(12);
    pdf.setTextColor(15, 23, 42);

    if (singlePage) {
      const wOnPage = cw * singleScale;
      const hOnPage = ch * singleScale;
      const xOff = margin + (contentW - wOnPage) / 2;
      const yOff = margin + titleH;
      pdf.text(titoloBase, margin, margin + 14);
      pdf.addImage(canvas.toDataURL('image/png'), 'PNG', xOff, yOff, wOnPage, hOnPage);
    } else {
      // Multi-page orizzontale: scala riempie l'altezza, side column max 28%
      let scale = contentH / ch;
      const maxSideWonPage = contentW * 0.28;
      const maxScalePerSide = maxSideWonPage / sideWpx;
      if (scale > maxScalePerSide) scale = maxScalePerSide;
      if (scale > 4) scale = 4;
      if (scale < 0.15) scale = 0.15;

      const sideWonPage = sideWpx * scale;
      const canvasHonPage = ch * scale;
      const timelineWonPagePt = Math.max(40, contentW - sideWonPage);
      const timelineCanvasWPerPagePx = timelineWonPagePt / scale;
      const pages = Math.max(1, Math.ceil(timelineCanvasWpx / timelineCanvasWPerPagePx));

      // Pre-renderizza la side column (riutilizzata su ogni pagina)
      const sideCanvas = document.createElement('canvas');
      sideCanvas.width = sideWpx;
      sideCanvas.height = ch;
      sideCanvas.getContext('2d').drawImage(canvas, 0, 0, sideWpx, ch, 0, 0, sideWpx, ch);
      const sideDataUrl = sideCanvas.toDataURL('image/png');

      for (let p = 0; p < pages; p++) {
        if (p > 0) pdf.addPage();
        const tit = `${titoloBase}   pag ${p + 1} / ${pages}`;
        pdf.text(tit, margin, margin + 14);
        pdf.addImage(sideDataUrl, 'PNG', margin, margin + titleH, sideWonPage, canvasHonPage);
        const tStartPx = p * timelineCanvasWPerPagePx;
        const tWpx = Math.min(timelineCanvasWPerPagePx, timelineCanvasWpx - tStartPx);
        if (tWpx > 0) {
          const sliceC = document.createElement('canvas');
          sliceC.width = Math.ceil(tWpx);
          sliceC.height = ch;
          sliceC.getContext('2d').drawImage(
            canvas,
            sideWpx + tStartPx, 0, tWpx, ch,
            0, 0, tWpx, ch
          );
          pdf.addImage(
            sliceC.toDataURL('image/png'),
            'PNG',
            margin + sideWonPage,
            margin + titleH,
            tWpx * scale,
            canvasHonPage
          );
        }
      }
    }
    pdf.save(`gantt-${dataISOoggi()}.pdf`);
  } catch (err) {
    alert('Errore export PDF: ' + (err?.message || err));
  }
}

// ===== EXPORT GANTT: CSV dei task filtrati =====
function esportaGanttCSV() {
  const ammessi = taskAmmessi(filtri.gantt);
  const items = ordineGerarchicoTask(false, ammessi, true);
  const rows = [['Progetto','Tipo','Livello','ID Jira','Nome','Stato','Inizio','Fine','Ore stimate','Assegnati']];
  items.forEach(({ task: t, livello }) => {
    const progetto = etichettaProgetto(chiaveProgetto(t));
    const tipo = t.tipo || '';
    const jiraKey = t.jiraKey || '';
    const nome = t.nome || '';
    const stato_ = t.stato || '';
    const { inizio, fine } = dateEffettive(t);
    const ore = stimaOreEffettiva(t);
    const ass = (t.assegnazioni || [])
      .map(a => { const p = trovaPersona(a.personaId); return p ? `${p.nome} (${a.effort}%)` : ''; })
      .filter(Boolean)
      .join(' · ');
    rows.push([progetto, tipo, livello, jiraKey, nome, stato_, inizio || '', fine || '', ore, ass]);
  });
  // CSV: separa con ; (Excel italiano), quote i campi
  const csv = rows.map(r => r.map(c => {
    const s = String(c == null ? '' : c).replace(/"/g, '""');
    return `"${s}"`;
  }).join(';')).join('\r\n');
  // BOM per Excel
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `gantt-${dataISOoggi()}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function stampaVista(vista) {
  // Assicura che la vista sia attiva e renderizzata col filtro corrente
  attivaTab(vista);
  // Compone un titolo "Gantt — 01/05/2026 → 30/06/2026"
  const f = filtri[vista] || {};
  const range = calcolaRangeGantt(f);
  const da = f.dataDa || range?.min || '';
  const a  = f.dataA  || range?.max || '';
  const nomeVista = vista === 'gantt' ? 'Gantt' : 'Workload';
  const fmt = iso => iso ? `${iso.slice(8,10)}/${iso.slice(5,7)}/${iso.slice(0,4)}` : '';
  const titolo = (da && a)
    ? `${nomeVista} — ${fmt(da)} → ${fmt(a)}`
    : nomeVista;
  document.body.setAttribute('data-printing', vista);
  document.body.setAttribute('data-printing-titolo', titolo);
  setTimeout(() => {
    window.print();
    setTimeout(() => {
      document.body.removeAttribute('data-printing');
      document.body.removeAttribute('data-printing-titolo');
    }, 100);
  }, 100);
}

// Popola le option dei select-filtro (persone + epiche) per entrambe le viste
// ===== BOTTOM SHEET FILTRI (mobile) =====

function vistaAttiva() {
  return document.querySelector('.tab.active')?.dataset.tab || 'gantt';
}

function contaFiltriAttivi(view) {
  const f = filtri[view];
  if (!f) return 0;
  let n = 0;
  if (f.persone?.length) n++;
  if (f.stati?.length)   n++;
  if ((f.epiche?.length) || f.epica)       n++;
  if ((f.progetti?.length) || f.progetto)  n++;
  if (f.team)             n++;
  if (f.dataDa || f.dataA) n++;
  return n;
}

function aggiornaBadgeFiltri() {
  const view = vistaAttiva();

  // Badge nel bottone della bottom bar (mobile)
  const badgeMobile = document.getElementById('bb-badge-filtri');
  if (badgeMobile) {
    if (view !== 'gantt' && view !== 'workload') {
      badgeMobile.classList.add('hidden');
    } else {
      const n = contaFiltriAttivi(view);
      if (n > 0) { badgeMobile.textContent = n; badgeMobile.classList.remove('hidden'); }
      else        { badgeMobile.classList.add('hidden'); }
    }
  }

  // Badge nei chip "Filtri" della toolbar (desktop)
  document.querySelectorAll('.btn-filtri-toggle').forEach(btn => {
    const v = btn.dataset.viewToggle;
    const b = btn.querySelector('.filtri-badge');
    if (!b) return;
    const n = contaFiltriAttivi(v);
    if (n > 0) {
      b.textContent = n;
      b.classList.remove('hidden');
      btn.classList.add('active');
    } else {
      b.classList.add('hidden');
      btn.classList.remove('active');
    }
  });
}

function resetFiltri(view) {
  filtri[view] = { persone: [], stati: [], epica: '', dataDa: '', dataA: '' };
  popolaFiltri();
  if (view === 'gantt')    renderGantt();
  if (view === 'workload') renderWorkload();
}

function apriBottomSheetFiltri() {
  const view = vistaAttiva();
  if (view !== 'gantt' && view !== 'workload') {
    alert('I filtri sono disponibili solo nelle viste Gantt e Workload.');
    return;
  }
  const f = filtri[view];
  const body = document.getElementById('bs-filtri-body');
  const epiche = stato.task.filter(t => t.tipo === 'epica');
  const persSel = new Set(f.persone || []);
  const statiSel = new Set(f.stati || []);

  body.innerHTML = `
    <div class="filter-item">
      <label>Persone</label>
      <select class="bs-filter-persone" multiple size="6">
        ${stato.persone.map(p =>
          `<option value="${p.id}" ${persSel.has(p.id) ? 'selected' : ''}>${escapeHtml(p.nome)}</option>`
        ).join('')}
      </select>
    </div>
    <div class="filter-item">
      <label>Stato</label>
      <select class="bs-filter-stato" multiple size="4">
        <option value="todo" ${statiSel.has('todo') ? 'selected' : ''}>To Do</option>
        <option value="in-progress" ${statiSel.has('in-progress') ? 'selected' : ''}>In Progress</option>
        <option value="done" ${statiSel.has('done') ? 'selected' : ''}>Done</option>
        <option value="blocked" ${statiSel.has('blocked') ? 'selected' : ''}>Blocked</option>
      </select>
    </div>
    <div class="filter-item">
      <label>Epica</label>
      <select class="bs-filter-epica">
        <option value="">— Tutte —</option>
        ${epiche.map(e => `<option value="${e.id}" ${f.epica === e.id ? 'selected' : ''}>${escapeHtml(e.nome)}</option>`).join('')}
      </select>
    </div>
    <div class="filter-item">
      <label>Dal</label>
      <input type="date" class="bs-filter-data-da" value="${f.dataDa || ''}">
    </div>
    <div class="filter-item">
      <label>Al</label>
      <input type="date" class="bs-filter-data-a" value="${f.dataA || ''}">
    </div>
    <div style="display:flex; gap:0.5rem; margin-top:0.5rem">
      <button type="button" class="btn btn-secondary" id="bs-reset" style="flex:1">Reset</button>
      <button type="button" class="btn btn-primary" id="bs-applica" style="flex:1">Applica</button>
    </div>
  `;

  document.getElementById('bottom-sheet-filtri').classList.remove('hidden');

  body.querySelector('#bs-reset').addEventListener('click', () => {
    resetFiltri(view);
    chiudiBottomSheet();
    aggiornaBadgeFiltri();
  });
  body.querySelector('#bs-applica').addEventListener('click', () => {
    const epicaSel = body.querySelector('.bs-filter-epica').value;
    filtri[view] = {
      persone:  Array.from(body.querySelector('.bs-filter-persone').selectedOptions).map(o => o.value),
      stati:    Array.from(body.querySelector('.bs-filter-stato').selectedOptions).map(o => o.value),
      epiche:   epicaSel ? [epicaSel] : [],
      progetti: filtri[view].progetti || [],
      epica:    '',
      progetto: '',
      team:     filtri[view].team || '',
      dataDa:   body.querySelector('.bs-filter-data-da').value,
      dataA:    body.querySelector('.bs-filter-data-a').value
    };
    popolaFiltri();
    if (view === 'gantt')    renderGantt();
    if (view === 'workload') renderWorkload();
    chiudiBottomSheet();
    aggiornaBadgeFiltri();
  });
}

function chiudiBottomSheet() {
  document.getElementById('bottom-sheet-filtri').classList.add('hidden');
}

function popolaFiltri() {
  document.querySelectorAll('.filter-bar').forEach(bar => {
    const vista = bar.dataset.viewFilter;
    const f = filtri[vista];

    // Persone
    const selP = bar.querySelector('.filter-persone');
    if (selP) {
      selP.innerHTML = stato.persone
        .map(p => `<option value="${p.id}" ${f.persone.includes(p.id) ? 'selected' : ''}>${escapeHtml(p.nome)}</option>`)
        .join('');
    }

    // Epiche (multi-select)
    const selE = bar.querySelector('.filter-epica');
    if (selE) {
      const epiche = stato.task.filter(t => t.tipo === 'epica');
      const sel = new Set(Array.isArray(f.epiche) ? f.epiche : (f.epica ? [f.epica] : []));
      selE.innerHTML = epiche
        .map(e => `<option value="${e.id}" ${sel.has(e.id) ? 'selected' : ''}>${escapeHtml(e.nome)}</option>`)
        .join('');
    }

    // Team
    const selTeam = bar.querySelector('.filter-team');
    if (selTeam) {
      selTeam.innerHTML = `<option value="">— Tutti —</option>` + (stato.team || [])
        .slice().sort((a, b) => (a.ordine || 0) - (b.ordine || 0))
        .map(tm => `<option value="${tm.id}" ${f.team === tm.id ? 'selected' : ''}>${escapeHtml(tm.nome)}</option>`)
        .join('');
    }

    // Progetti Jira (multi-select)
    const selProj = bar.querySelector('.filter-progetto');
    if (selProj) {
      const progetti = progettiPresenti();
      const sel = new Set(Array.isArray(f.progetti) ? f.progetti : (f.progetto ? [f.progetto] : []));
      selProj.innerHTML = progetti
        .map(p => `<option value="${escapeHtml(p)}" ${sel.has(p) ? 'selected' : ''}>${escapeHtml(p)}</option>`)
        .join('');
    }

    // Stati (statici, ma reimposta selected)
    bar.querySelectorAll('.filter-stato option').forEach(o => {
      o.selected = f.stati.includes(o.value);
    });

    // Date
    const da = bar.querySelector('.filter-data-da');
    const a  = bar.querySelector('.filter-data-a');
    if (da) da.value = f.dataDa || '';
    if (a)  a.value  = f.dataA  || '';
  });
}

// True se un task passa i filtri della vista
// True se il task è nascosto (manualmente flaggato come tale o se un suo
// antenato è nascosto). Usato per escludere intere epiche da Jira dalle viste.
function taskNascosto(t) {
  let cur = t;
  while (cur) {
    if (cur.nascosta === true) return true;
    if (!cur.parentId) break;
    cur = stato.task.find(x => x.id === cur.parentId);
  }
  return false;
}

function passaFiltri(t, f) {
  if (taskNascosto(t)) return false;
  // Filtro progetto Jira (multi-select): applicato a tutti i tipi.
  // Fallback su f.progetto (legacy singolo) se f.progetti non e' array.
  const progettiSel = Array.isArray(f.progetti) ? f.progetti : (f.progetto ? [f.progetto] : []);
  if (progettiSel.length) {
    if (!progettiSel.includes(t.jiraProject || '')) return false;
  }
  if (f.stati.length && !f.stati.includes(t.stato) && t.tipo !== 'epica') return false;
  if (f.persone.length) {
    if (t.tipo === 'epica') {
      // L'epica passa se almeno una foglia ha una persona filtrata
      const visti = new Set();
      function raccogli(id) {
        const figli = stato.task.filter(x => x.parentId === id);
        if (!figli.length) {
          const self = stato.task.find(x => x.id === id);
          (self?.assegnazioni || []).forEach(a => visti.add(a.personaId));
        } else figli.forEach(c => raccogli(c.id));
      }
      raccogli(t.id);
      if (!f.persone.some(p => visti.has(p))) return false;
    } else {
      if (!(t.assegnazioni || []).some(a => f.persone.includes(a.personaId))) return false;
    }
  }
  // Filtro epiche (multi-select): il task deve appartenere ad almeno una.
  // Fallback su f.epica (legacy singolo) se f.epiche non e' array.
  const epicheSel = Array.isArray(f.epiche) ? f.epiche : (f.epica ? [f.epica] : []);
  if (epicheSel.length) {
    const ok = epicheSel.some(eid => t.id === eid || eAntenato(eid, t.id));
    if (!ok) return false;
  }
  if (f.dataDa || f.dataA) {
    // Usa date ereditate dal parent per sub-task senza date proprie
    const { inizio: ti, fine: tf } = dateEffettive(t);
    if (!ti || !tf) return epicheSel.length ? true : false;
    if (f.dataA && ti > f.dataA) return false;
    if (f.dataDa && tf < f.dataDa) return false;
  }
  return true;
}

// Set degli id task ammessi dai filtri (include gli antenati per mantenere la gerarchia)
function taskAmmessi(f) {
  const ammessi = new Set();
  stato.task.forEach(t => { if (passaFiltri(t, f)) ammessi.add(t.id); });
  // Aggiungi tutti gli antenati per mantenere la struttura ad albero
  let cresce = true;
  while (cresce) {
    cresce = false;
    stato.task.forEach(t => {
      if (ammessi.has(t.id) && t.parentId && !ammessi.has(t.parentId)) {
        ammessi.add(t.parentId);
        cresce = true;
      }
    });
  }
  return ammessi;
}

// Stato temporaneo delle assegnazioni durante la compilazione dei form
let tempAssegnazioniNuovo = [];
let tempAssegnazioniEdit  = [];

// Stato temporaneo delle dipendenze durante la compilazione dei form
let tempDipendenzeNuovo = [];
let tempDipendenzeEdit  = [];

// Palette colori per le persone
const PALETTE = [
  '#2563eb','#16a34a','#dc2626','#9333ea','#ea580c',
  '#0891b2','#db2777','#65a30d','#b45309','#0f766e'
];

// Configurazione stati task
const STATI_TASK = {
  'todo':        { label: 'To Do'       },
  'in-progress': { label: 'In Progress' },
  'done':        { label: 'Done'        },
  'blocked':     { label: 'Blocked'     }
};

// ===== LOCALSTORAGE + MIGRAZIONE =====

// ===== PERSISTENZA: Firestore (con localStorage come fallback) =====

const FIRESTORE_COLLECTION = 'workspaces';
const FIRESTORE_DOC = 'main'; // workspace condiviso, multi-utente
const TASK_CHUNK_SIZE = 400;  // max task per documento chunk (per stare sotto 1 MB Firestore)
let _saveTimer = null;
let _isApplyingRemote = false;

function impostaSyncStato(stato_sync) {
  const el = document.getElementById('sync-indicator');
  if (!el) return;
  el.className = `sync-indicator sync-${stato_sync}`;
  const labels = {
    loading:      'Collegamento…',
    connected:    'Sincronizzato',
    saving:       'Salvataggio…',
    offline:      'Offline (locale)',
    error:        'Errore sync'
  };
  const lab = el.querySelector('.sync-label');
  if (lab) lab.textContent = labels[stato_sync] || stato_sync;
}

function salvaStato() {
  // Cache locale immediata per offline / reload veloce
  try { localStorage.setItem('gantt-app-stato', JSON.stringify(stato)); } catch {}

  // Se sto applicando dati dal remoto, non rinviare al server (evita loop)
  if (_isApplyingRemote) return;

  // Se Firebase non è disponibile, resta in modalità locale
  if (!window.__firebase) return;

  // Difensivo: i viewer non possono scrivere su Firestore. Editor+Owner si',
  // gli viewer no. Le rules server-side bloccano comunque la write; qui evitiamo
  // anche solo di tentare la chiamata.
  if (!isEditor()) {
    console.warn('Skip Firestore write: utente non editor.');
    return;
  }

  // Audit log lightweight: chi ha fatto l'ultima modifica e quando
  stato.metadata = {
    lastModifiedBy: utenteCorrente?.email || 'sconosciuto',
    lastModifiedAt: new Date().toISOString()
  };

  impostaSyncStato('saving');
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(async () => {
    try {
      const fb = window.__firebase;
      // Separo task dal resto (persone, festivita, metadata) per chunking.
      // Il doc main contiene tutto tranne i task; i task vanno in docs separati.
      const { task, ...mainData } = JSON.parse(JSON.stringify(stato));
      const tasks = task || [];
      const numChunks = Math.max(1, Math.ceil(tasks.length / TASK_CHUNK_SIZE));
      mainData.taskChunkCount = numChunks;

      // ORDINE CRITICO: chunks PRIMA, main DOPO (il listener su main
      // scatta e legge i chunk — devono essere già aggiornati)

      // 1. Scrivo i chunk di task
      for (let i = 0; i < numChunks; i++) {
        const slice = tasks.slice(i * TASK_CHUNK_SIZE, (i + 1) * TASK_CHUNK_SIZE);
        await fb.setDoc(fb.doc(fb.db, FIRESTORE_COLLECTION, `tasks_${i}`), { items: slice });
      }
      // 2. Rimuovo chunk vecchi in eccesso
      for (let i = numChunks; i < numChunks + 5; i++) {
        try { await fb.deleteDoc(fb.doc(fb.db, FIRESTORE_COLLECTION, `tasks_${i}`)); } catch {}
      }
      // 3. Scrivo il doc main PER ULTIMO (trigger del listener)
      await fb.setDoc(fb.doc(fb.db, FIRESTORE_COLLECTION, FIRESTORE_DOC), mainData);

      impostaSyncStato('connected');
      aggiornaTooltipUltimaModifica();
    } catch (e) {
      console.error('Firestore save error:', e);
      impostaSyncStato('error');
    }
  }, 400); // debounce 400ms — accumula mini-modifiche prima del save
}

// Mostra "ultima modifica" come tooltip sull'indicatore sync
function aggiornaTooltipUltimaModifica() {
  const el = document.getElementById('sync-indicator');
  if (!el || !stato.metadata) return;
  const ts = stato.metadata.lastModifiedAt;
  const by = stato.metadata.lastModifiedBy;
  if (ts && by) {
    const dt = new Date(ts);
    const fmt = dt.toLocaleString('it-IT');
    el.title = `Ultima modifica: ${fmt} da ${by}`;
  }
}

function caricaStato() {
  // SICUREZZA: lo stato parte vuoto e l'app e' visualmente bloccata fino a
  // quando l'auth non e' risolta come utente con permessi. Nessuna lettura
  // di localStorage o Firestore prima dell'autenticazione.
  stato = { persone: [], task: [], festivita: [], team: [] };
  document.body.setAttribute('data-locked', 'true');
  impostaSyncStato('loading');

  if (window.__firebase) {
    inizializzaAuth();
  } else {
    window.addEventListener('firebase-ready', inizializzaAuth, { once: true });
    setTimeout(() => {
      if (!window.__firebase) impostaSyncStato('offline');
    }, 5000);
  }
}

// Riferimento alla unsubscribe del listener Firestore (per disattivarlo a logout)
let _unsubFirestore = null;
// Flag: ho gia' fatto scroll iniziale a "oggi" dopo aver ricevuto i dati?
let _scrollatoAOggiIniziale = false;

function avviaSyncFirestore() {
  // Niente sync se l'utente non e' loggato — protezione contro la cache
  // IndexedDB che servirebbe dati a chi non e' autorizzato
  if (!utenteCorrente) return;
  // Idempotente: se gia' attiva, non duplicare
  if (_unsubFirestore) return;

  // Ora che siamo autenticati, posso anche caricare la cache locale
  // (creata da una sessione precedente legittima)
  const raw = localStorage.getItem('gantt-app-stato');
  if (raw) {
    try {
      stato = migraStato(JSON.parse(raw));
      collassaTutteEpicheInizialmente();
      aggiornaViste();
    } catch {}
  }

  const { db, doc, onSnapshot } = window.__firebase;
  const ref = doc(db, FIRESTORE_COLLECTION, FIRESTORE_DOC);

  // Listener sul doc main (persone, festivita, metadata, taskChunkCount).
  // Quando il main cambia, ri-leggiamo anche i chunk dei task.
  _unsubFirestore = onSnapshot(ref, async snap => {
    if (snap.metadata.hasPendingWrites) return;

    if (!snap.exists()) {
      salvaStato();
      impostaSyncStato('connected');
      return;
    }

    _isApplyingRemote = true;
    try {
      const mainData = snap.data() || {};
      const chunkCount = Number(mainData.taskChunkCount) || 0;

      // Leggi i chunk di task in parallelo
      const allTasks = [];
      if (chunkCount > 0) {
        const fb = window.__firebase;
        const promises = [];
        for (let i = 0; i < chunkCount; i++) {
          promises.push(fb.getDoc(fb.doc(fb.db, FIRESTORE_COLLECTION, `tasks_${i}`)));
        }
        const chunkSnaps = await Promise.all(promises);
        chunkSnaps.forEach(cs => {
          if (cs.exists()) {
            const items = cs.data()?.items;
            if (Array.isArray(items)) allTasks.push(...items);
          }
        });
      } else if (Array.isArray(mainData.task)) {
        // Backward-compat: vecchio formato con task nel main doc
        allTasks.push(...mainData.task);
      }

      const fakeStato = { persone: mainData.persone, task: allTasks, festivita: mainData.festivita, team: mainData.team };
      const remoto = migraStato(fakeStato);
      stato.persone   = remoto.persone   || [];
      stato.task      = remoto.task      || [];
      stato.festivita = remoto.festivita || [];
      stato.team      = remoto.team      || [];
      stato.metadata  = mainData.metadata || null;

      collassaTutteEpicheInizialmente();
      try { localStorage.setItem('gantt-app-stato', JSON.stringify(stato)); } catch {}
      aggiornaTooltipUltimaModifica();
      aggiornaViste();
      impostaSyncStato('connected');

      if (!_scrollatoAOggiIniziale) {
        const tabAttiva = document.querySelector('.tab.active')?.dataset.tab;
        if (tabAttiva === 'gantt')         setTimeout(scrollAOggi, 100);
        else if (tabAttiva === 'workload') setTimeout(scrollWorkloadAOggi, 100);
        _scrollatoAOggiIniziale = true;
      }
    } catch (e) {
      console.error('Errore applicazione snapshot remoto:', e);
      impostaSyncStato('error');
    } finally {
      _isApplyingRemote = false;
    }
  }, err => {
    console.error('Firestore listen error:', err);
    impostaSyncStato('error');
    if (err?.code === 'permission-denied') {
      stato = { persone: [], task: [], festivita: [], team: [] };
      try { localStorage.removeItem('gantt-app-stato'); } catch {}
      aggiornaViste();
      mostraBannerAccesso();
    }
  });
}

// Termina la sottoscrizione e svuota i dati locali (al logout)
function terminaSyncFirestore() {
  if (_unsubFirestore) {
    try { _unsubFirestore(); } catch {}
    _unsubFirestore = null;
  }
  stato = { persone: [], task: [], festivita: [], team: [] };
  try { localStorage.removeItem('gantt-app-stato'); } catch {}
  _scrollatoAOggiIniziale = false;
  aggiornaViste();
  impostaSyncStato('loading');
}

// Toast non-blocking, usato in posti dove prima usavamo alert(). Tipi:
// 'info' | 'success' | 'error'. Auto-rimosso dopo 6 secondi.
function mostraToast(msg, tipo = 'info') {
  let t = document.createElement('div');
  t.className = `app-toast app-toast-${tipo}`;
  t.innerHTML = `<span>${escapeHtml(msg)}</span><button type="button" aria-label="Chiudi">×</button>`;
  document.body.appendChild(t);
  t.querySelector('button').addEventListener('click', () => t.remove());
  setTimeout(() => t.remove(), 6000);
}

// Banner "non sei autorizzato": appare quando Firestore rifiuta la lettura.
// È idempotente — può essere richiamato per ri-renderizzare se cambia auth.
function mostraBannerAccesso() {
  document.body.setAttribute('data-locked', 'true');
  let banner = document.getElementById('access-banner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'access-banner';
    banner.className = 'access-banner';
    document.body.appendChild(banner);
  }
  const loggedIn = utenteCorrente != null;
  banner.innerHTML = loggedIn
    ? `<div>
         <strong>Accesso negato</strong> per <code>${escapeHtml(utenteCorrente.email)}</code>.<br>
         Questa email non è nella lista dei viewer autorizzati.<br>
         Contatta l'owner per essere aggiunto, oppure esci e prova con un'altra email.
         <br>
         <button type="button" class="link-btn" id="ab-logout">Esci</button>
       </div>`
    : `<div>
         <strong>Login richiesto</strong><br>
         Questo workspace è privato.
         <br>
         <button type="button" class="link-btn" id="ab-login">Accedi con email magic link</button>
       </div>`;
  banner.querySelector('#ab-login')?.addEventListener('click', () =>
    document.getElementById('btn-login-email')?.click());
  banner.querySelector('#ab-logout')?.addEventListener('click', async () => {
    const fb = window.__firebase;
    if (!fb || !fb.auth) return;
    try { await fb.signOut(fb.auth); } catch (e) { console.warn('signOut:', e); }
    // onAuthStateChanged fara' partire la ri-renderizzazione del banner
  });
}

function rimuoviBannerAccesso() {
  document.body.removeAttribute('data-locked');
  document.getElementById('access-banner')?.remove();
}

// Converte i task dal vecchio formato (personaId+effort) al nuovo
// (assegnazioni multiple + stato). Compatibile con vecchi backup.
function migraStato(dati) {
  if (!dati.persone) dati.persone = [];
  if (!dati.task)    dati.task = [];

  dati.task = dati.task.map(t => {
    // Vecchio formato → conversione
    if (t.personaId !== undefined && !t.assegnazioni) {
      const assegnazioni = t.personaId
        ? [{ personaId: t.personaId, effort: t.effort || 100 }]
        : [];
      return {
        id: t.id, nome: t.nome, inizio: t.inizio, fine: t.fine,
        assegnazioni,
        stato: t.stato || 'todo'
      };
    }
    // Nuovo formato (assicurati che i campi esistano)
    const urg = Number(t.urgenza);
    const imp = Number(t.importanza);
    return {
      id: t.id, nome: t.nome, inizio: t.inizio, fine: t.fine,
      assegnazioni: t.assegnazioni || [],
      stato: t.stato || 'todo',
      stimaOre: Number(t.stimaOre) || 0,
      completamento: Number.isFinite(Number(t.completamento)) ? Number(t.completamento) : 0,
      dipendenze: Array.isArray(t.dipendenze) ? t.dipendenze.slice() : [],
      parentId: t.parentId || null,
      tipo: ['epica', 'milestone'].includes(t.tipo) ? t.tipo : 'task',
      ordine: Number.isFinite(t.ordine) ? t.ordine : null,
      // Scala 1-4: i vecchi valori 5 vengono compressi a 4
      urgenza:    Number.isFinite(urg) && urg >= 1 ? Math.min(4, urg) : 3,
      importanza: Number.isFinite(imp) && imp >= 1 ? Math.min(4, imp) : 3,
      // Visibilità: true = task/epica nascosta da Gantt/Workload/Eisenhower
      nascosta:   t.nascosta === true,
      // Campi Jira (preservati se presenti). Per backward-compat, se manca
      // jiraProject ma c'e' jiraKey lo deduco dal prefisso "PROJ-123" -> "PROJ".
      jiraKey:           t.jiraKey || null,
      jiraProject:       t.jiraProject || (t.jiraKey ? String(t.jiraKey).split('-')[0] : null),
      jiraUrl:           t.jiraUrl || null,
      jiraUpdated:       t.jiraUpdated || null,
      // Snapshot delle date all'ultimo sync da Jira: serve a sapere se
      // l'utente ha modificato inizio/fine in MY-GANTT dopo l'import
      // (così il prossimo sync le ripusha verso Jira).
      jiraSyncedInizio:  t.jiraSyncedInizio || null,
      jiraSyncedFine:    t.jiraSyncedFine || null
    };
  });

  // Assegna un ordine progressivo ai task che non ce l'hanno (preserva l'ordine attuale)
  dati.task.forEach((t, i) => {
    if (t.ordine == null) t.ordine = i;
  });

  // Backward-compat: nei backup vecchi (pre-tipo-field) qualsiasi task con
  // figli era implicitamente un'epica. Lo applichiamo SOLO ai task creati
  // manualmente (senza jiraKey): le Story importate da Jira che hanno
  // sub-task devono restare 'task' (non sono Epic Jira).
  const idsConFigli = new Set(
    dati.task.filter(t => t.parentId).map(t => t.parentId)
  );
  dati.task.forEach(t => {
    if (idsConFigli.has(t.id) && !t.jiraKey) t.tipo = 'epica';
  });

  // Festività (può essere vuoto)
  if (!Array.isArray(dati.festivita)) dati.festivita = [];

  // Ferie + costo orario + team per persona
  dati.persone = dati.persone.map(p => ({
    ...p,
    ferie: Array.isArray(p.ferie) ? p.ferie.slice() : [],
    costoOrario: Number.isFinite(Number(p.costoOrario)) ? Number(p.costoOrario) : 0,
    teamId: p.teamId || null,
    ordine: Number.isFinite(Number(p.ordine)) ? Number(p.ordine) : 0,
    nascosta: p.nascosta === true
  }));

  // Team (può essere vuoto)
  if (!Array.isArray(dati.team)) dati.team = [];
  dati.team = dati.team.map(t => ({
    id: t.id,
    nome: t.nome || '',
    colore: t.colore || '#5e6ad2',
    ordine: Number.isFinite(Number(t.ordine)) ? Number(t.ordine) : 0
  }));

  return dati;
}

const ORE_GIORNO_PIENE = 8; // FTE 1 = 8 ore/giorno

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[c]);
}

// Conta i giorni lavorativi tra due date ISO inclusi gli estremi.
// Esclude weekend, festività registrate, e (se personaId passato) ferie della persona.
function giorniLavorativi(inizioISO, fineISO, personaId) {
  if (!inizioISO || !fineISO) return 0;
  let n = 0;
  const cur = new Date(inizioISO);
  const fine = new Date(fineISO);
  while (cur <= fine) {
    const iso = cur.toISOString().slice(0, 10);
    if (eGiornoLavorativo(iso, personaId)) n++;
    cur.setDate(cur.getDate() + 1);
  }
  return n;
}

// Ore-uomo assegnate complessivamente: stimaOre × Σ(effort%) / 100
// (con assegnazioni che dovrebbero sommare 100%, questo coincide con stimaOre)
// Ore-uomo allocate per il task: usa le ore RESIDUE (tolti i sotto-task)
function effortAllocato(t) {
  const stima = oreResidueTask(t);
  const sommaEffort = t.assegnazioni.reduce((s, a) => s + (Number(a.effort) || 0), 0);
  return Math.round(stima * sommaEffort / 100);
}

// Ore/giorno lavorativo per una singola persona su un task.
// Conta solo i giorni lavorativi della *persona* (escludendo le sue ferie),
// così se ha 3 giorni di ferie nel periodo le ore vengono concentrate sugli altri.
// Ore/giorno lavorativo per una persona su un task. Se il task ha sotto-task,
// usa le ore RESIDUE. Se il task non ha date, eredita quelle del parent.
function oreGiornaliereAssegnazione(t, assegnazione) {
  const stima = oreResidueTask(t);
  if (!stima) return 0;
  const { inizio, fine } = dateEffettive(t);
  if (!inizio || !fine) return 0;
  const ggLav = giorniLavorativi(inizio, fine, assegnazione.personaId);
  if (!ggLav) return 0;
  const orePersona = stima * (Number(assegnazione.effort) || 0) / 100;
  return orePersona / ggLav;
}

// Se un sotto-task non ha date proprie, eredita quelle del parent.
// Fondamentale per il Workload: senza date la task non contribuisce ore a
// nessuna settimana anche se ha stimaOre.
function dateEffettive(t) {
  let inizio = t.inizio || null;
  let fine   = t.fine   || null;
  if ((!inizio || !fine) && t.parentId) {
    const parent = stato.task.find(p => p.id === t.parentId);
    if (parent) {
      if (!inizio) inizio = parent.inizio || null;
      if (!fine)   fine   = parent.fine   || null;
    }
  }
  return { inizio, fine };
}

// Se un sotto-task ha 0h e TUTTI i fratelli hanno 0h, eredita una quota
// dal parent: parent.stimaOre / (1 + N fratelli). Il parent conta come
// "1 unità" accanto ai sotto-task.
function oreEreditateDalParent(t) {
  if (!t.parentId) return 0;
  const parent = stato.task.find(p => p.id === t.parentId);
  if (!parent) return 0;
  const parentOre = Number(parent.stimaOre) || 0;
  if (!parentOre) return 0;
  const siblings = stato.task.filter(s => s.parentId === parent.id);
  if (!siblings.every(s => (Number(s.stimaOre) || 0) === 0)) return 0;
  return parentOre / (1 + siblings.length);
}

// Ore totali effettive di un task: max tra le proprie e la somma dei figli.
// Per le foglie a 0h con fratelli tutti a 0h: eredita dal parent.
function stimaOreEffettiva(t) {
  const proprie = Number(t.stimaOre) || 0;
  const figli = stato.task.filter(f => f.parentId === t.id);
  if (!figli.length) return proprie > 0 ? proprie : oreEreditateDalParent(t);
  const sommaFigli = figli.reduce((s, f) => s + stimaOreEffettiva(f), 0);
  return Math.max(proprie, sommaFigli);
}

// Ore residue per il task: le ore che gli assignee del parent lavorano.
// Caso 1: figli con ore proprie → residuo = proprie - somma figli (min 0)
// Caso 2: figli TUTTI a 0h → dividi equamente: parent prende 1/(1+N)
// Caso 3: foglia a 0h → eredita quota dal parent
function oreResidueTask(t) {
  const proprie = Number(t.stimaOre) || 0;
  const figli = stato.task.filter(f => f.parentId === t.id);
  if (!figli.length) return proprie > 0 ? proprie : oreEreditateDalParent(t);
  const sommaFigli = figli.reduce((s, f) => s + stimaOreEffettiva(f), 0);
  if (sommaFigli > 0) return Math.max(0, proprie - sommaFigli);
  return proprie / (1 + figli.length);
}

// Costo del task in euro: Σ (stimaOre × effort% × costoOrario persona)
// Costo del task: usa le ore RESIDUE (tolti i sotto-task) per gli assignee
// del parent. I sotto-task calcolano il proprio costo indipendentemente.
function costoTask(t) {
  const stima = oreResidueTask(t);
  if (!stima || !Array.isArray(t.assegnazioni)) return 0;
  return t.assegnazioni.reduce((sum, a) => {
    const p = stato.persone.find(x => x.id === a.personaId);
    const tariffa = p ? Number(p.costoOrario) || 0 : 0;
    const ore = stima * (Number(a.effort) || 0) / 100;
    return sum + ore * tariffa;
  }, 0);
}

// Formattazione monetaria in euro, senza decimali (es. "€ 1.250")
function formatEuro(n) {
  const v = Math.round(Number(n) || 0);
  return '€ ' + v.toLocaleString('it-IT');
}

// ===== EPICHE / SOTTO-TASK =====

function figliDi(taskId) {
  return stato.task.filter(t => t.parentId === taskId);
}

function eEpica(taskId) {
  const t = stato.task.find(x => x.id === taskId);
  return t?.tipo === 'epica';
}

function haFigli(taskId) {
  return stato.task.some(t => t.parentId === taskId);
}

function eMilestone(taskId) {
  const t = stato.task.find(x => x.id === taskId);
  return t?.tipo === 'milestone';
}

// % di completamento di un singolo task in base allo stato.
// Per i task in-progress si usa il valore custom `completamento` se presente,
// altrimenti 50% come fallback. Done = 100, todo/blocked = 0.
function percCompletamento(taskOrStato) {
  // Backward-compat: accetta sia una stringa di stato che il task intero
  if (typeof taskOrStato === 'string') {
    if (taskOrStato === 'done') return 100;
    if (taskOrStato === 'in-progress') return 50;
    return 0;
  }
  const t = taskOrStato || {};
  if (t.stato === 'done') return 100;
  if (t.stato === 'in-progress') {
    const v = Number(t.completamento);
    if (Number.isFinite(v)) return Math.max(0, Math.min(100, v));
    return 50;
  }
  return 0;
}

// True se un nodo ha dati propri (stima, date o assegnazioni). Usato per
// fermare la ricorsione quando un nodo intermedio "conta" — caso tipico
// delle Story Jira che portano le ore mentre i sub-task sono breakdown vuoto.
function nodoHaDatiPropri(t) {
  if ((Number(t.stimaOre) || 0) > 0) return true;
  if (t.inizio || t.fine) return true;
  if (Array.isArray(t.assegnazioni) && t.assegnazioni.length > 0) return true;
  return false;
}

// Aggrega ricorsivamente i dati di un'epica.
// Strategia: cammina nei figli, ma se un figlio ha dati propri (stima/date/
// assegnazioni) lo tratta come "foglia di calcolo" e NON scende nei suoi
// sub-task. Questo riflette la convenzione Jira (Story con ore, sub-task vuoti).
function aggregaEpica(t) {
  const foglie = [];
  function raccogli(id, isRoot) {
    const node = stato.task.find(x => x.id === id);
    if (!node) return;
    // Sul root (l'epica stessa) NON ci fermiamo mai: scendiamo sempre nei figli
    if (!isRoot && nodoHaDatiPropri(node)) {
      foglie.push(node);
      return;
    }
    const figli = figliDi(id);
    if (!figli.length) {
      if (!isRoot) foglie.push(node);
      return;
    }
    figli.forEach(f => raccogli(f.id, false));
  }
  raccogli(t.id, true);

  if (!foglie.length) {
    return { inizio: t.inizio, fine: t.fine, stimaOre: 0, oreAllocate: 0,
             stato: 'todo', completamento: 0, costoTotale: 0 };
  }

  // Fallback su t.inizio/t.fine quando NESSUNA foglia ha date (es. tutti
  // sub-task vuoti) ma l'epica/story stessa ha date proprie da Jira.
  const inizio = foglie.map(f => f.inizio).filter(Boolean).sort()[0] || t.inizio;
  const fine = foglie.map(f => f.fine).filter(Boolean).sort().reverse()[0] || t.fine;
  // Solo i task contribuiscono alle ore (le milestone hanno 0)
  const stimaOre = foglie.reduce((s, f) => s + (Number(f.stimaOre) || 0), 0);
  const oreAllocate = foglie.reduce((s, f) => s + effortAllocato(f), 0);
  const costoTotale = foglie.reduce((s, f) => s + costoTask(f), 0);

  // Stato derivato
  const stati = foglie.map(f => f.stato);
  let statoEpica = 'todo';
  if (stati.every(s => s === 'done')) statoEpica = 'done';
  else if (stati.some(s => s === 'blocked')) statoEpica = 'blocked';
  else if (stati.some(s => s === 'in-progress' || s === 'done')) statoEpica = 'in-progress';

  // Completamento: media pesata per stimaOre, fallback alla media semplice
  let completamento = 0;
  const sommaStima = foglie.reduce((s, f) => s + (Number(f.stimaOre) || 0), 0);
  if (sommaStima > 0) {
    completamento = Math.round(
      foglie.reduce((s, f) => s + percCompletamento(f) * (Number(f.stimaOre) || 0), 0) / sommaStima
    );
  } else {
    completamento = Math.round(
      foglie.reduce((s, f) => s + percCompletamento(f), 0) / foglie.length
    );
  }

  return { inizio, fine, stimaOre, oreAllocate, stato: statoEpica, completamento, costoTotale };
}

// Restituisce true se `potenzialeAvo` è antenato di `taskId`, per evitare cicli
function eAntenato(potenzialeAvoId, taskId) {
  let cur = stato.task.find(t => t.id === taskId);
  while (cur?.parentId) {
    if (cur.parentId === potenzialeAvoId) return true;
    cur = stato.task.find(t => t.id === cur.parentId);
  }
  return false;
}

// True se il task è una foglia (no figli)
function eFoglia(taskId) {
  return !eEpica(taskId);
}

// Restituisce un array flat ordinato { task, livello, isEpica, collassata }
// dei task. Se rispettaCollasso=true, i discendenti delle epiche collassate
// vengono saltati (usato dal Gantt).
// Restituisce un array flat ordinato { task, livello, isEpica, isParent, collassata }.
// isEpica = tipo 'epica' (da Jira o manuale). isParent = ha figli (anche Story con sub-task).
// Il chevron di collapse appare su isParent (non solo isEpica), così le Story
// con sub-task sono espandibili/collassabili come le epiche.
function ordineGerarchicoTask(rispettaCollasso = false, ammessi = null, raggruppaPerProgetto = false) {
  const out = [];
  function walk(parentId, livello) {
    let fratelli = stato.task
      .filter(t => (t.parentId || null) === parentId)
      .filter(t => !ammessi || ammessi.has(t.id))
      .slice()
      .sort((a, b) => (Number(a.ordine) || 0) - (Number(b.ordine) || 0));
    // Solo a livello 0: raggruppa top-level per progetto (preserva ordine interno)
    if (raggruppaPerProgetto && parentId === null) {
      const ordineProgetti = new Map();
      let next = 0;
      fratelli.forEach(t => {
        const k = chiaveProgetto(t);
        if (!ordineProgetti.has(k)) ordineProgetti.set(k, next++);
      });
      fratelli.sort((a, b) => {
        const pa = ordineProgetti.get(chiaveProgetto(a));
        const pb = ordineProgetti.get(chiaveProgetto(b));
        if (pa !== pb) return pa - pb;
        return (Number(a.ordine) || 0) - (Number(b.ordine) || 0);
      });
    }
    fratelli.forEach(t => {
      const isEpica = eEpica(t.id);
      const isParent = isEpica || haFigli(t.id);
      const collassata = isParent && epicheCollassate.has(t.id);
      out.push({ task: t, livello, isEpica, isParent, collassata });
      if (rispettaCollasso && collassata) return;
      walk(t.id, livello + 1);
    });
  }
  walk(null, 0);
  return out;
}

// Riordina i fratelli di un task: muove `taskId` prima/dopo `targetId`
function riordinaTask(taskId, targetId, posizione /* 'prima' | 'dopo' */) {
  const t = stato.task.find(x => x.id === taskId);
  const target = stato.task.find(x => x.id === targetId);
  if (!t || !target || t.id === target.id) return;

  // Se hanno parent diversi: sposta sotto lo stesso parent del target
  if ((t.parentId || null) !== (target.parentId || null)) {
    if (target.parentId && eAntenato(t.id, target.parentId)) return; // ciclo
    t.parentId = target.parentId || null;
  }

  const fratelli = stato.task
    .filter(x => (x.parentId || null) === (target.parentId || null))
    .sort((a, b) => (Number(a.ordine) || 0) - (Number(b.ordine) || 0));

  // Rimuovi `t` dalla lista, poi reinserisci prima/dopo target
  const idx = fratelli.findIndex(x => x.id === t.id);
  if (idx !== -1) fratelli.splice(idx, 1);
  const tIdx = fratelli.findIndex(x => x.id === target.id);
  const insertAt = posizione === 'prima' ? tIdx : tIdx + 1;
  fratelli.splice(insertAt, 0, t);

  // Riassegna ordini progressivi
  fratelli.forEach((x, i) => { x.ordine = i; });

  salvaStato();
  aggiornaViste();
}

// Popola un <select> con le sole epiche disponibili come padre (escludendo cicli)
function popolaSelectPadre(selectId, taskIdCorrente, parentIdAttuale) {
  const select = document.getElementById(selectId);
  if (!select) return;

  const opzioni = stato.task
    .filter(t =>
      t.tipo === 'epica' &&
      t.id !== taskIdCorrente &&
      !eAntenato(taskIdCorrente, t.id)
    )
    .map(t => {
      const sel = t.id === parentIdAttuale ? 'selected' : '';
      return `<option value="${t.id}" ${sel}>${escapeHtml(t.nome)}</option>`;
    })
    .join('');

  select.innerHTML = `<option value="">— Nessuna (task top-level) —</option>${opzioni}`;
}

// ===== UTILITÀ =====

function generaId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function colorePerIndice(i) {
  return PALETTE[i % PALETTE.length];
}

function trovaPersona(id) {
  return stato.persone.find(p => p.id === id);
}

function formatDataBreve(iso) {
  if (!iso) return '';
  const [, m, d] = iso.split('-');
  return `${d}/${m}`;
}

function dataISOoggi() {
  return new Date().toISOString().slice(0, 10);
}

function dataISO(d) {
  if (typeof d === 'string') return d.slice(0, 10);
  return d.toISOString().slice(0, 10);
}

function rangeDateISO(inizioISO, fineISO) {
  const date = [];
  const cur = new Date(inizioISO);
  const fine = new Date(fineISO);
  while (cur <= fine) {
    date.push(cur.toISOString().slice(0, 10));
    cur.setDate(cur.getDate() + 1);
  }
  return date;
}

function rangeGlobale() {
  if (!stato.task.length) return null;
  const inizi = stato.task.map(t => t.inizio).sort();
  const fini  = stato.task.map(t => t.fine).sort();
  return { min: inizi[0], max: fini[fini.length - 1] };
}

function eWeekend(iso) {
  const g = new Date(iso).getDay();
  return g === 0 || g === 6;
}

// ===== CALENDARIO LAVORATIVO =====

// Calcolo della Pasqua (algoritmo di Gauss) per un dato anno
function dataPasqua(anno) {
  const a = anno % 19;
  const b = Math.floor(anno / 100);
  const c = anno % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const L = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * L) / 451);
  const mese = Math.floor((h + L - 7 * m + 114) / 31);
  const giorno = ((h + L - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(anno, mese - 1, giorno));
}

function dataAggiungiGiorni(d, n) {
  const x = new Date(d);
  x.setUTCDate(x.getUTCDate() + n);
  return x;
}

// Preset festività italiane per un anno
function festivitaItaliaPerAnno(anno) {
  const pasqua = dataPasqua(anno);
  const pasquetta = dataAggiungiGiorni(pasqua, 1);
  return [
    { data: `${anno}-01-01`, nome: 'Capodanno' },
    { data: `${anno}-01-06`, nome: 'Epifania' },
    { data: dataISO(pasqua), nome: 'Pasqua' },
    { data: dataISO(pasquetta), nome: 'Pasquetta' },
    { data: `${anno}-04-25`, nome: 'Liberazione' },
    { data: `${anno}-05-01`, nome: 'Festa dei Lavoratori' },
    { data: `${anno}-06-02`, nome: 'Festa della Repubblica' },
    { data: `${anno}-08-15`, nome: 'Ferragosto' },
    { data: `${anno}-11-01`, nome: 'Tutti i Santi' },
    { data: `${anno}-12-08`, nome: 'Immacolata' },
    { data: `${anno}-12-25`, nome: 'Natale' },
    { data: `${anno}-12-26`, nome: 'Santo Stefano' }
  ];
}

// Mappa rapida { iso: nome } delle festività registrate
function mapFestivita() {
  const m = {};
  (stato.festivita || []).forEach(f => { m[f.data] = f.nome; });
  return m;
}

// Verifica se una data ISO cade in un intervallo di ferie di una persona
function eInFerie(iso, personaId) {
  const p = trovaPersona(personaId);
  if (!p?.ferie) return null;
  for (const f of p.ferie) {
    if (iso >= f.inizio && iso <= f.fine) return f.nome || 'Ferie';
  }
  return null;
}

// True se la data è un giorno lavorativo per la persona (se passata)
// o in generale (se personaId omesso): no weekend, no festività, no ferie.
function eGiornoLavorativo(iso, personaId) {
  if (eWeekend(iso)) return false;
  if (mapFestivita()[iso]) return false;
  if (personaId && eInFerie(iso, personaId)) return false;
  return true;
}

// Etichetta del giorno non lavorativo ("Weekend", "Festività: Pasqua", "Ferie: Mario")
function etichettaGiornoNonLavorativo(iso, personaId) {
  if (eWeekend(iso)) return 'Weekend';
  const fest = mapFestivita()[iso];
  if (fest) return `Festività: ${fest}`;
  if (personaId) {
    const ferie = eInFerie(iso, personaId);
    if (ferie) return `Ferie: ${ferie}`;
  }
  return null;
}

// Iniziali di un nome ("Mario Rossi" → "MR")
function inizialiNome(nome) {
  return nome.split(/\s+/).map(w => w[0] || '').join('').toUpperCase().slice(0, 3);
}

// Avatar HTML: cerchietto colorato con iniziali della persona
function avatar(persona, size = 'md') {
  if (!persona) return '';
  const ini = inizialiNome(persona.nome).slice(0, 2);
  return `<span class="avatar avatar-${size}" style="background:${escapeHtml(persona.colore)}" title="${escapeHtml(persona.nome)}">${escapeHtml(ini)}</span>`;
}

// La list-view era stata pensata per smartphone, ma rende il Gantt non
// percepibile come tale. La disattiviamo: anche su mobile mostriamo la
// timeline classica, ottimizzata per touch.
function isMobileListView() {
  return false;
}

// ===== GESTIONE TAB =====

function attivaTab(nome) {
  document.querySelectorAll('.tab').forEach(t =>
    t.classList.toggle('active', t.dataset.tab === nome));
  document.querySelectorAll('.tab-content').forEach(c =>
    c.classList.toggle('active', c.id === `tab-${nome}`));
  // Stato kebab-nav (mobile)
  document.querySelectorAll('.kebab-nav').forEach(b =>
    b.classList.toggle('active', b.dataset.nav === nome));
  document.body.setAttribute('data-active-tab', nome);
  // Chiudi il kebab se aperto
  document.getElementById('kebab-dropdown')?.classList.add('hidden');
  // Quando entro nelle tab grafiche, ri-renderizzo per avere dimensioni corrette
  if (nome === 'gantt') {
    renderGantt();
    renderWeekStrip();
    setTimeout(scrollAOggi, 80);
  }
  if (nome === 'workload') {
    renderWorkload();
    renderWeekStrip();
    setTimeout(scrollWorkloadAOggi, 80);
  }
  if (nome === 'eisenhower') renderEisenhower();
  if (nome === 'calendario') renderCalendario();
  aggiornaBadgeFiltri();
}

// ===== PERSONE =====

function renderPersone() {
  const lista = document.getElementById('lista-persone');
  lista.innerHTML = stato.persone.length
    ? stato.persone.map(p => `
      <li>
        <div class="info-persona">
          ${avatar(p, 'lg')}
          <strong>${escapeHtml(p.nome)}</strong>
          <span>${escapeHtml(p.ruolo)}</span>
          <span class="label-fte">FTE ${escapeHtml(p.fte)}</span>
          ${Number(p.costoOrario) > 0 ? `<span class="label-fte" title="Costo orario">${formatEuro(p.costoOrario)}/h</span>` : ''}
        </div>
        <div class="azioni-lista">
          <button class="btn btn-edit btn-sm" data-action="modifica-persona" data-id="${p.id}">Modifica</button>
          <button class="btn btn-danger btn-sm" data-action="elimina-persona" data-id="${p.id}">Elimina</button>
        </div>
      </li>`).join('')
    : '<li class="empty-state">Nessuna persona aggiunta.</li>';
}

let personaInModifica = null;
function apriModaleModificaPersona(id) {
  const p = trovaPersona(id);
  if (!p) return;
  personaInModifica = id;
  document.getElementById('edit-persona-nome').value   = p.nome;
  document.getElementById('edit-persona-ruolo').value  = p.ruolo;
  document.getElementById('edit-persona-fte').value    = p.fte;
  document.getElementById('edit-persona-colore').value = p.colore;
  document.getElementById('edit-persona-costo').value  = Number(p.costoOrario) || 0;
  popolaSelectTeamPersona('edit-persona-team', p.teamId);
  document.getElementById('modal-persona-overlay').classList.remove('hidden');
}

function chiudiModaleModificaPersona() {
  personaInModifica = null;
  document.getElementById('modal-persona-overlay').classList.add('hidden');
}

function salvaModificaPersona(nome, ruolo, fte, colore, costoOrario) {
  const p = trovaPersona(personaInModifica);
  if (!p) return;
  p.nome = nome;
  p.ruolo = ruolo;
  p.fte = fte;
  p.colore = colore;
  p.costoOrario = Math.max(0, Number(costoOrario) || 0);
  const teamSel = document.getElementById('edit-persona-team');
  p.teamId = teamSel?.value || null;
  salvaStato();
  chiudiModaleModificaPersona();
  aggiornaViste();
}

function aggiungiPersona(nome, ruolo, fte, costoOrario) {
  stato.persone.push({
    id: generaId(),
    nome, ruolo, fte,
    colore: colorePerIndice(stato.persone.length),
    costoOrario: Math.max(0, Number(costoOrario) || 0)
  });
  salvaStato();
  aggiornaViste();
}

// ===== CALENDARIO (rendering UI) =====

function renderCalendario() {
  renderFestivita();
  renderFeriePersone();
}

function renderFestivita() {
  const lista = document.getElementById('lista-festivita');
  if (!lista) return;
  const fest = (stato.festivita || []).slice().sort((a, b) => a.data.localeCompare(b.data));
  lista.innerHTML = fest.length
    ? fest.map(f => `
      <li>
        <div class="info-task">
          <span class="label-fte">📅 ${escapeHtml(f.data)}</span>
          <strong>${escapeHtml(f.nome)}</strong>
        </div>
        <button class="btn btn-danger btn-sm" data-action="elimina-festivita" data-data="${escapeHtml(f.data)}">Elimina</button>
      </li>`).join('')
    : '<li class="empty-state">Nessuna festività configurata.</li>';
}

function renderFeriePersone() {
  const c = document.getElementById('lista-ferie-persone');
  if (!c) return;
  if (!stato.persone.length) {
    c.innerHTML = '<p class="empty-state">Aggiungi prima le persone.</p>';
    return;
  }
  c.innerHTML = stato.persone.map(p => `
    <div class="ferie-blocco" data-id="${p.id}">
      <div class="ferie-header">
        <span class="badge-colore" style="background:${escapeHtml(p.colore)}"></span>
        <strong>${escapeHtml(p.nome)}</strong>
        <small>${escapeHtml(p.ruolo)} · FTE ${escapeHtml(p.fte)}</small>
      </div>
      <form class="form-inline form-ferie" data-id="${p.id}">
        <label>Dal <input type="date" class="ferie-inizio" required></label>
        <label>Al <input type="date" class="ferie-fine" required></label>
        <input type="text" class="ferie-nome" placeholder="Motivo (opz., es. Ferie estive)">
        <button type="submit" class="btn btn-primary btn-sm">+ Aggiungi</button>
      </form>
      <ul class="lista">
        ${(p.ferie || []).slice().sort((a,b) => a.inizio.localeCompare(b.inizio)).map((f, i) => `
          <li>
            <div class="info-task">
              <span class="label-fte">📅 ${escapeHtml(f.inizio)} → ${escapeHtml(f.fine)}</span>
              <span>${escapeHtml(f.nome || 'Ferie')}</span>
            </div>
            <button class="btn btn-danger btn-sm" data-action="elimina-ferie" data-id="${p.id}" data-i="${i}">Elimina</button>
          </li>
        `).join('') || '<li class="empty-state">Nessun periodo di ferie.</li>'}
      </ul>
    </div>
  `).join('');
}

function aggiungiFestivita(data, nome) {
  if (!Array.isArray(stato.festivita)) stato.festivita = [];
  // Evita duplicati per stessa data
  if (stato.festivita.some(f => f.data === data)) {
    alert('Esiste già una festività in questa data.');
    return;
  }
  stato.festivita.push({ data, nome });
  salvaStato();
  aggiornaViste();
}

function eliminaFestivita(data) {
  stato.festivita = (stato.festivita || []).filter(f => f.data !== data);
  salvaStato();
  aggiornaViste();
}

function aggiungiFestivitaItalia(anno) {
  if (!Array.isArray(stato.festivita)) stato.festivita = [];
  const nuove = festivitaItaliaPerAnno(anno);
  let aggiunte = 0;
  nuove.forEach(f => {
    if (!stato.festivita.some(x => x.data === f.data)) {
      stato.festivita.push(f);
      aggiunte++;
    }
  });
  salvaStato();
  aggiornaViste();
  alert(`Aggiunte ${aggiunte} festività italiane per l'anno ${anno}.`);
}

function aggiungiFerie(personaId, inizio, fine, nome) {
  const p = trovaPersona(personaId);
  if (!p) return;
  if (!Array.isArray(p.ferie)) p.ferie = [];
  if (fine < inizio) { alert('La data fine deve essere uguale o successiva all\'inizio.'); return; }
  p.ferie.push({ inizio, fine, nome: nome || '' });
  salvaStato();
  aggiornaViste();
}

function eliminaFerie(personaId, indice) {
  const p = trovaPersona(personaId);
  if (!p?.ferie) return;
  p.ferie.splice(indice, 1);
  salvaStato();
  aggiornaViste();
}

function eliminaPersona(id) {
  const p = stato.persone.find(x => x.id === id);
  if (!p) return;
  const taskCoinvolti = stato.task.filter(t =>
    t.assegnazioni.some(a => a.personaId === id)).length;
  const msg = taskCoinvolti
    ? `Eliminare "${p.nome}"? Verrà rimossa anche da ${taskCoinvolti} task.`
    : `Eliminare "${p.nome}"?`;
  if (!confirm(msg)) return;

  stato.task.forEach(t => {
    t.assegnazioni = t.assegnazioni.filter(a => a.personaId !== id);
  });
  stato.persone = stato.persone.filter(p => p.id !== id);
  salvaStato();
  aggiornaViste();
}

// ===== ASSEGNAZIONI NEI FORM (multi-persona) =====

// Genera le option HTML del select persona, escludendo quelle già scelte
function opzioniPersone(selezionato, escludi = []) {
  return stato.persone
    .filter(p => p.id === selezionato || !escludi.includes(p.id))
    .map(p => `<option value="${p.id}" ${p.id === selezionato ? 'selected' : ''}>${p.nome} (${p.ruolo})</option>`)
    .join('');
}

// Renderizza la lista delle assegnazioni in un container del form
function renderAssegnazioni(containerId, assegnazioni) {
  const c = document.getElementById(containerId);
  const somma = assegnazioni.reduce((s, a) => s + (Number(a.effort) || 0), 0);
  const sommaCls = !assegnazioni.length ? '' : (somma === 100 ? 'ok' : 'warn');
  const sommaTxt = !assegnazioni.length
    ? ''
    : `<div class="assegnazioni-totale ${sommaCls}">
        Totale: ${somma}%${somma === 100 ? ' ✓' : ' — dovrebbe essere 100%'}
       </div>`;

  if (!assegnazioni.length) {
    c.innerHTML = '<p class="empty-state-small">Nessuna persona assegnata. Clicca "+" per aggiungerne una.</p>';
    return;
  }

  // Persone già scelte (per non duplicarle nei dropdown delle altre righe)
  const giàScelte = assegnazioni.map(a => a.personaId).filter(Boolean);

  c.innerHTML = assegnazioni.map((a, i) => `
    <div class="assegnazione-row" data-i="${i}">
      <select class="select-persona-ass">
        <option value="">-- seleziona persona --</option>
        ${opzioniPersone(a.personaId, giàScelte)}
      </select>
      <div class="effort-input">
        <input type="number" class="input-effort-ass" min="0" max="100" step="5" value="${a.effort}">
        <span>%</span>
      </div>
      <button type="button" class="btn btn-danger btn-sm btn-rimuovi-ass" title="Rimuovi">×</button>
    </div>
  `).join('') + sommaTxt;

  // Aggancia gli event listener alle righe appena create
  c.querySelectorAll('.assegnazione-row').forEach(row => {
    const i = Number(row.dataset.i);
    row.querySelector('.select-persona-ass').addEventListener('change', e => {
      assegnazioni[i].personaId = e.target.value;
      renderAssegnazioni(containerId, assegnazioni);
    });
    row.querySelector('.input-effort-ass').addEventListener('change', e => {
      // Su 'change' (blur o invio): auto-rebalance per portare il totale a 100
      let valore = Math.max(0, Math.min(100, Number(e.target.value) || 0));
      assegnazioni[i].effort = valore;
      ribilanciaAssegnazioni(assegnazioni, i);
      renderAssegnazioni(containerId, assegnazioni);
    });
    row.querySelector('.input-effort-ass').addEventListener('input', e => {
      // Durante la digitazione: aggiorno solo il valore e il totale (no rebalance)
      assegnazioni[i].effort = Number(e.target.value) || 0;
      const tot = assegnazioni.reduce((s, a) => s + (Number(a.effort) || 0), 0);
      const totEl = c.querySelector('.assegnazioni-totale');
      if (totEl) {
        totEl.textContent = `Totale: ${tot}%${tot === 100 ? ' ✓' : ' — sistemerò a 100% al rilascio'}`;
        totEl.classList.toggle('ok', tot === 100);
        totEl.classList.toggle('warn', tot !== 100);
      }
    });
    row.querySelector('.btn-rimuovi-ass').addEventListener('click', () => {
      assegnazioni.splice(i, 1);
      // Ridistribuisci il 100% tra le persone rimaste
      if (assegnazioni.length) {
        const n = assegnazioni.length;
        const each = Math.floor(100 / n);
        assegnazioni.forEach(a => a.effort = each);
        assegnazioni[n - 1].effort += 100 - each * n;
      }
      renderAssegnazioni(containerId, assegnazioni);
    });
  });
}

// Verifica che la somma effort sia 100% — restituisce true se ok o se l'utente conferma override
function validaSommaEffort(assegnazioni) {
  const valide = assegnazioni.filter(a => a.personaId);
  const somma = valide.reduce((s, a) => s + (Number(a.effort) || 0), 0);
  if (somma === 100) return true;
  return confirm(
    `La somma degli effort è ${somma}% invece di 100%.\n` +
    `Il calcolo del workload sarà proporzionalmente sbagliato.\n\nProcedere comunque?`
  );
}

function aggiungiRigaAssegnazione(containerId, assegnazioni) {
  // Aggiungi e distribuisci 100% equamente tra tutte le persone (l'ultima prende il resto)
  assegnazioni.push({ personaId: '', effort: 0 });
  const n = assegnazioni.length;
  const each = Math.floor(100 / n);
  assegnazioni.forEach(a => a.effort = each);
  assegnazioni[n - 1].effort += 100 - each * n;
  renderAssegnazioni(containerId, assegnazioni);
}

// Tiene fisso l'effort di `indiceModificato` e distribuisce il resto sugli altri
// proporzionalmente, garantendo che la somma sia 100.
function ribilanciaAssegnazioni(assegnazioni, indiceModificato) {
  if (!assegnazioni.length) return;
  const mod = assegnazioni[indiceModificato];
  mod.effort = Math.max(0, Math.min(100, Number(mod.effort) || 0));
  const altri = assegnazioni.filter((_, i) => i !== indiceModificato);
  const restante = 100 - mod.effort;

  if (!altri.length) {
    mod.effort = 100;
    return;
  }
  if (restante <= 0) {
    altri.forEach(a => a.effort = 0);
    mod.effort = 100;
    return;
  }
  const sommaAltri = altri.reduce((s, a) => s + (Number(a.effort) || 0), 0);
  if (sommaAltri === 0) {
    // Distribuzione equa con resto sull'ultimo per arrivare esattamente a 100
    const base = Math.floor(restante / altri.length);
    altri.forEach(a => a.effort = base);
    altri[altri.length - 1].effort += restante - base * altri.length;
  } else {
    // Proporzionale alla quota corrente
    let allocato = 0;
    altri.forEach((a, idx) => {
      if (idx === altri.length - 1) {
        a.effort = restante - allocato; // l'ultimo prende il resto esatto
      } else {
        a.effort = Math.round((Number(a.effort) || 0) / sommaAltri * restante);
        allocato += a.effort;
      }
    });
  }
}

// ===== DIPENDENZE NEI FORM =====

// Render checkbox-list di task selezionabili come dipendenze.
// `escludiId` evita di proporre il task stesso (in modalità modifica).
function renderDipendenze(containerId, selezionate, escludiId) {
  const c = document.getElementById(containerId);
  const altre = stato.task.filter(t => t.id !== escludiId);
  if (!altre.length) {
    c.innerHTML = '<p class="empty-state-small">Nessun altro task disponibile.</p>';
    return;
  }
  c.innerHTML = altre.map(t => {
    const checked = selezionate.includes(t.id) ? 'checked' : '';
    return `
      <label class="dipendenza-item">
        <input type="checkbox" value="${t.id}" ${checked}>
        <span class="badge-stato stato-${t.stato}">${escapeHtml(STATI_TASK[t.stato]?.label || '')}</span>
        <span>${escapeHtml(t.nome)}</span>
        <small style="color:#94a3b8">(${formatDataBreve(t.inizio)} → ${formatDataBreve(t.fine)})</small>
      </label>`;
  }).join('');

  c.querySelectorAll('input[type=checkbox]').forEach(cb => {
    cb.addEventListener('change', () => {
      const id = cb.value;
      const i = selezionate.indexOf(id);
      if (cb.checked && i === -1) selezionate.push(id);
      else if (!cb.checked && i !== -1) selezionate.splice(i, 1);
    });
  });
}

// ===== TASK =====

function renderTask() {
  const lista = document.getElementById('lista-task');
  if (!stato.task.length) {
    lista.innerHTML = '<li class="empty-state">Nessun task aggiunto.</li>';
    return;
  }
  // Drop zone iniziale per estrarre un task dall'epica
  const dropZoneTop = `<li class="drop-zone-top" data-droptarget="root">
    ↥ Trascina qui per riportare al top-level
  </li>`;
  lista.innerHTML = dropZoneTop + renderTaskHTML(stato.task);
}

// HTML di una lista task (ricorsiva per epiche/sotto-task)
function renderTaskHTML(tasks, livello = 0) {
  if (livello === 0) tasks = tasks.filter(t => !t.parentId);

  return tasks.map(t => {
    const isEpica = t.tipo === 'epica';
    const isMilestone = t.tipo === 'milestone';
    const figli = stato.task.filter(c => c.parentId === t.id);
    const isParent = isEpica || figli.length > 0;
    const agg = isEpica ? aggregaEpica(t) : null;
    const statoVis = isEpica ? agg.stato : t.stato;
    const infoStato = STATI_TASK[statoVis] || STATI_TASK.todo;

    const inizioMostrato = isEpica ? agg.inizio : t.inizio;
    const fineMostrata = isEpica ? agg.fine : t.fine;
    const stima = isEpica ? agg.stimaOre : (Number(t.stimaOre) || 0);
    const gg = isMilestone ? 0 : giorniLavorativi(inizioMostrato, fineMostrata);
    const allocate = isEpica ? agg.oreAllocate : (isMilestone ? 0 : effortAllocato(t));

    const tagPersone = (isEpica || isMilestone)
      ? ''
      : (t.assegnazioni || []).map(a => {
          const p = trovaPersona(a.personaId);
          if (!p) return '';
          return `<span class="label-persona-tag">${avatar(p, 'xs')} ${escapeHtml(p.nome)} <small>${a.effort}%</small></span>`;
        }).join('');

    const indent = livello * 24;
    // Salta i figli se l'epica è collassata
    const figliHTML = (figli.length && !(isEpica && epicheCollassate.has(t.id)))
      ? renderTaskHTML(figli, livello + 1)
      : '';
    const liClass = [
      isEpica ? 'task-epica' : (isMilestone ? 'task-milestone' : 'task-leaf'),
      isEpica ? 'drop-target' : ''
    ].filter(Boolean).join(' ');

    let datiMeta;
    const costoRiga = isEpica ? (agg.costoTotale || 0) : costoTask(t);
    const costoBadge = costoRiga > 0
      ? `<span class="label-fte" title="Costo stimato">${formatEuro(costoRiga)}</span>`
      : '';
    if (isEpica) {
      datiMeta = figli.length
        ? `<span>${formatDataBreve(inizioMostrato)} → ${formatDataBreve(fineMostrata)}</span>
           <span class="label-fte" title="Σ figli">⏱ ${stima}h</span>
           <span class="label-fte" title="Giorni · Ore-uomo">${gg}gg · ${allocate}h</span>
           <span class="label-fte epica-badge" title="Completamento">${agg.completamento}%</span>
           ${costoBadge}`
        : '<em style="color:#94a3b8">vuota — trascina qui dei task</em>';
    } else if (isMilestone) {
      datiMeta = `<span>Data: ${formatDataBreve(t.inizio)}</span>`;
    } else {
      datiMeta = `<span>${formatDataBreve(inizioMostrato)} → ${formatDataBreve(fineMostrata)}</span>
         <span class="label-fte" title="Stima manuale">⏱ ${stima}h</span>
         <span class="label-fte" title="Giorni · Ore-uomo">${gg}gg · ${allocate}h</span>
         ${costoBadge}`;
    }

    const chevron = isParent
      ? `<span class="task-tree-chevron task-chevron-toggle" data-toggle-task="${t.id}">${epicheCollassate.has(t.id) ? '▸' : '▾'}</span>`
      : (isMilestone
          ? '<span class="task-tree-chevron leaf"><span class="milestone-diamond"></span></span>'
          : '<span class="task-tree-chevron leaf">·</span>');

    const badgeTipo = isEpica
      ? '<span class="label-fte epica-badge">EPICA</span>'
      : (isMilestone ? '<span class="label-fte milestone-badge">MILESTONE</span>' : '');

    return `
      <li class="${liClass}" data-id="${t.id}" data-tipo="${t.tipo}"
          ${isEpica ? '' : 'draggable="true"'}
          style="padding-left:${indent}px">
        <div class="info-task">
          ${chevron}
          <span class="badge-stato stato-${statoVis}">${escapeHtml(infoStato.label)}</span>
          <strong>${escapeHtml(t.nome)}</strong>
          ${badgeTipo}
          ${datiMeta}
          <span class="assegnazioni-tag">${tagPersone}</span>
        </div>
        <div class="azioni-lista">
          <button class="btn btn-edit btn-sm" data-action="modifica-task" data-id="${t.id}">Modifica</button>
          <button class="btn btn-danger btn-sm" data-action="elimina-task" data-id="${t.id}">Elimina</button>
        </div>
      </li>${figliHTML}`;
  }).join('');
}

function aggiungiTask(nome, inizio, fine, statoTask, assegnazioni, stimaOre, dipendenze, parentId, completamento, importanza, urgenza) {
  stato.task.push({
    id: generaId(),
    nome, inizio, fine,
    stato: statoTask,
    stimaOre: Number(stimaOre) || 0,
    completamento: clampCompletamento(completamento, statoTask),
    importanza: clampEisen(importanza, 3),
    urgenza:    clampEisen(urgenza, 3),
    assegnazioni: assegnazioni.filter(a => a.personaId).map(a => ({ ...a })),
    dipendenze: (dipendenze || []).slice(),
    parentId: parentId || null,
    tipo: 'task',
    ordine: prossimoOrdine(parentId || null)
  });
  salvaStato();
  aggiornaViste();
}

// Normalizza il completamento in [0,100] e auto-imposta in base allo stato
function clampCompletamento(val, stato) {
  if (stato === 'done') return 100;
  if (stato === 'todo' || stato === 'blocked') return 0;
  const n = Number(val);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

// Normalizza un valore di importanza/urgenza in [1,4].
// Storicamente la scala era 1-5: i valori 5 vengono compressi a 4.
function clampEisen(val, fallback) {
  const n = Math.round(Number(val));
  if (!Number.isFinite(n)) {
    const f = Math.round(Number(fallback));
    if (!Number.isFinite(f)) return 3;
    return Math.max(1, Math.min(4, f));
  }
  return Math.max(1, Math.min(4, n));
}

// Restituisce l'ordine "in fondo" tra i fratelli con lo stesso parent
function prossimoOrdine(parentId) {
  const fratelli = stato.task.filter(t => (t.parentId || null) === parentId);
  if (!fratelli.length) return 0;
  return Math.max(...fratelli.map(t => Number(t.ordine) || 0)) + 1;
}

function spostaTaskInEpica(taskId, nuovoParentId) {
  const t = stato.task.find(x => x.id === taskId);
  if (!t) return;
  if (nuovoParentId === taskId) return;
  if (nuovoParentId && eAntenato(taskId, nuovoParentId)) return; // evita cicli
  if (t.parentId === nuovoParentId) return; // già lì
  t.parentId = nuovoParentId || null;
  salvaStato();
  aggiornaViste();
}

function aggiungiMilestone(nome, data, statoMs, parentId) {
  stato.task.push({
    id: generaId(),
    nome,
    tipo: 'milestone',
    inizio: data,
    fine: data,
    stato: statoMs || 'todo',
    stimaOre: 0,
    assegnazioni: [],
    dipendenze: [],
    parentId: parentId || null,
    ordine: prossimoOrdine(parentId || null)
  });
  salvaStato();
  aggiornaViste();
}

function aggiungiEpica(nome) {
  stato.task.push({
    id: generaId(),
    nome,
    tipo: 'epica',
    parentId: null,
    inizio: null,
    fine: null,
    stato: 'todo',
    stimaOre: 0,
    assegnazioni: [],
    dipendenze: [],
    ordine: prossimoOrdine(null)
  });
  salvaStato();
  aggiornaViste();
}

function eliminaTask(id) {
  const t = stato.task.find(x => x.id === id);
  if (!t) return;
  const figli = stato.task.filter(x => x.parentId === id).length;
  const msg = figli
    ? `Eliminare il task "${t.nome}"? Ha ${figli} sotto-task: anche quelli verranno eliminati.`
    : `Eliminare il task "${t.nome}"?`;
  if (!confirm(msg)) return;

  // Raccoglie ricorsivamente l'id del task + tutti i discendenti
  const daRimuovere = new Set([id]);
  let cresce = true;
  while (cresce) {
    cresce = false;
    stato.task.forEach(x => {
      if (x.parentId && daRimuovere.has(x.parentId) && !daRimuovere.has(x.id)) {
        daRimuovere.add(x.id);
        cresce = true;
      }
    });
  }
  stato.task = stato.task.filter(x => !daRimuovere.has(x.id));
  // Pulisci le dipendenze rimaste che puntavano a task eliminati
  stato.task.forEach(x => {
    if (Array.isArray(x.dipendenze)) {
      x.dipendenze = x.dipendenze.filter(d => !daRimuovere.has(d));
    }
  });
  salvaStato();
  aggiornaViste();
}

// ===== MODAL MODIFICA TASK =====

function apriModaleTask(id) {
  const t = stato.task.find(x => x.id === id);
  if (!t) return;
  taskInModifica = id;

  const isEpica = t.tipo === 'epica';
  const isMilestone = t.tipo === 'milestone';
  const modal = document.querySelector('#modal-overlay .modal');
  modal.setAttribute('data-mode', t.tipo);
  document.getElementById('modal-titolo').textContent =
    isEpica ? `Modifica epica: ${t.nome}` :
    isMilestone ? `Modifica milestone` : `Modifica task`;

  document.getElementById('edit-nome').value = t.nome;

  // Reset del riepilogo sub-task (verrà mostrato dopo se il task ha figli)
  const sezRiep = document.getElementById('epica-riepilogo');
  if (sezRiep) { sezRiep.style.display = ''; sezRiep.innerHTML = ''; }

  // Importanza/Urgenza: validi per tutti i tipi (task, epica, milestone)
  document.getElementById('edit-importanza').value = clampEisen(t.importanza, 3);
  document.getElementById('edit-urgenza').value    = clampEisen(t.urgenza, 3);

  if (isMilestone) {
    document.getElementById('edit-data-milestone').value = t.inizio || '';
    document.getElementById('edit-stato').value  = t.stato || 'todo';
    popolaSelectPadre('edit-parent', t.id, t.parentId);
    tempAssegnazioniEdit = [];
    tempDipendenzeEdit = (t.dipendenze || []).slice();
  } else if (isEpica) {
    tempAssegnazioniEdit = [];
    tempDipendenzeEdit = [];
    renderEpicaRiepilogo(t);
  } else {
    document.getElementById('edit-inizio').value = t.inizio || '';
    document.getElementById('edit-fine').value   = t.fine || '';
    document.getElementById('edit-stato').value  = t.stato || 'todo';
    document.getElementById('edit-stima').value  = Number(t.stimaOre) || 0;
    document.getElementById('edit-completamento').value = Number.isFinite(Number(t.completamento)) ? Number(t.completamento) : (t.stato === 'done' ? 100 : 0);

    tempAssegnazioniEdit = (t.assegnazioni || []).map(a => ({ ...a }));
    renderAssegnazioni('lista-assegnazioni-edit', tempAssegnazioniEdit);

    tempDipendenzeEdit = (t.dipendenze || []).slice();
    renderDipendenze('lista-dipendenze-edit', tempDipendenzeEdit, t.id);

    popolaSelectPadre('edit-parent', t.id, t.parentId);

    // Se il task ha sotto-task, mostra il riepilogo (come per le epiche)
    if (haFigli(t.id)) {
      renderEpicaRiepilogo(t);
      const sez = document.getElementById('epica-riepilogo');
      if (sez) sez.style.display = 'block';
    }
  }

  document.getElementById('modal-overlay').classList.remove('hidden');
}

function chiudiModale() {
  taskInModifica = null;
  document.getElementById('modal-overlay').classList.add('hidden');
}

function salvaModificaTask(nome, inizio, fine, statoTask, assegnazioni, stimaOre, dipendenze, parentId) {
  const t = stato.task.find(x => x.id === taskInModifica);
  if (!t) return;

  t.nome = nome;

  // Importanza/Urgenza: leggi sempre dal form (presente per tutti i tipi)
  const impEdit = document.getElementById('edit-importanza');
  const urgEdit = document.getElementById('edit-urgenza');
  if (impEdit) t.importanza = clampEisen(impEdit.value, t.importanza);
  if (urgEdit) t.urgenza    = clampEisen(urgEdit.value, t.urgenza);

  if (t.tipo === 'epica') {
    // Le epiche modificano nome + importanza/urgenza (sopra)
    salvaStato();
    chiudiModale();
    aggiornaViste();
    return;
  }

  if (t.tipo === 'milestone') {
    // Milestone: data, stato, parent, dipendenze + importanza/urgenza (sopra)
    const data = document.getElementById('edit-data-milestone').value;
    if (data) { t.inizio = data; t.fine = data; }
    t.stato = document.getElementById('edit-stato').value || 'todo';
    const newParent = document.getElementById('edit-parent').value || null;
    if (!newParent || !eAntenato(t.id, newParent)) t.parentId = newParent;
    salvaStato();
    chiudiModale();
    aggiornaViste();
    return;
  }

  t.inizio = inizio;
  t.fine   = fine;
  t.stato  = statoTask;
  t.stimaOre = Number(stimaOre) || 0;
  // Completamento: letto dal form (sovrascritto da clamp in base allo stato)
  const compInput = document.getElementById('edit-completamento');
  t.completamento = clampCompletamento(compInput ? compInput.value : t.completamento, statoTask);
  // (importanza/urgenza già letti sopra: validi per tutti i tipi)
  t.assegnazioni = assegnazioni.filter(a => a.personaId).map(a => ({ ...a }));
  t.dipendenze = (dipendenze || []).filter(d => d !== t.id);
  // Validazione ciclo: non posso essere figlio di un mio discendente
  if (parentId && parentId !== t.id && !eAntenato(t.id, parentId)) {
    t.parentId = parentId;
  } else if (!parentId) {
    t.parentId = null;
  }
  salvaStato();
  chiudiModale();
  aggiornaViste();
}

// ===== GANTT (custom HTML/CSS) =====

const MESI_IT = ['Gen','Feb','Mar','Apr','Mag','Giu','Lug','Ago','Set','Ott','Nov','Dic'];

// Calcola il range temporale del Gantt.
// Se sono presenti filtri data → li usa direttamente. Altrimenti deduce dai task + oggi + padding.
function calcolaRangeGantt(filtro) {
  if (filtro && filtro.dataDa && filtro.dataA) {
    return { min: filtro.dataDa, max: filtro.dataA };
  }
  const r = rangeGlobale();
  if (!r) return null;
  const oggi = dataISOoggi();
  let minISO = r.min < oggi ? r.min : oggi;
  let maxISO = r.max > oggi ? r.max : oggi;
  if (filtro?.dataDa) minISO = filtro.dataDa;
  if (filtro?.dataA)  maxISO = filtro.dataA;
  const min = new Date(minISO);
  const max = new Date(maxISO);
  if (!filtro?.dataDa) min.setDate(min.getDate() - 7);
  if (!filtro?.dataA)  max.setDate(max.getDate() + 14);
  return { min: dataISO(min), max: dataISO(max) };
}

// ===== MOBILE LIST VIEWS (Fase 3) =====

function renderGanttListView() {
  const container = document.getElementById('gantt-container');
  if (!container) return;

  if (!stato.task.length) {
    container.innerHTML = '<p class="empty-state">Nessun task. Premi + in basso per crearne uno.</p>';
    return;
  }

  const ammessi = taskAmmessi(filtri.gantt);
  const taskOrdinati = ordineGerarchicoTask(false, ammessi);

  const html = taskOrdinati.map(({ task: t, livello, isEpica }) => {
    const indent = livello * 12;

    if (isEpica) {
      const agg = aggregaEpica(t);
      const figli = stato.task.filter(c => c.parentId === t.id);
      const figliCount = figli.length;
      return `
        <div class="mlv-epica-header" data-id="${t.id}" style="margin-left:${indent}px">
          <span class="mlv-epica-label">EPICA</span>
          <span class="mlv-epica-name">${escapeHtml(t.nome)}</span>
          <span class="mlv-epica-meta">${agg.completamento}% · ${figliCount} task</span>
        </div>`;
    }

    if (t.tipo === 'milestone') {
      return `
        <div class="mlv-card mlv-card-milestone" data-id="${t.id}" style="margin-left:${indent}px">
          <span class="mlv-diamond stato-bg-${t.stato}"></span>
          <span class="mlv-card-name">${escapeHtml(t.nome)}</span>
          <small class="mlv-meta">${formatDataBreve(t.inizio)}</small>
        </div>`;
    }

    const persone = (t.assegnazioni || []).map(a => trovaPersona(a.personaId)).filter(Boolean);
    const avatars = persone.slice(0, 3).map(p => avatar(p, 'xs')).join('');
    const extra = persone.length > 3 ? `<span class="avatar avatar-xs" style="background:#475569">+${persone.length - 3}</span>` : '';

    return `
      <div class="mlv-card" data-id="${t.id}" style="margin-left:${indent}px">
        <span class="mlv-stato-dot stato-bg-${t.stato}"></span>
        <span class="mlv-card-name">${escapeHtml(t.nome)}</span>
        <div class="avatar-group">${avatars}${extra}</div>
      </div>`;
  }).join('');

  container.innerHTML = `<div class="mobile-list-view">${html}</div>`;

  container.querySelectorAll('[data-id]').forEach(el => {
    el.addEventListener('click', () => apriModaleTask(el.dataset.id));
  });
}

function renderWorkloadListView() {
  const container = document.getElementById('workload-container');
  if (!container) return;

  if (!stato.persone.length || !stato.task.length) {
    container.innerHTML = '<p class="empty-state">Aggiungi persone e task per vedere il workload.</p>';
    return;
  }

  // Range: usa filtro se settato, altrimenti settimana corrente lun-ven
  const f = filtri.workload;
  let da = f.dataDa, a = f.dataA;
  if (!da || !a) {
    const sett = settimanaCorrenteLunVen();
    da = da || sett.lun;
    a  = a  || sett.ven;
  }

  const allocazioni = calcolaAllocazioniPeriodo(da, a);
  const ammessi = taskAmmessi(filtri.workload);

  const html = allocazioni.map(({ persona: p, totaleH, items }) => {
    if (filtri.workload.persone?.length && !filtri.workload.persone.includes(p.id)) return '';

    const ggLavPersona = giorniLavorativi(da, a, p.id);
    const capacita = ggLavPersona * ORE_GIORNO_PIENE * p.fte;
    const perc = capacita > 0 ? Math.round(totaleH / capacita * 100) : 0;
    const cls = perc > 100 ? 'over' : perc >= 80 ? 'warn' : perc > 0 ? 'ok' : 'zero';

    const itemsHTML = items.length
      ? items
          .filter(it => !ammessi || ammessi.has(it.taskId))
          .map(it => {
            const task = stato.task.find(x => x.id === it.taskId);
            const statoVis = task?.stato || 'todo';
            return `
              <li class="mlv-wl-task" data-task-id="${it.taskId}">
                <span class="mlv-stato-dot stato-bg-${statoVis}"></span>
                <span class="mlv-card-name">${escapeHtml(it.taskNome)}</span>
                <small class="mlv-meta">${it.ore.toFixed(1)}h</small>
              </li>`;
          }).join('')
      : '<li class="mlv-wl-empty">Nessun task</li>';

    return `
      <div class="mlv-person-card">
        <header class="mlv-person-header">
          ${avatar(p, 'md')}
          <div class="mlv-person-info">
            <strong>${escapeHtml(p.nome)}</strong>
            <small>${escapeHtml(p.ruolo)} · ${capacita.toFixed(0)}h cap.</small>
          </div>
          <span class="mlv-perc mlv-perc-${cls}">${perc}%</span>
        </header>
        <ul class="mlv-wl-tasks">${itemsHTML}</ul>
      </div>`;
  }).join('');

  container.innerHTML = `
    <div class="mlv-workload">
      <p class="hint" style="margin:0 0 0.6rem 0;text-align:center">
        ${formatDataBreve(da)} → ${formatDataBreve(a)}
      </p>
      ${html}
    </div>`;

  container.querySelectorAll('[data-task-id]').forEach(el => {
    el.addEventListener('click', () => apriModaleTask(el.dataset.taskId));
  });
}

function renderGantt() {
  if (isMobileListView()) {
    return renderGanttListView();
  }
  const container = document.getElementById('gantt-container');
  if (!container) return;

  if (!stato.task.length) {
    container.innerHTML = '<p class="empty-state">Aggiungi almeno un task per visualizzare il Gantt.</p>';
    return;
  }

  const range = calcolaRangeGantt(filtri.gantt);
  const giorni = rangeDateISO(range.min, range.max);
  const dayW = calcolaDayWAdattivo('gantt-container', 240, giorni.length);
  const totaleW = giorni.length * dayW;
  const minDate = new Date(range.min);
  const ammessi = taskAmmessi(filtri.gantt);

  // --- Header (mesi + giorni) ---
  const mesi = [];
  giorni.forEach(g => {
    const key = g.slice(0, 7); // YYYY-MM
    const ultimo = mesi[mesi.length - 1];
    if (!ultimo || ultimo.key !== key) {
      const d = new Date(g);
      mesi.push({ key, label: `${MESI_IT[d.getMonth()]} ${d.getFullYear()}`, count: 1 });
    } else {
      ultimo.count++;
    }
  });
  const monthRow = mesi.map(m =>
    `<div class="gantt-month-cell" style="width:${m.count * dayW}px">${m.label}</div>`
  ).join('');

  const dayRow = giorni.map(g => {
    const d = new Date(g);
    const we = eWeekend(g) ? ' weekend' : '';
    let label = '';
    if (viewModeCorrente === 'Day') {
      label = d.getDate();
    } else if (viewModeCorrente === 'Week') {
      if (d.getDay() === 1) label = d.getDate(); // lunedì
    } else {
      // Mese: tick ogni 7 giorni (lun) per dare riferimenti visivi
      if (d.getDay() === 1) label = d.getDate();
    }
    return `<div class="gantt-day-cell${we}" style="width:${dayW}px">${label}</div>`;
  }).join('');

  // --- Strisce weekend (sfondo body) ---
  const weekendOverlay = giorni.map((g, i) =>
    eWeekend(g)
      ? `<div class="gantt-weekend" style="left:${i * dayW}px; width:${dayW}px"></div>`
      : ''
  ).join('');

  // --- Bande mensili alternate + linee divisorie ---
  const bandeMesi = [];
  const dividers = [];
  let dayCursor = 0;
  mesi.forEach((m, idx) => {
    if (idx % 2 === 1) {
      bandeMesi.push(`<div class="gantt-month-band" style="left:${dayCursor * dayW}px; width:${m.count * dayW}px"></div>`);
    }
    if (idx > 0) {
      dividers.push(`<div class="gantt-month-divider" style="left:${dayCursor * dayW}px"></div>`);
    }
    dayCursor += m.count;
  });
  const sfondoStrutturato = bandeMesi.join('') + dividers.join('');

  // --- Linea verticale "oggi" ---
  const oggiISO = dataISOoggi();
  let todayLine = '';
  if (oggiISO >= range.min && oggiISO <= range.max) {
    const off = Math.round((new Date(oggiISO) - minDate) / 86400000);
    const left = off * dayW + dayW / 2;
    todayLine = `<div class="gantt-today-line" style="left:${left}px"></div>`;
  }

  // --- Costruisci elenco ordinato rispettando collasso epiche e filtri ---
  // raggruppaPerProgetto=true: top-level pre-ordinato per progetto Jira
  const taskOrdinati = ordineGerarchicoTask(true, ammessi, true);

  // Inserisci righe header per ogni gruppo progetto + nascondi figli se collassato
  const righeMisto = [];
  let progettoCorrente = undefined;
  let saltaFinoNuovoTop = false;
  taskOrdinati.forEach(item => {
    if (item.livello === 0) {
      const k = chiaveProgetto(item.task);
      if (k !== progettoCorrente) {
        progettoCorrente = k;
        // Conta epiche top-level del progetto per il label
        const nEpiche = taskOrdinati.filter(x => x.livello === 0 && chiaveProgetto(x.task) === k).length;
        const collassato = progettiCollassati.has(k);
        righeMisto.push({
          _isGroupHeader: true,
          groupKey: k,
          groupLabel: etichettaProgetto(k),
          count: nEpiche,
          collassato
        });
        saltaFinoNuovoTop = collassato;
      }
    }
    if (saltaFinoNuovoTop) return;
    righeMisto.push(item);
  });

  // --- Righe task (sia colonna laterale che barre nella timeline) ---
  const sideRows = righeMisto.map((item, i) => {
    if (item._isGroupHeader) {
      const chev = item.collassato ? '▸' : '▾';
      return `
        <div class="gantt-side-row gantt-group-header" data-group="${escapeHtml(item.groupKey)}"
             title="Click per espandere/collassare il progetto">
          <span class="gantt-chevron" data-toggle-group="${escapeHtml(item.groupKey)}">${chev}</span>
          <span class="gantt-group-label">${escapeHtml(item.groupLabel)}</span>
          <span class="gantt-group-count">${item.count} epic${item.count === 1 ? 'a' : 'he'}</span>
        </div>`;
    }
    const { task: t, livello, isEpica, isParent, collassata } = item;
    const statoVis = isEpica ? aggregaEpica(t).stato : t.stato;
    const infoStato = STATI_TASK[statoVis] || STATI_TASK.todo;
    const indent = livello * 14;
    const altCls = i % 2 === 1 ? ' row-alt' : '';
    // Chevron per QUALSIASI nodo con figli (epiche + Story con sub-task)
    const chevron = isParent
      ? `<span class="gantt-chevron" data-toggle="${t.id}">${collassata ? '▸' : '▾'}</span>`
      : '<span class="gantt-chevron leaf"></span>';
    return `
      <div class="gantt-side-row${altCls}" data-id="${t.id}" data-idx="${i}"
           draggable="true"
           title="${isEpica ? 'Modifica epica · trascina per riordinare' : 'Modifica task · trascina per riordinare'}"
           style="padding-left:${6 + indent}px">
        <span class="drag-handle" title="Trascina">⋮⋮</span>
        ${chevron}
        <span class="gantt-stato-dot stato-bg-${statoVis}" title="${escapeHtml(infoStato.label)}"></span>
        <span class="gantt-task-name ${isEpica ? 'is-epica' : ''}">${escapeHtml(t.nome)}</span>
        ${isEpica ? '<span class="epica-mini">EPICA</span>' : ''}
      </div>`;
  }).join('');

  const bodyRows = righeMisto.map((item, i) => {
    const altCls = i % 2 === 1 ? ' row-alt' : '';
    // Header progetto: riga vuota (barra opzionale aggregata gestita altrove)
    if (item._isGroupHeader) {
      return `<div class="gantt-row gantt-row-group${altCls}" data-group="${escapeHtml(item.groupKey)}"></div>`;
    }
    const { task: t, isEpica, collassata } = item;
    const isMilestone = t.tipo === 'milestone';
    const agg = isEpica ? aggregaEpica(t) : null;
    const inizio = isEpica ? agg.inizio : t.inizio;
    const fine = isEpica ? agg.fine : t.fine;
    const statoVis = isEpica ? agg.stato : t.stato;

    if (!inizio || !fine) {
      return `<div class="gantt-row${altCls}" data-id="${t.id}"></div>`;
    }

    const start = new Date(inizio);
    const end = new Date(fine);
    const offsetGiorni = Math.round((start - minDate) / 86400000);
    const durataGiorni = Math.round((end - start) / 86400000) + 1;
    const left = offsetGiorni * dayW;

    // --- MILESTONE: rombo singolo ---
    if (isMilestone) {
      const cx = left + dayW / 2;
      const tooltip = `${t.nome}\n${formatDataBreve(inizio)} [Milestone]`;
      return `
        <div class="gantt-row${altCls}" data-id="${t.id}">
          <div class="gantt-milestone stato-${statoVis}"
               style="left:${cx - 9}px"
               data-id="${t.id}"
               title="${escapeHtml(tooltip)}"></div>
          <span class="gantt-milestone-label" style="left:${cx + 14}px" title="${escapeHtml(tooltip)}">${escapeHtml(t.nome)}</span>
        </div>`;
    }

    const width = Math.max(durataGiorni * dayW - 2, Math.max(dayW * 0.5, 6));

    // Persone: per epiche unisco dai discendenti foglia
    let personeList;
    if (isEpica) {
      const visti = new Set();
      personeList = [];
      function raccogli(id) {
        const figli = stato.task.filter(x => x.parentId === id);
        if (!figli.length) {
          const self = stato.task.find(x => x.id === id);
          if (self) (self.assegnazioni || []).forEach(a => {
            if (visti.has(a.personaId)) return;
            visti.add(a.personaId);
            const p = trovaPersona(a.personaId);
            if (p) personeList.push({ p, effort: a.effort });
          });
        } else figli.forEach(f => raccogli(f.id));
      }
      raccogli(t.id);
    } else {
      personeList = (t.assegnazioni || [])
        .map(a => ({ p: trovaPersona(a.personaId), effort: a.effort }))
        .filter(x => x.p);
    }

    const sublabel = personeList
      .map(x => isEpica ? x.p.nome : `${x.p.nome} ${x.effort}%`)
      .join(' · ');
    const stima = isEpica ? agg.stimaOre : (t.stimaOre || 0);
    const completamento = isEpica ? agg.completamento : null;
    const costoEur = isEpica ? agg.costoTotale : costoTask(t);

    const tooltip = `${t.nome}\n${formatDataBreve(inizio)} → ${formatDataBreve(fine)}` +
      (stima ? `\nStima: ${stima}h` : '') +
      (costoEur > 0 ? `\nCosto: ${formatEuro(costoEur)}` : '') +
      (sublabel ? `\n${sublabel}` : '') +
      (isEpica ? `\n[EPICA · ${completamento}% completato]` : '');

    const classeBarra = isEpica ? 'gantt-bar gantt-bar-epica' : 'gantt-bar';
    const draggableAttr = isEpica ? 'data-readonly="1"' : '';
    const handlesHTML = isEpica ? '' : `
      <div class="gantt-bar-handle handle-left" data-side="left"></div>
      <div class="gantt-bar-handle handle-right" data-side="right"></div>`;

    // Sublabel: persone visibili sui task larghi e sulle epiche collassate
    const showSublabel = sublabel && width > 80 && (!isEpica || collassata);
    // % nel titolo: per le epiche sempre, per i task in-progress il valore custom
    const pctTask = !isEpica && t.tipo === 'task' ? percCompletamento(t) : null;
    const pctSuffix = isEpica
      ? ` · ${completamento}%`
      : (t.stato === 'in-progress' || t.stato === 'done') && pctTask !== null
        ? ` · ${pctTask}%`
        : '';
    // Costo sull'etichetta: solo per epiche larghe (>120px) per non sporcare le barre piccole
    const costoSuffix = isEpica && costoEur > 0 && width > 120 ? ` · ${formatEuro(costoEur)}` : '';
    const etichettaHTML = `
      <span class="gantt-bar-label">
        <span class="gantt-bar-title">${escapeHtml(t.nome)}${pctSuffix}${costoSuffix}</span>
        ${showSublabel ? `<span class="gantt-bar-sublabel">${escapeHtml(sublabel)}</span>` : ''}
      </span>`;

    // Barra di progresso: per epiche (% aggregata) e per task in-progress (% custom)
    const pctBarra = isEpica ? completamento : (pctTask || 0);
    const progressHTML = pctBarra > 0
      ? `<div class="gantt-bar-progress" style="width:${pctBarra}%"></div>`
      : '';

    return `
      <div class="gantt-row${altCls}" data-id="${t.id}">
        <div class="${classeBarra} stato-${statoVis}"
             style="left:${left}px; width:${width}px"
             data-id="${t.id}"
             ${draggableAttr}
             title="${escapeHtml(tooltip)}">
          ${progressHTML}
          ${handlesHTML}
          ${etichettaHTML}
        </div>
      </div>`;
  }).join('');

  // SVG overlay per frecce dipendenze (calcoliamo dopo aver montato il DOM)
  const bodyH = righeMisto.length * 40;
  const archiSVG = `<svg class="gantt-arcs" width="${totaleW}" height="${bodyH}"></svg>`;
  const nTaskVisibili = righeMisto.filter(r => !r._isGroupHeader).length;

  container.innerHTML = `
    <div class="gantt-side">
      <div class="gantt-side-header">Task (${nTaskVisibili})</div>
      <div class="gantt-side-body">${sideRows}</div>
    </div>
    <div class="gantt-main">
      <div class="gantt-timeline" style="width:${totaleW}px">
        <div class="gantt-header">
          <div class="gantt-header-row gantt-months">${monthRow}</div>
          <div class="gantt-header-row gantt-days">${dayRow}</div>
        </div>
        <div class="gantt-body" style="width:${totaleW}px">
          ${sfondoStrutturato}
          ${weekendOverlay}
          ${bodyRows}
          ${archiSVG}
          ${todayLine}
        </div>
      </div>
    </div>
  `;

  // Click sulle righe della colonna laterale → apre il modal,
  // tranne click sul chevron che fa toggle collasso (task o gruppo progetto)
  container.querySelectorAll('.gantt-side-row').forEach(el => {
    el.addEventListener('click', ev => {
      const chevGroup = ev.target.closest('.gantt-chevron[data-toggle-group]');
      if (chevGroup || el.classList.contains('gantt-group-header')) {
        ev.stopPropagation();
        const k = (chevGroup && chevGroup.dataset.toggleGroup) || el.dataset.group;
        if (k) toggleCollassoProgetto(k);
        return;
      }
      const chev = ev.target.closest('.gantt-chevron[data-toggle]');
      if (chev) {
        ev.stopPropagation();
        toggleCollassoEpica(chev.dataset.toggle);
        return;
      }
      apriModaleTask(el.dataset.id);
    });
  });

  // Mobile: tap su barra epica nel body → toggle espansione/collasso
  // (la side column è nascosta su smartphone, quindi serve un'azione qui)
  container.querySelectorAll('.gantt-bar-epica').forEach(bar => {
    bar.addEventListener('click', ev => {
      if (window.innerWidth > 900) return;
      ev.stopPropagation();
      toggleCollassoEpica(bar.dataset.id);
    });
  });

  // Drag-and-drop riordino delle righe Gantt
  abilitaRiordinoSideRows(container);

  // Drag delle barre (move + resize)
  abilitaDragGantt(dayW, minDate);

  // Disegna frecce dipendenze
  disegnaFrecceDipendenze(dayW, minDate);

  // Dopo il render: assicura che lo scroll orizzontale non vada oltre
  // la fine della timeline (succede quando i filtri riducono il range).
  // Se la linea "oggi" non è visibile nel viewport, ri-scrolla a oggi.
  const cont = document.getElementById('gantt-container');
  if (cont) {
    const timeline = cont.querySelector('.gantt-timeline');
    if (timeline) {
      const maxScroll = timeline.scrollWidth - cont.clientWidth;
      if (cont.scrollLeft > maxScroll) cont.scrollLeft = Math.max(0, maxScroll);
    }
    const line = cont.querySelector('.gantt-today-line');
    if (line) {
      const lineLeft = parseFloat(line.style.left) || 0;
      const sideW = cont.querySelector('.gantt-side')?.offsetWidth || 0;
      const viewStart = cont.scrollLeft;
      const viewEnd = viewStart + cont.clientWidth - sideW;
      // Se oggi è fuori dalla viewport, ri-centra a 1/3
      if (lineLeft < viewStart || lineLeft > viewEnd) {
        const visibile = cont.clientWidth - sideW;
        cont.scrollLeft = Math.max(0, lineLeft - visibile / 3);
      }
    }
  }
}

// ---- Drag delle barre del Gantt ----
function abilitaDragGantt(dayW, minDate) {
  const container = document.getElementById('gantt-container');
  if (!container) return;
  const body = container.querySelector('.gantt-body');
  if (!body) return;

  // Drag delle milestone: solo move
  body.querySelectorAll('.gantt-milestone').forEach(ms => {
    ms.addEventListener('mousedown', e => {
      const id = ms.dataset.id;
      const t = stato.task.find(x => x.id === id);
      if (!t) return;
      const startX = e.clientX;
      const startLeft = parseFloat(ms.style.left);
      const inizioOriginale = t.inizio;
      let mosso = false;
      e.preventDefault();
      document.body.style.userSelect = 'none';
      ms.classList.add('dragging');

      function onMove(ev) {
        const dx = ev.clientX - startX;
        const dGiorni = Math.round(dx / dayW);
        if (Math.abs(dx) > 3) mosso = true;
        ms.style.left = (startLeft + dGiorni * dayW) + 'px';
      }
      function onUp() {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        document.body.style.userSelect = '';
        ms.classList.remove('dragging');
        if (!mosso) { apriModaleTask(id); return; }
        const finalLeft = parseFloat(ms.style.left);
        const offsetInizio = Math.round((finalLeft + 9 - dayW / 2) / dayW);
        const nuova = new Date(minDate);
        nuova.setDate(nuova.getDate() + offsetInizio);
        const iso = dataISO(nuova);
        if (iso === inizioOriginale) return;
        t.inizio = iso; t.fine = iso;
        salvaStato();
        aggiornaViste();
      }
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  });

  body.querySelectorAll('.gantt-bar').forEach(bar => {
    // Le epiche hanno date derivate dai figli: non draggable
    if (bar.dataset.readonly) {
      // Su smartphone le barre epica usano SOLO il toggle (registrato in
      // renderGantt). Niente listener qui per non aprire la modale.
      if (window.innerWidth <= 900 && bar.classList.contains('gantt-bar-epica')) return;
      bar.addEventListener('click', () => apriModaleTask(bar.dataset.id));
      return;
    }
    bar.addEventListener('mousedown', e => {
      // Distinguo click vs drag — il click apre il modal solo se non si è spostato
      const side = e.target.dataset.side; // 'left' | 'right' | undefined
      const mode = side === 'left' ? 'resize-left'
                 : side === 'right' ? 'resize-right'
                 : 'move';

      const id = bar.dataset.id;
      const t = stato.task.find(x => x.id === id);
      if (!t) return;

      const startX = e.clientX;
      const startLeft = parseFloat(bar.style.left);
      const startWidth = parseFloat(bar.style.width);
      const inizioOriginale = t.inizio;
      const fineOriginale = t.fine;
      let mosso = false;

      e.preventDefault();
      document.body.style.userSelect = 'none';
      bar.classList.add('dragging');

      function onMove(ev) {
        const dx = ev.clientX - startX;
        const dGiorni = Math.round(dx / dayW);
        if (Math.abs(dx) > 3) mosso = true;

        if (mode === 'move') {
          bar.style.left = (startLeft + dGiorni * dayW) + 'px';
        } else if (mode === 'resize-right') {
          const newW = Math.max(dayW, startWidth + dGiorni * dayW);
          bar.style.width = newW + 'px';
        } else if (mode === 'resize-left') {
          const newLeft = Math.min(startLeft + dGiorni * dayW, startLeft + startWidth - dayW);
          const newW = startWidth - (newLeft - startLeft);
          bar.style.left = newLeft + 'px';
          bar.style.width = newW + 'px';
        }
      }

      function onUp() {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        document.body.style.userSelect = '';
        bar.classList.remove('dragging');

        if (!mosso) {
          apriModaleTask(id);
          return;
        }

        // Calcola le nuove date dai pixel
        const finalLeft = parseFloat(bar.style.left);
        const finalWidth = parseFloat(bar.style.width);
        const offsetInizio = Math.round(finalLeft / dayW);
        const giorniDurata = Math.max(1, Math.round(finalWidth / dayW));
        const nuovoInizio = new Date(minDate);
        nuovoInizio.setDate(nuovoInizio.getDate() + offsetInizio);
        const nuovaFine = new Date(nuovoInizio);
        nuovaFine.setDate(nuovaFine.getDate() + giorniDurata - 1);

        t.inizio = dataISO(nuovoInizio);
        t.fine = dataISO(nuovaFine);
        if (t.inizio === inizioOriginale && t.fine === fineOriginale) return;
        salvaStato();
        aggiornaViste();
      }

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  });
}

// ---- Frecce dipendenze (Manhattan) ----
function disegnaFrecceDipendenze(dayW, minDate) {
  const svg = document.querySelector('.gantt-arcs');
  if (!svg) return;
  const ns = 'http://www.w3.org/2000/svg';
  // Indice riga di ogni task secondo l'ordine gerarchico visibile (rispetta il collasso)
  const ordinati = ordineGerarchicoTask(true);
  const rowIndex = new Map(ordinati.map(({ task }, i) => [task.id, i]));

  // Definisci marker freccia una sola volta
  svg.innerHTML = `
    <defs>
      <marker id="arrow-head" viewBox="0 0 10 10" refX="8" refY="5"
              markerWidth="6" markerHeight="6" orient="auto-start-reverse">
        <path d="M0,0 L10,5 L0,10 z" fill="#64748b"/>
      </marker>
    </defs>`;

  stato.task.forEach(target => {
    if (!target.dipendenze?.length) return;
    const tIdx = rowIndex.get(target.id);
    if (tIdx == null) return;

    target.dipendenze.forEach(depId => {
      const source = stato.task.find(x => x.id === depId);
      if (!source) return;
      const sIdx = rowIndex.get(source.id);
      if (sIdx == null) return;

      const srcEnd = new Date(source.fine);
      const tgtStart = new Date(target.inizio);
      const x1 = (Math.round((srcEnd - minDate) / 86400000) + 1) * dayW;
      const x2 = Math.round((tgtStart - minDate) / 86400000) * dayW;
      const y1 = sIdx * 40 + 20;
      const y2 = tIdx * 40 + 20;

      // Path Manhattan: orizzontale → verticale → orizzontale
      // Se target inizia prima della fine del source → dipendenza violata
      const violata = x2 < x1;
      const midX = violata ? x1 + 12 : (x1 + x2) / 2;
      const d = `M ${x1} ${y1} L ${midX} ${y1} L ${midX} ${y2} L ${x2} ${y2}`;

      const path = document.createElementNS(ns, 'path');
      path.setAttribute('d', d);
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke', violata ? '#dc2626' : '#64748b');
      path.setAttribute('stroke-width', '1.5');
      path.setAttribute('stroke-dasharray', violata ? '4 3' : '');
      path.setAttribute('marker-end', 'url(#arrow-head)');
      svg.appendChild(path);
    });
  });
}

function cambiaViewMode(vm) {
  viewModeCorrente = vm;
  // Aggiorna evidenza pillgroup sia nel Gantt che nel Workload e nella bottom-bar mobile
  document.querySelectorAll('[data-view]').forEach(b =>
    b.classList.toggle('active', b.dataset.view === vm));
  renderGantt();
  renderWorkload();
}

function abilitaRiordinoSideRows(container) {
  const side = container.querySelector('.gantt-side-body');
  if (!side) return;
  let draggingId = null;

  side.querySelectorAll('.gantt-side-row[draggable="true"]').forEach(row => {
    row.addEventListener('dragstart', e => {
      draggingId = row.dataset.id;
      e.dataTransfer.effectAllowed = 'move';
      // Necessario per Firefox
      try { e.dataTransfer.setData('text/plain', draggingId); } catch {}
      row.classList.add('dragging-row');
    });
    row.addEventListener('dragend', () => {
      row.classList.remove('dragging-row');
      side.querySelectorAll('.drop-indicator').forEach(el => el.classList.remove('drop-indicator', 'drop-prima', 'drop-dopo'));
      draggingId = null;
    });
    row.addEventListener('dragover', e => {
      if (!draggingId || row.dataset.id === draggingId) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const rect = row.getBoundingClientRect();
      const middle = rect.top + rect.height / 2;
      side.querySelectorAll('.drop-indicator').forEach(el =>
        el.classList.remove('drop-indicator', 'drop-prima', 'drop-dopo'));
      row.classList.add('drop-indicator', e.clientY < middle ? 'drop-prima' : 'drop-dopo');
    });
    row.addEventListener('dragleave', () => {
      row.classList.remove('drop-indicator', 'drop-prima', 'drop-dopo');
    });
    row.addEventListener('drop', e => {
      e.preventDefault();
      if (!draggingId || row.dataset.id === draggingId) return;
      const rect = row.getBoundingClientRect();
      const middle = rect.top + rect.height / 2;
      const posizione = e.clientY < middle ? 'prima' : 'dopo';
      riordinaTask(draggingId, row.dataset.id, posizione);
    });
  });
}

function toggleCollassoEpica(epicaId) {
  if (epicheCollassate.has(epicaId)) epicheCollassate.delete(epicaId);
  else epicheCollassate.add(epicaId);
  renderGantt();
  renderTask();
}

function toggleCollassoProgetto(key) {
  if (progettiCollassati.has(key)) progettiCollassati.delete(key);
  else progettiCollassati.add(key);
  renderGantt();
}

// ===== WEEK STRIP (sopra il Gantt) =====

// Offset in giorni rispetto a oggi: 0 = settimana corrente, -7 = precedente, +7 = successiva
let weekStripOffset = 0;
let weekStripGiornoSelezionato = null; // ISO del giorno cliccato (per evidenziazione)

const GIORNI_NOMI = ['Dom', 'Lun', 'Mar', 'Mer', 'Gio', 'Ven', 'Sab'];

function renderWeekStrip() {
  // Renderizza sia la week strip Gantt che quella Workload
  renderWeekStripIn('week-strip-days', 'gantt');
  renderWeekStripIn('week-strip-days-wl', 'workload');
}

function renderWeekStripIn(containerId, vista) {
  const container = document.getElementById(containerId);
  if (!container) return;

  const oggiISO = dataISOoggi();
  const oggi = new Date(oggiISO);
  const giornoSett = oggi.getDay();
  const lunOffset = giornoSett === 0 ? -6 : 1 - giornoSett;
  const lunedi = new Date(oggi);
  lunedi.setDate(oggi.getDate() + lunOffset + weekStripOffset);

  const giorni = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(lunedi);
    d.setDate(lunedi.getDate() + i);
    giorni.push(d);
  }

  container.innerHTML = giorni.map(d => {
    const iso = dataISO(d);
    const isToday = iso === oggiISO;
    const isSel = iso === weekStripGiornoSelezionato;
    const weekend = d.getDay() === 0 || d.getDay() === 6;
    const cls = [
      'week-day',
      isToday && 'week-today',
      isSel && 'week-selected',
      weekend && 'week-weekend'
    ].filter(Boolean).join(' ');
    return `
      <button type="button" class="${cls}" data-iso="${iso}">
        <span class="week-day-name">${GIORNI_NOMI[d.getDay()]}</span>
        <span class="week-day-num">${d.getDate()}</span>
      </button>`;
  }).join('');

  container.querySelectorAll('.week-day').forEach(el => {
    el.addEventListener('click', () => {
      weekStripGiornoSelezionato = el.dataset.iso;
      if (vista === 'workload') {
        scrollWorkloadAlGiorno(el.dataset.iso);
      } else {
        scrollGanttAlGiorno(el.dataset.iso);
      }
      renderWeekStrip();
    });
  });
}

function scrollWorkloadAlGiorno(isoTarget) {
  const container = document.getElementById('workload-container');
  if (!container) return;
  const range = calcolaRangeGantt(filtri.workload);
  if (!range) return;
  if (isoTarget < range.min || isoTarget > range.max) {
    filtri.workload.dataDa = isoTarget;
    const fine = new Date(isoTarget);
    fine.setDate(fine.getDate() + 14);
    filtri.workload.dataA = dataISO(fine);
    popolaFiltri();
    renderWorkload();
    setTimeout(() => scrollWorkloadAlGiorno(isoTarget), 50);
    return;
  }
  const giorni = rangeDateISO(range.min, range.max);
  const idx = giorni.indexOf(isoTarget);
  if (idx === -1) return;
  const dayW = calcolaDayWAdattivo('workload-container', 240, giorni.length);
  const xTarget = idx * dayW + dayW / 2;
  const side = container.querySelector('.wl-side');
  const sideW = side ? side.offsetWidth : 0;
  const visibile = container.clientWidth - sideW;
  container.scrollLeft = xTarget - visibile / 2;
}

function scrollWorkloadAOggi() {
  const container = document.getElementById('workload-container');
  if (!container) return;
  const line = container.querySelector('.wl-today-line');
  const side = container.querySelector('.wl-side');
  if (!line) return;
  const lineLeft = parseFloat(line.style.left) || 0;
  const sideW = side ? side.offsetWidth : 0;
  // Oggi a 1/3 della viewport (coerente con scrollAOggi del Gantt)
  const visibile = container.clientWidth - sideW;
  container.scrollLeft = Math.max(0, lineLeft - visibile / 3);
}

function scrollGanttAlGiorno(isoTarget) {
  const container = document.getElementById('gantt-container');
  if (!container) return;
  const body = container.querySelector('.gantt-body');
  if (!body) return;

  // Calcola posizione X del giorno nel chart corrente
  const range = calcolaRangeGantt(filtri.gantt);
  if (!range) return;
  if (isoTarget < range.min || isoTarget > range.max) {
    // Il giorno è fuori dal range: imposta il filtro per includerlo
    filtri.gantt.dataDa = isoTarget;
    const fine = new Date(isoTarget);
    fine.setDate(fine.getDate() + 14);
    filtri.gantt.dataA = dataISO(fine);
    popolaFiltri();
    renderGantt();
    setTimeout(() => scrollGanttAlGiorno(isoTarget), 50);
    return;
  }
  const giorni = rangeDateISO(range.min, range.max);
  const idx = giorni.indexOf(isoTarget);
  if (idx === -1) return;
  // dayW corrente (riprende il calcolo)
  const dayW = calcolaDayWAdattivo('gantt-container', 240, giorni.length);
  const xTarget = idx * dayW + dayW / 2;
  const side = container.querySelector('.gantt-side');
  const sideW = side ? side.offsetWidth : 0;
  const visibile = container.clientWidth - sideW;
  container.scrollLeft = xTarget - visibile / 2;
}

function scrollAOggi() {
  const container = document.getElementById('gantt-container');
  if (!container) return;
  const line = container.querySelector('.gantt-today-line');
  const side = container.querySelector('.gantt-side');
  if (!line) return;
  const lineLeft = parseFloat(line.style.left) || 0;
  const sideW = side ? side.offsetWidth : 0;
  // Posiziona "oggi" a 1/3 della viewport (cosi' resta visibile cio' che e'
  // gia' iniziato a sinistra e c'e' piu' spazio per quello che sta arrivando)
  const visibile = container.clientWidth - sideW;
  container.scrollLeft = Math.max(0, lineLeft - visibile / 3);
}

// ===== WORKLOAD: calcolo carico (estratto per essere riutilizzato dal modal dettaglio) =====
function calcolaCaricoPersone(ammessi = null) {
  const carico = {};
  stato.persone.forEach(p => { carico[p.id] = {}; });
  stato.task.forEach(t => {
    if (eEpica(t.id) || eMilestone(t.id)) return;
    if (t.stato === 'done') return;
    if (ammessi && !ammessi.has(t.id)) return;
    if (!t.assegnazioni.length) return;
    const oreTask = oreResidueTask(t);
    if (!oreTask) return;
    const { inizio, fine } = dateEffettive(t);
    if (!inizio || !fine) return;
    const giorniTask = rangeDateISO(inizio, fine);
    t.assegnazioni.forEach(a => {
      if (!carico[a.personaId]) return;
      const orePerGiorno = oreGiornaliereAssegnazione(t, a);
      if (!orePerGiorno) return;
      giorniTask.forEach(g => {
        if (!eGiornoLavorativo(g, a.personaId)) return;
        if (!carico[a.personaId][g]) carico[a.personaId][g] = { ore: 0, tasks: [] };
        carico[a.personaId][g].ore += orePerGiorno;
        carico[a.personaId][g].tasks.push({ taskId: t.id, effort: a.effort, ore: orePerGiorno });
      });
    });
  });
  return carico;
}

// ===== WORKLOAD (timeline) =====

function renderWorkload() {
  if (isMobileListView()) {
    return renderWorkloadListView();
  }
  const container = document.getElementById('workload-container');
  if (!container) return;

  if (!stato.persone.length || !stato.task.length) {
    container.innerHTML = '<p class="empty-state">Aggiungi persone e task per visualizzare il workload.</p>';
    return;
  }

  const range = calcolaRangeGantt(filtri.workload);
  const giorni = rangeDateISO(range.min, range.max);
  const dayW = calcolaDayWAdattivo('workload-container', 240, giorni.length);
  const totaleW = giorni.length * dayW;
  const minDate = new Date(range.min);
  const ammessi = taskAmmessi(filtri.workload);

  // ---- Header date (riuso schema del Gantt) ----
  const mesi = [];
  giorni.forEach(g => {
    const key = g.slice(0, 7);
    const ultimo = mesi[mesi.length - 1];
    if (!ultimo || ultimo.key !== key) {
      const d = new Date(g);
      mesi.push({ key, label: `${MESI_IT[d.getMonth()]} ${d.getFullYear()}`, count: 1 });
    } else ultimo.count++;
  });
  const monthRow = mesi.map(m =>
    `<div class="gantt-month-cell" style="width:${m.count * dayW}px">${m.label}</div>`
  ).join('');
  const dayRow = giorni.map(g => {
    const d = new Date(g);
    const we = eWeekend(g) ? ' weekend' : '';
    let label = '';
    if (viewModeCorrente === 'Day') label = d.getDate();
    else if ((viewModeCorrente === 'Week' || viewModeCorrente === 'Month') && d.getDay() === 1) label = d.getDate();
    return `<div class="gantt-day-cell${we}" style="width:${dayW}px">${label}</div>`;
  }).join('');

  // ---- Pre-calcolo: ore/giorno per ciascuna persona (filtri applicati) ----
  const carico = calcolaCaricoPersone(ammessi);

  // Strisce weekend (sfondo unico, fuori dalle righe)
  const weekendOverlay = giorni.map((g, i) =>
    eWeekend(g)
      ? `<div class="wl-weekend" style="left:${i * dayW}px; width:${dayW}px"></div>`
      : ''
  ).join('');

  // Bande mensili alternate
  const bandeMesiWL = [];
  const dividersWL = [];
  let dayCursorWL = 0;
  mesi.forEach((m, idx) => {
    if (idx % 2 === 1) {
      bandeMesiWL.push(`<div class="gantt-month-band" style="left:${dayCursorWL * dayW}px; width:${m.count * dayW}px"></div>`);
    }
    if (idx > 0) {
      dividersWL.push(`<div class="gantt-month-divider" style="left:${dayCursorWL * dayW}px"></div>`);
    }
    dayCursorWL += m.count;
  });
  const sfondoStrutturatoWL = bandeMesiWL.join('') + dividersWL.join('');

  // Linea verticale "oggi"
  const oggiISO = dataISOoggi();
  let todayLine = '';
  if (oggiISO >= range.min && oggiISO <= range.max) {
    const off = Math.round((new Date(oggiISO) - minDate) / 86400000);
    todayLine = `<div class="wl-today-line" style="left:${off * dayW + dayW / 2}px"></div>`;
  }

  // Mappa veloce festività
  const fest = mapFestivita();

  // Altezza per swimlane di una persona (numero di corsie × altezza barra)
  const LANE_H = 22; // px per corsia task
  const HEAT_H = 24; // px heat strip
  const ROW_PAD = 6;

  // ---- Righe persona (filtrate, raggruppate per team) ----
  const sideRowsArr = [];
  const bodyRowsArr = [];
  let personeMostrate = filtri.workload.persone.length
    ? stato.persone.filter(p => filtri.workload.persone.includes(p.id))
    : stato.persone.slice();
  // Nascondi persone con flag nascosta (modal "Gestisci visibilità persone")
  personeMostrate = personeMostrate.filter(p => !p.nascosta);
  // Filtro team: se attivo, mostra solo le persone di quel team
  if (filtri.workload.team) {
    personeMostrate = personeMostrate.filter(p => p.teamId === filtri.workload.team);
  }

  // Ordina per: team.ordine → persona.ordine → nome. Non assegnati (teamId null) in fondo.
  const teamOrdMap = new Map(stato.team.map(t => [t.id, t.ordine || 0]));
  personeMostrate.sort((a, b) => {
    const ta = a.teamId ? (teamOrdMap.get(a.teamId) ?? 999) : 9999;
    const tb = b.teamId ? (teamOrdMap.get(b.teamId) ?? 999) : 9999;
    if (ta !== tb) return ta - tb;
    if ((a.ordine || 0) !== (b.ordine || 0)) return (a.ordine || 0) - (b.ordine || 0);
    return (a.nome || '').localeCompare(b.nome || '');
  });

  // Inserisco header di team tra le righe (tracked per sapere quando il team cambia)
  let lastTeamId = '__none__';

  personeMostrate.forEach(p => {
    // Header team: inserisco quando il team cambia
    const curTeamId = p.teamId || '__unassigned__';
    if (curTeamId !== lastTeamId && stato.team.length > 0) {
      lastTeamId = curTeamId;
      const tm = stato.team.find(t => t.id === curTeamId);
      const teamLabel = tm ? tm.nome : 'Non assegnati';
      const teamColor = tm ? tm.colore : '#64748b';
      const membriCount = personeMostrate.filter(x => (x.teamId || '__unassigned__') === curTeamId).length;
      sideRowsArr.push(`
        <div class="wl-side-row wl-team-header" style="border-left:4px solid ${escapeHtml(teamColor)}">
          <strong class="wl-team-label" style="color:${escapeHtml(teamColor)}">${escapeHtml(teamLabel)}</strong>
          <small>${membriCount} persone</small>
        </div>`);
      bodyRowsArr.push(`
        <div class="wl-body-row wl-team-header-body">
          <div class="wl-timeline" style="width:${totaleW}px;position:relative;height:36px"></div>
        </div>`);
    }
    const capacitaG = p.fte * ORE_GIORNO_PIENE;

    // Task assegnati a questa persona (solo foglie, escluse milestone), filtrati
    const tasksPersona = stato.task
      .filter(t => !eEpica(t.id) && !eMilestone(t.id))
      .filter(t => t.stato !== 'done')
      .filter(t => !ammessi || ammessi.has(t.id))
      .filter(t => t.assegnazioni.some(a => a.personaId === p.id))
      // Escludi sub-task senza date proprie dalla visualizzazione barre:
      // contribuiscono al % giornaliero (heat strip) ma non hanno barra
      // separata, altrimenti si creano 20+ linee impilate dal parent.
      .filter(t => t.inizio && t.fine)
      .sort((a, b) => (a.inizio || '').localeCompare(b.inizio || ''));

    // Algoritmo greedy per assegnare i task a corsie senza sovrapposizioni
    const corsie = []; // ogni corsia è una array di task (in ordine)
    const laneOf = new Map();
    tasksPersona.forEach(t => {
      let assigned = -1;
      const tDate = dateEffettive(t);
      for (let i = 0; i < corsie.length; i++) {
        const ultima = corsie[i][corsie[i].length - 1];
        const uDate = dateEffettive(ultima);
        if ((uDate.fine || '') < (tDate.inizio || '')) { assigned = i; break; }
      }
      if (assigned === -1) {
        corsie.push([t]);
        assigned = corsie.length - 1;
      } else {
        corsie[assigned].push(t);
      }
      laneOf.set(t.id, assigned);
    });
    const numCorsie = Math.max(1, corsie.length);
    const taskAreaH = numCorsie * LANE_H + ROW_PAD;
    // Min height per garantire l'allineamento con la side column (~2 righe di testo)
    const rowH = Math.max(taskAreaH + HEAT_H, 60);

    // Side row (con altezza dinamica)
    sideRowsArr.push(`
      <div class="wl-side-row" style="border-left: 3px solid ${escapeHtml(p.colore)}; height:${rowH}px"
           title="${escapeHtml(p.ruolo)} · FTE ${p.fte} · ${capacitaG}h/g · ${tasksPersona.length} task">
        <strong>${avatar(p, 'sm')} ${escapeHtml(p.nome)}</strong>
        <small>${escapeHtml(p.ruolo)} · ${capacitaG}h/g</small>
      </div>`);

    // Barre task — ciascuna posizionata su una corsia diversa
    const barreTask = tasksPersona.map(t => {
      // Date ereditate dal parent per sub-task senza date proprie
      const { inizio: tInizio, fine: tFine } = dateEffettive(t);
      if (!tInizio || !tFine) return '';
      const start = new Date(tInizio);
      const end = new Date(tFine);
      const off = Math.round((start - minDate) / 86400000);
      const dur = Math.round((end - start) / 86400000) + 1;
      const left = off * dayW;
      const width = Math.max(dur * dayW - 2, 6);
      const lane = laneOf.get(t.id);
      const top = lane * LANE_H + 3;
      const a = t.assegnazioni.find(x => x.personaId === p.id);
      const oreEff = oreResidueTask(t);
      const orePersona = oreEff * (Number(a.effort) || 0) / 100;
      const tooltip = `${t.nome}\n${a.effort}% × ${oreEff.toFixed(1)}h = ${orePersona.toFixed(1)}h`;
      return `<div class="wl-task-bar stato-${t.stato}"
                   style="left:${left}px; width:${width}px; top:${top}px"
                   data-id="${t.id}"
                   title="${escapeHtml(tooltip)}"
        ><span class="wl-task-handle handle-left" data-side="left"></span><span class="wl-task-label">${escapeHtml(t.nome)}</span><span class="wl-task-handle handle-right" data-side="right"></span></div>`;
    }).join('');

    // Heat strip giornaliero
    const heatCells = giorni.map((g, i) => {
      const we = eWeekend(g);
      const fNome = fest[g];
      const ferieNome = eInFerie(g, p.id);
      if (we) {
        return `<div class="wl-heat wl-heat-we" style="left:${i * dayW}px; width:${dayW}px"
                     title="${escapeHtml(g + '\nWeekend')}"></div>`;
      }
      if (fNome) {
        return `<div class="wl-heat wl-heat-festa" style="left:${i * dayW}px; width:${dayW}px"
                     title="${escapeHtml(g + '\nFestività: ' + fNome)}">★</div>`;
      }
      if (ferieNome) {
        return `<div class="wl-heat wl-heat-ferie" style="left:${i * dayW}px; width:${dayW}px"
                     data-persona="${p.id}" data-giorno="${g}"
                     title="${escapeHtml(g + '\nFerie: ' + ferieNome)}">F</div>`;
      }
      const entry = carico[p.id][g];
      const ore = entry ? entry.ore : 0;
      const perc = capacitaG > 0 ? (ore / capacitaG * 100) : 0;
      let cls = 'wl-heat-zero';
      if (perc > 100) cls = 'wl-heat-over';
      else if (perc >= 80) cls = 'wl-heat-warn';
      else if (perc > 0) cls = 'wl-heat-ok';
      const label = ore > 0
        ? (dayW >= 30 ? `${Math.round(perc)}%` : '')
        : '';
      const tooltip = ore > 0
        ? `${g}\n${ore.toFixed(1)}h / ${capacitaG}h = ${Math.round(perc)}%\n(click per dettagli)`
        : `${g}\n-`;
      return `<div class="wl-heat ${cls}" data-persona="${p.id}" data-giorno="${g}"
                   style="left:${i * dayW}px; width:${dayW}px"
                   title="${escapeHtml(tooltip)}">${label}</div>`;
    }).join('');

    bodyRowsArr.push(`
      <div class="wl-row" style="height:${rowH}px">
        <div class="wl-tasks-area" style="height:${taskAreaH}px">${barreTask}</div>
        <div class="wl-heat-area" style="height:${HEAT_H}px">${heatCells}</div>
      </div>`);
  });

  const sideRows = sideRowsArr.join('');
  const bodyRows = bodyRowsArr.join('');

  container.innerHTML = `
    <div id="workload-wrap">
      <div class="wl-side">
        <div class="wl-side-header">Persona</div>
        <div class="wl-side-body">${sideRows}</div>
      </div>
      <div class="wl-main">
        <div class="wl-timeline" style="width:${totaleW}px">
          <div class="gantt-header">
            <div class="gantt-header-row gantt-months">${monthRow}</div>
            <div class="gantt-header-row gantt-days">${dayRow}</div>
          </div>
          <div class="wl-body" style="width:${totaleW}px">
            ${sfondoStrutturatoWL}
            ${weekendOverlay}
            ${bodyRows}
            ${todayLine}
          </div>
        </div>
      </div>
    </div>
  `;

  // Drag delle wl-task-bar: move + resize-left + resize-right.
  // Senza spostamenti → click = apri modale.
  abilitaDragWorkload(dayW, minDate);

  // Click su una cella heat → apre il modal dettaglio giorno
  container.querySelectorAll('.wl-heat[data-persona][data-giorno]').forEach(el => {
    el.addEventListener('click', () => apriModaleGiorno(el.dataset.persona, el.dataset.giorno));
  });
}

// Drag/resize delle barre nella tab Workload. Speculare a abilitaDragGantt.
function abilitaDragWorkload(dayW, minDate) {
  const container = document.getElementById('workload-container');
  if (!container) return;
  container.querySelectorAll('.wl-task-bar').forEach(bar => {
    bar.addEventListener('mousedown', e => {
      const side = e.target.dataset?.side; // 'left' | 'right' | undefined
      const mode = side === 'left' ? 'resize-left'
                 : side === 'right' ? 'resize-right'
                 : 'move';

      const id = bar.dataset.id;
      const t = stato.task.find(x => x.id === id);
      if (!t) return;
      // Niente drag per task readonly (epiche/milestone), o se viewer
      if (t.tipo === 'epica' || t.tipo === 'milestone') return;
      if (!isEditor()) return;

      const startX = e.clientX;
      const startLeft = parseFloat(bar.style.left);
      const startWidth = parseFloat(bar.style.width);
      const inizioOriginale = t.inizio;
      const fineOriginale   = t.fine;
      let mosso = false;

      e.preventDefault();
      document.body.style.userSelect = 'none';
      bar.classList.add('dragging');

      function onMove(ev) {
        const dx = ev.clientX - startX;
        const dGiorni = Math.round(dx / dayW);
        if (Math.abs(dx) > 3) mosso = true;
        if (mode === 'move') {
          bar.style.left = (startLeft + dGiorni * dayW) + 'px';
        } else if (mode === 'resize-right') {
          const newW = Math.max(dayW, startWidth + dGiorni * dayW);
          bar.style.width = newW + 'px';
        } else if (mode === 'resize-left') {
          const newLeft = Math.min(startLeft + dGiorni * dayW, startLeft + startWidth - dayW);
          const newW = startWidth - (newLeft - startLeft);
          bar.style.left = newLeft + 'px';
          bar.style.width = newW + 'px';
        }
      }

      function onUp() {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        document.body.style.userSelect = '';
        bar.classList.remove('dragging');

        if (!mosso) {
          apriModaleTask(id);
          return;
        }
        // Calcola nuove date in pixel → ISO
        const finalLeft  = parseFloat(bar.style.left);
        const finalWidth = parseFloat(bar.style.width);
        const offsetInizio = Math.round(finalLeft / dayW);
        const giorniDurata = Math.max(1, Math.round(finalWidth / dayW));
        const nuovoInizio = new Date(minDate);
        nuovoInizio.setDate(nuovoInizio.getDate() + offsetInizio);
        const nuovaFine = new Date(nuovoInizio);
        nuovaFine.setDate(nuovaFine.getDate() + giorniDurata - 1);

        t.inizio = dataISO(nuovoInizio);
        t.fine   = dataISO(nuovaFine);
        if (t.inizio === inizioOriginale && t.fine === fineOriginale) return;
        salvaStato();
        aggiornaViste();
      }

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  });
}

// ---- Modal dettaglio giorno ----
function apriModaleGiorno(personaId, giornoISO) {
  const p = trovaPersona(personaId);
  if (!p) return;
  const overlay = document.getElementById('modal-giorno-overlay');
  const titolo = document.getElementById('modal-giorno-titolo');
  const body = document.getElementById('modal-giorno-body');
  const capacita = p.fte * ORE_GIORNO_PIENE;

  titolo.textContent = `${p.nome} · ${giornoISO}`;

  const etichettaNonLav = etichettaGiornoNonLavorativo(giornoISO, personaId);
  if (etichettaNonLav) {
    body.innerHTML = `
      <p class="hint">${escapeHtml(etichettaNonLav)} — nessun carico previsto.</p>
      <p><strong>Capacità del giorno</strong>: 0h (giorno non lavorativo)</p>`;
    overlay.classList.remove('hidden');
    return;
  }

  const carico = calcolaCaricoPersone();
  const entry = carico[personaId]?.[giornoISO];
  const ore = entry ? entry.ore : 0;
  const perc = capacita > 0 ? (ore / capacita * 100) : 0;
  const colCls = perc > 100 ? 'over' : perc >= 80 ? 'warn' : perc > 0 ? 'ok' : 'zero';

  const righeTask = entry?.tasks?.length
    ? entry.tasks.map(tk => {
        const t = stato.task.find(x => x.id === tk.taskId);
        if (!t) return '';
        const infoStato = STATI_TASK[t.stato] || STATI_TASK.todo;
        return `
          <li class="dettaglio-task">
            <div class="info-task">
              <span class="badge-stato stato-${t.stato}">${escapeHtml(infoStato.label)}</span>
              <strong>${escapeHtml(t.nome)}</strong>
              <span class="label-fte">${tk.effort}% × ${t.stimaOre}h</span>
              <span class="label-fte">→ ${tk.ore.toFixed(2)}h oggi</span>
            </div>
            <button class="btn btn-edit btn-sm" data-action="modal-giorno-modifica" data-id="${t.id}">Modifica</button>
          </li>`;
      }).join('')
    : '<li class="empty-state">Nessun task allocato in questo giorno.</li>';

  const barraPerc = Math.min(perc, 200);
  body.innerHTML = `
    <div class="dettaglio-riepilogo">
      <div><strong>Capacità</strong>: ${capacita}h (FTE ${p.fte})</div>
      <div><strong>Allocate</strong>: ${ore.toFixed(2)}h</div>
      <div class="dettaglio-perc ${colCls}"><strong>Carico</strong>: ${Math.round(perc)}%</div>
      <div class="dettaglio-barra-out">
        <div class="dettaglio-barra-in ${colCls}" style="width:${barraPerc / 2}%"></div>
      </div>
    </div>
    <h4 style="margin:1rem 0 0.5rem">Task allocati</h4>
    <ul class="lista">${righeTask}</ul>
  `;

  body.querySelectorAll('button[data-action="modal-giorno-modifica"]').forEach(btn => {
    btn.addEventListener('click', () => {
      chiudiModaleGiorno();
      apriModaleTask(btn.dataset.id);
    });
  });

  overlay.classList.remove('hidden');
}

function chiudiModaleGiorno() {
  document.getElementById('modal-giorno-overlay').classList.add('hidden');
}

// Riordina le epiche top-level (parentId=null) in base al loro punteggio
// Eisenhower (importanza + urgenza, desc). I task non-epica restano dove
// sono (l'ordine all'interno di un'epica non viene toccato).
function ordinaEpichePerEisenhower() {
  if (!isEditor()) return;
  const epiche = stato.task
    .filter(t => t.tipo === 'epica' && !t.parentId)
    .slice()
    .sort((a, b) => {
      const sa = (Number(a.importanza) || 3) + (Number(a.urgenza) || 3);
      const sb = (Number(b.importanza) || 3) + (Number(b.urgenza) || 3);
      if (sb !== sa) return sb - sa;
      return (a.nome || '').localeCompare(b.nome || '');
    });
  if (!epiche.length) {
    mostraToast('Nessuna epica top-level da riordinare.', 'info');
    return;
  }
  // Assegno nuovi `ordine` partendo da 0. Le altre task top-level (es. task
  // singole non sotto epica, milestone) le metto in coda mantenendo il loro
  // ordine relativo precedente.
  const altreTop = stato.task
    .filter(t => !t.parentId && t.tipo !== 'epica')
    .slice()
    .sort((a, b) => (Number(a.ordine) || 0) - (Number(b.ordine) || 0));

  let i = 0;
  epiche.forEach(t => { t.ordine = i++; });
  altreTop.forEach(t => { t.ordine = i++; });

  salvaStato();
  aggiornaViste();
  mostraToast(`✅ ${epiche.length} epiche riordinate per Eisenhower.`, 'success');
}

// ===== MATRICE DI EISENHOWER =====

// Quadrante di un task in base a importanza/urgenza (soglia >= 3 = alto)
function quadranteEisen(t) {
  const imp = Number(t.importanza) || 3;
  const urg = Number(t.urgenza)    || 3;
  const impAlto = imp >= 3;
  const urgAlto = urg >= 3;
  if (impAlto && urgAlto) return 'do';        // I: Importante & Urgente → Fai subito
  if (impAlto && !urgAlto) return 'plan';      // II: Importante, non urgente → Pianifica
  if (!impAlto && urgAlto) return 'delegate';  // III: Urgente, non importante → Delega
  return 'drop';                               // IV: Né urgente né importante → Elimina
}

function renderEisenhower() {
  const container = document.getElementById('eisen-container');
  if (!container) return;

  // Popola e sincronizza il select progetto della toolbar Eisenhower
  popolaSelectProgettoEisen();

  const ammessi = taskAmmessi(filtri.eisenhower);
  // Filtra in base alla modalità selezionata (epiche / task / tutti)
  let elenco = stato.task.filter(t => {
    if (!ammessi.has(t.id)) return false;
    if (t.tipo === 'milestone') return false;
    if (eisenModo === 'epiche') return t.tipo === 'epica';
    if (eisenModo === 'task')   return t.tipo === 'task';
    return t.tipo === 'epica' || t.tipo === 'task';
  });

  // Raggruppa per coordinate (urgenza, importanza)
  // grid[imp][urg] = [task,...] con imp ∈ 1..4, urg ∈ 1..4
  const grid = {};
  for (let imp = 1; imp <= 4; imp++) {
    grid[imp] = {};
    for (let urg = 1; urg <= 4; urg++) grid[imp][urg] = [];
  }
  elenco.forEach(t => {
    const imp = clampEisen(t.importanza, 3);
    const urg = clampEisen(t.urgenza, 3);
    grid[imp][urg].push(t);
  });

  const cardHTML = t => {
    const imp = clampEisen(t.importanza, 3);
    const urg = clampEisen(t.urgenza, 3);
    const isEpica = t.tipo === 'epica';
    // Stato visualizzato: per le epiche derivato da aggregaEpica, per i task il proprio
    const statoVis = isEpica ? (aggregaEpica(t).stato || 'todo') : (t.stato || 'todo');
    const persone = isEpica
      ? raccogliAssegnatariEpica(t)
      : (t.assegnazioni || []).map(a => trovaPersona(a.personaId)).filter(Boolean);
    const avatars = persone.slice(0, 3).map(p => avatar(p, 'xs')).join('');
    const extra = persone.length > 3
      ? `<span class="avatar avatar-xs" style="background:#64748b">+${persone.length - 3}</span>`
      : '';
    return `
      <div class="eisen-card stato-${statoVis}${isEpica ? ' eisen-card-epica' : ''}"
           data-id="${t.id}"
           draggable="true"
           title="${escapeHtml(t.nome)} · ${statoVis} · Importanza ${imp} · Urgenza ${urg} (trascina per spostare)">
        <span class="eisen-card-name">${escapeHtml(t.nome)}</span>
        ${avatars || extra ? `<span class="avatar-group">${avatars}${extra}</span>` : ''}
      </div>`;
  };

  const cellHTML = (imp, urg) => {
    const tasks = grid[imp][urg];
    const impAlto = imp >= 3;
    const urgAlto = urg >= 3;
    const quad = impAlto && urgAlto ? 'do'
               : impAlto && !urgAlto ? 'plan'
               : !impAlto && urgAlto ? 'delegate'
               : 'drop';
    return `
      <div class="eisen-cell eisen-q-${quad}" data-imp="${imp}" data-urg="${urg}">
        ${tasks.length
          ? tasks.map(cardHTML).join('')
          : '<span class="eisen-cell-empty">·</span>'}
      </div>`;
  };

  // Header X: "Urgente" a sinistra (col urg=4), "Non urgente" a destra (col urg=1)
  // Header Y: "Importante" in alto (riga imp=4), "Non importante" in basso (riga imp=1)
  // Righe: importanza 4 → 1 dall'alto al basso
  // Colonne: urgenza 4 → 1 da sinistra a destra (INVERSO rispetto a prima)
  let righe = '';
  for (let imp = 4; imp >= 1; imp--) {
    righe += `<div class="eisen-axis-label eisen-axis-y">${imp}</div>`;
    for (let urg = 4; urg >= 1; urg--) {
      righe += cellHTML(imp, urg);
    }
  }

  // Header colonne: numerici 4..1
  let headerUrg = '<div class="eisen-axis-corner"></div>';
  for (let urg = 4; urg >= 1; urg--) {
    headerUrg += `<div class="eisen-axis-label eisen-axis-x">${urg}</div>`;
  }

  container.innerHTML = `
    <div class="eisen-axis-title eisen-axis-title-x">
      <span>Urgente</span>
      <span>Non urgente</span>
    </div>
    <div class="eisen-axis-title eisen-axis-title-y">
      <span>Importante</span>
      <span>Non importante</span>
    </div>
    <div class="eisen-plane">
      ${headerUrg}
      ${righe}
    </div>
    <div class="eisen-legend">
      <span class="eisen-legend-item"><span class="eisen-legend-dot eisen-q-do"></span>Fai subito</span>
      <span class="eisen-legend-item"><span class="eisen-legend-dot eisen-q-plan"></span>Pianifica</span>
      <span class="eisen-legend-item"><span class="eisen-legend-dot eisen-q-delegate"></span>Delega</span>
      <span class="eisen-legend-item"><span class="eisen-legend-dot eisen-q-drop"></span>Elimina</span>
    </div>
  `;

  // Click card → apre il modal di modifica
  container.querySelectorAll('.eisen-card').forEach(el => {
    el.addEventListener('click', () => apriModaleTask(el.dataset.id));
  });

  // Drag-and-drop: sempre attivo, il drop fa nulla per i viewer
  abilitaDragEisen(container);
}

function abilitaDragEisen(container) {
  let draggingId = null;
  const cards = container.querySelectorAll('.eisen-card');
  const cells = container.querySelectorAll('.eisen-cell');
  console.log('[eisen-dnd] setup:', cards.length, 'cards', cells.length, 'cells');

  cards.forEach(card => {
    card.setAttribute('draggable', 'true');
    card.addEventListener('dragstart', e => {
      if (!isEditor()) { e.preventDefault(); return; }
      draggingId = card.dataset.id;
      card.classList.add('dragging');
      try {
        e.dataTransfer.setData('text/plain', draggingId);
        e.dataTransfer.effectAllowed = 'move';
      } catch (err) { console.warn('[eisen-dnd] setData fallita:', err); }
      console.log('[eisen-dnd] dragstart', card.dataset.id);
    });
    card.addEventListener('dragend', () => {
      card.classList.remove('dragging');
      draggingId = null;
      container.querySelectorAll('.eisen-cell.drag-over')
        .forEach(c => c.classList.remove('drag-over'));
    });
  });

  cells.forEach(cell => {
    // dragenter è importante per alcuni browser (Firefox specialmente):
    // serve sia preventDefault qui, sia su dragover, per accettare il drop
    cell.addEventListener('dragenter', e => {
      if (!draggingId) return;
      e.preventDefault();
      cell.classList.add('drag-over');
    });
    cell.addEventListener('dragover', e => {
      if (!draggingId) return;
      e.preventDefault();
      try { e.dataTransfer.dropEffect = 'move'; } catch {}
      cell.classList.add('drag-over');
    });
    cell.addEventListener('dragleave', e => {
      // dragleave fire anche entrando in figli: rimuoviamo solo se usciamo davvero
      if (e.relatedTarget && cell.contains(e.relatedTarget)) return;
      cell.classList.remove('drag-over');
    });
    cell.addEventListener('drop', e => {
      e.preventDefault();
      cell.classList.remove('drag-over');
      const id = draggingId || (e.dataTransfer && e.dataTransfer.getData('text/plain'));
      console.log('[eisen-dnd] drop', id, '→ imp=', cell.dataset.imp, 'urg=', cell.dataset.urg);
      if (!id) return;
      const t = stato.task.find(x => x.id === id);
      if (!t) return;
      if (!isEditor()) return;
      const newImp = clampEisen(cell.dataset.imp, t.importanza);
      const newUrg = clampEisen(cell.dataset.urg, t.urgenza);
      if (t.importanza === newImp && t.urgenza === newUrg) return;
      t.importanza = newImp;
      t.urgenza    = newUrg;
      salvaStato();
      aggiornaViste();
    });
  });
}

// Aggregazione persone-ore-costo per un'epica (somma tra tutti i leaf
// descendant). Restituisce un array ordinato per ore desc.
function aggregazioniEpica(epica) {
  const acc = new Map(); // personaId → { persona, ore, costo, taskCount, effortSum }
  function applica(leaf) {
    if (!leaf || leaf.tipo === 'milestone') return;
    const stima = Number(leaf.stimaOre) || 0;
    (leaf.assegnazioni || []).forEach(a => {
      const p = trovaPersona(a.personaId);
      if (!p) return;
      const effort = Number(a.effort) || 0;
      const ore = stima * effort / 100;
      const tariffa = Number(p.costoOrario) || 0;
      const entry = acc.get(p.id) || {
        persona: p, ore: 0, costo: 0, taskCount: 0, effortSum: 0
      };
      entry.ore       += ore;
      entry.costo     += ore * tariffa;
      entry.taskCount += 1;
      entry.effortSum += effort;
      acc.set(p.id, entry);
    });
  }
  function walk(id, isRoot) {
    const node = stato.task.find(x => x.id === id);
    if (!node) return;
    if (!isRoot && nodoHaDatiPropri(node)) {
      applica(node);
      return;
    }
    const figli = stato.task.filter(x => x.parentId === id);
    if (!figli.length) {
      if (!isRoot) applica(node);
      return;
    }
    figli.forEach(f => walk(f.id, false));
  }
  walk(epica.id, true);
  return Array.from(acc.values()).sort((a, b) => b.ore - a.ore);
}

function renderEpicaRiepilogo(parent) {
  const cont = document.getElementById('epica-riepilogo');
  if (!cont) return;
  const isEpicaTipo = parent.tipo === 'epica';
  const figli = stato.task.filter(t => t.parentId === parent.id);
  const agg = aggregaEpica(parent);
  const persone = aggregazioniEpica(parent);
  const oreTotali = persone.reduce((s, x) => s + x.ore, 0);

  const personeHtml = persone.length
    ? persone.map(({ persona, ore, costo, taskCount, effortSum }) => {
        const effortMedio = taskCount > 0 ? Math.round(effortSum / taskCount) : 0;
        return `
          <div class="epica-persona-row">
            ${avatar(persona, 'sm')}
            <strong>${escapeHtml(persona.nome)}</strong>
            <small style="color: var(--color-text-muted)">${escapeHtml(persona.ruolo || '')}</small>
            <div class="epica-persona-meta">
              <span>${taskCount} task</span>
              <span><strong>${ore.toFixed(1)}h</strong></span>
              <span>~${effortMedio}% medio</span>
              ${costo > 0 ? `<span><strong>${formatEuro(costo)}</strong></span>` : ''}
            </div>
          </div>`;
      }).join('')
    : '<div class="epica-riepilogo-empty">Nessuna persona assegnata ai task figli.</div>';

  // Lista sub-task con stato
  const subTaskHtml = figli.length ? `
    <div class="epica-subtask-list">
      <strong style="font-size:0.78rem;color:var(--color-text-muted)">Sotto-task (${figli.length}):</strong>
      ${figli.map(st => {
        const stInfo = STATI_TASK[st.stato] || STATI_TASK.todo;
        const stOre = Number(st.stimaOre) || 0;
        const stAssig = (st.assegnazioni || []).map(a => trovaPersona(a.personaId)).filter(Boolean);
        const stAvatars = stAssig.slice(0, 3).map(p => avatar(p, 'xs')).join('');
        return `
          <div class="epica-subtask-row">
            <span class="gantt-stato-dot stato-bg-${st.stato || 'todo'}" title="${escapeHtml(stInfo.label)}"></span>
            <span class="epica-subtask-name">${escapeHtml(st.nome)}</span>
            ${stOre > 0 ? `<span class="label-fte">${stOre}h</span>` : ''}
            ${stAvatars ? `<span class="avatar-group">${stAvatars}</span>` : ''}
          </div>`;
      }).join('')}
    </div>` : '';

  const titoloRiepilogo = isEpicaTipo ? 'Riepilogo epica' : `Riepilogo (${figli.length} sotto-task)`;

  cont.innerHTML = `
    <h4>${titoloRiepilogo}</h4>
    <div class="epica-riepilogo-totale">
      <span><strong>${agg.stimaOre || 0}h</strong> stimate</span>
      <span><strong>${oreTotali.toFixed(1)}h</strong> allocate</span>
      <span><strong>${formatEuro(agg.costoTotale || 0)}</strong> totale</span>
      <span><strong>${agg.completamento || 0}%</strong> completato</span>
    </div>
    <div class="epica-riepilogo-persone">${personeHtml}</div>
    ${subTaskHtml}
  `;
}

// Raccogli persone uniche assegnate a un'epica (stessa logica di
// nodoHaDatiPropri: fermati ai nodi intermedi che hanno assegnazioni proprie)
function raccogliAssegnatariEpica(epica) {
  const visti = new Set();
  const out = [];
  function applica(node) {
    if (!node) return;
    (node.assegnazioni || []).forEach(a => {
      if (visti.has(a.personaId)) return;
      visti.add(a.personaId);
      const p = trovaPersona(a.personaId);
      if (p) out.push(p);
    });
  }
  function walk(id, isRoot) {
    const node = stato.task.find(x => x.id === id);
    if (!node) return;
    if (!isRoot && nodoHaDatiPropri(node)) {
      applica(node);
      return;
    }
    const figli = stato.task.filter(x => x.parentId === id);
    if (!figli.length) {
      if (!isRoot) applica(node);
      return;
    }
    figli.forEach(f => walk(f.id, false));
  }
  walk(epica.id, true);
  return out;
}

// ===== AGGIORNA TUTTE LE VISTE =====

function aggiornaViste() {
  popolaFiltri();
  renderPersone();
  renderTask();
  renderGantt();
  renderWorkload();
  renderEisenhower();
  renderCalendario();
  // Aggiorna lista dipendenze e select padre del form "nuovo task" (le opzioni cambiano)
  if (document.getElementById('lista-dipendenze-nuovo')) {
    renderDipendenze('lista-dipendenze-nuovo', tempDipendenzeNuovo, null);
  }
  if (document.getElementById('task-parent')) {
    popolaSelectPadre('task-parent', null, null);
  }
}

// ===== EXPORT / IMPORT JSON =====

function esportaJSON() {
  const blob = new Blob([JSON.stringify(stato, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `gantt-backup-${dataISOoggi()}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function importaJSON(file) {
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const dati = JSON.parse(e.target.result);
      if (!dati.persone || !dati.task) throw new Error('Formato non valido');
      stato = migraStato(dati);
      salvaStato();
      aggiornaViste();
    } catch {
      alert('Errore: il file non è un backup valido.');
    }
  };
  reader.readAsText(file);
}

// ===== EVENT LISTENERS / INIT =====

function inizializza() {
  caricaStato();

  // Date filter di default per vista
  const defGantt = rangeFiltroDefault();          // mese prec. → mese succ.
  const defWorkload = rangeFiltroDefaultWorkload(); // settimana prec. + corrente + 2 succ.
  if (!filtri.gantt.dataDa && !filtri.gantt.dataA) {
    filtri.gantt.dataDa = defGantt.dataDa;
    filtri.gantt.dataA  = defGantt.dataA;
  }
  if (!filtri.workload.dataDa && !filtri.workload.dataA) {
    filtri.workload.dataDa = defWorkload.dataDa;
    filtri.workload.dataA  = defWorkload.dataA;
  }

  // --- Tabs ---
  document.querySelectorAll('.tab').forEach(t => {
    t.addEventListener('click', () => attivaTab(t.dataset.tab));
  });

  // --- Event delegation per liste persone e task ---
  document.getElementById('lista-persone').addEventListener('click', e => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const id = btn.dataset.id;
    if (btn.dataset.action === 'elimina-persona')  eliminaPersona(id);
    if (btn.dataset.action === 'modifica-persona') apriModaleModificaPersona(id);
  });

  // Modal modifica persona
  document.getElementById('btn-chiudi-modal-persona')
    .addEventListener('click', chiudiModaleModificaPersona);
  const overlayPersona = document.getElementById('modal-persona-overlay');
  let personaMouseDown = false;
  overlayPersona.addEventListener('mousedown', e => {
    personaMouseDown = (e.target === overlayPersona);
  });
  overlayPersona.addEventListener('mouseup', e => {
    if (personaMouseDown && e.target === overlayPersona) chiudiModaleModificaPersona();
    personaMouseDown = false;
  });
  document.getElementById('form-modifica-persona').addEventListener('submit', e => {
    e.preventDefault();
    const nome   = document.getElementById('edit-persona-nome').value.trim();
    const ruolo  = document.getElementById('edit-persona-ruolo').value.trim();
    const fte    = parseFloat(document.getElementById('edit-persona-fte').value);
    const colore = document.getElementById('edit-persona-colore').value;
    const costo  = parseFloat(document.getElementById('edit-persona-costo').value) || 0;
    if (!nome || !ruolo || isNaN(fte)) return;
    salvaModificaPersona(nome, ruolo, fte, colore, costo);
  });
  const listaTask = document.getElementById('lista-task');
  listaTask.addEventListener('click', e => {
    // Click sul chevron dell'epica → toggle collasso
    const chev = e.target.closest('.task-chevron-toggle');
    if (chev) {
      e.stopPropagation();
      toggleCollassoEpica(chev.dataset.toggleTask);
      return;
    }
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const id = btn.dataset.id;
    if (btn.dataset.action === 'modifica-task') apriModaleTask(id);
    if (btn.dataset.action === 'elimina-task')  eliminaTask(id);
  });

  // --- Drag-and-drop: trascina task dentro epiche o sul drop-zone-top ---
  let draggingTaskId = null;
  listaTask.addEventListener('dragstart', e => {
    const li = e.target.closest('li[data-id][draggable="true"]');
    if (!li) return;
    draggingTaskId = li.dataset.id;
    e.dataTransfer.effectAllowed = 'move';
    li.classList.add('dragging-task');
  });
  listaTask.addEventListener('dragend', e => {
    const li = e.target.closest('li');
    if (li) li.classList.remove('dragging-task');
    draggingTaskId = null;
    listaTask.querySelectorAll('.drop-hover').forEach(el => el.classList.remove('drop-hover'));
  });
  listaTask.addEventListener('dragover', e => {
    const target = e.target.closest('li.drop-target, li.drop-zone-top');
    if (!target || !draggingTaskId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    listaTask.querySelectorAll('.drop-hover').forEach(el => el.classList.remove('drop-hover'));
    target.classList.add('drop-hover');
  });
  listaTask.addEventListener('dragleave', e => {
    const target = e.target.closest('li.drop-target, li.drop-zone-top');
    if (target) target.classList.remove('drop-hover');
  });
  listaTask.addEventListener('drop', e => {
    const target = e.target.closest('li.drop-target, li.drop-zone-top');
    if (!target || !draggingTaskId) return;
    e.preventDefault();
    const newParent = target.dataset.droptarget === 'root' ? null : target.dataset.id;
    spostaTaskInEpica(draggingTaskId, newParent);
    target.classList.remove('drop-hover');
  });

  // --- Form Persona ---
  document.getElementById('form-persona').addEventListener('submit', e => {
    e.preventDefault();
    const nome  = document.getElementById('persona-nome').value.trim();
    const ruolo = document.getElementById('persona-ruolo').value.trim();
    const fte   = parseFloat(document.getElementById('persona-fte').value);
    const costo = parseFloat(document.getElementById('persona-costo').value) || 0;
    if (!nome || !ruolo || isNaN(fte)) return;
    aggiungiPersona(nome, ruolo, fte, costo);
    e.target.reset();
    document.getElementById('persona-fte').value = '1.0';
    document.getElementById('persona-costo').value = '0';
  });

  // --- Form Task / Epica (nuovo) ---
  const formTask = document.getElementById('form-task');
  const cardForm = formTask.closest('.card');

  // Toggle modalità task/epica/milestone
  function aggiornaModalitaForm() {
    const tipo = document.querySelector('input[name="task-tipo"]:checked').value;
    cardForm.setAttribute('data-mode', tipo);
    const btn = document.getElementById('btn-submit-task');
    if (tipo === 'epica')          btn.textContent = 'Aggiungi epica';
    else if (tipo === 'milestone') btn.textContent = 'Aggiungi milestone';
    else                            btn.textContent = 'Aggiungi task';
    const hints = {
      task: 'Un task ha date, ore stimate, persone.',
      epica: "L'epica è solo un contenitore: trascina i task sotto di essa nella lista.",
      milestone: 'Una milestone è un evento a data singola, senza durata né effort.'
    };
    document.getElementById('tipo-hint').textContent = hints[tipo];
  }
  document.querySelectorAll('input[name="task-tipo"]').forEach(r =>
    r.addEventListener('change', aggiornaModalitaForm));
  aggiornaModalitaForm();

  formTask.addEventListener('submit', e => {
    e.preventDefault();
    const tipo = document.querySelector('input[name="task-tipo"]:checked').value;
    const nome = document.getElementById('task-nome').value.trim();
    if (!nome) return;

    if (tipo === 'epica') {
      aggiungiEpica(nome);
      e.target.reset();
      document.querySelector('input[name="task-tipo"][value="task"]').checked = true;
      aggiornaModalitaForm();
      return;
    }

    if (tipo === 'milestone') {
      const data = document.getElementById('task-data-milestone').value;
      const statoMs = document.getElementById('task-stato').value;
      const parentMs = document.getElementById('task-parent').value || null;
      if (!data) { alert('Inserisci la data della milestone.'); return; }
      aggiungiMilestone(nome, data, statoMs, parentMs);
      e.target.reset();
      document.querySelector('input[name="task-tipo"][value="task"]').checked = true;
      aggiornaModalitaForm();
      return;
    }

    const inizio    = document.getElementById('task-inizio').value;
    const fine      = document.getElementById('task-fine').value;
    const statoTask = document.getElementById('task-stato').value;
    const stimaOre  = parseFloat(document.getElementById('task-stima').value) || 0;
    const completamento = parseFloat(document.getElementById('task-completamento').value) || 0;
    const importanza = clampEisen(document.getElementById('task-importanza')?.value, 3);
    const urgenza    = clampEisen(document.getElementById('task-urgenza')?.value, 3);
    const parentId  = document.getElementById('task-parent').value || null;

    if (!inizio || !fine) { alert('Inserisci data inizio e fine.'); return; }
    if (fine < inizio) { alert('La data fine deve essere uguale o successiva all\'inizio.'); return; }
    if (!tempAssegnazioniNuovo.filter(a => a.personaId).length) {
      alert('Assegna almeno una persona al task.'); return;
    }
    if (!validaSommaEffort(tempAssegnazioniNuovo)) return;

    aggiungiTask(nome, inizio, fine, statoTask, tempAssegnazioniNuovo, stimaOre, tempDipendenzeNuovo, parentId, completamento, importanza, urgenza);

    e.target.reset();
    document.getElementById('task-stima').value = '0';
    document.getElementById('task-completamento').value = '0';
    tempAssegnazioniNuovo = [];
    tempDipendenzeNuovo = [];
    renderAssegnazioni('lista-assegnazioni-nuovo', tempAssegnazioniNuovo);
    renderDipendenze('lista-dipendenze-nuovo', tempDipendenzeNuovo, null);
    popolaSelectPadre('task-parent', null, null);
  });

  document.getElementById('btn-aggiungi-assegnazione-nuovo').addEventListener('click', () => {
    aggiungiRigaAssegnazione('lista-assegnazioni-nuovo', tempAssegnazioniNuovo);
  });

  // --- Form Modifica Task (modal) ---
  document.getElementById('form-modifica-task').addEventListener('submit', e => {
    e.preventDefault();
    const nome = document.getElementById('edit-nome').value.trim();
    if (!nome) return;

    if (eEpica(taskInModifica)) {
      salvaModificaTask(nome);
      return;
    }
    if (eMilestone(taskInModifica)) {
      const data = document.getElementById('edit-data-milestone').value;
      const statoMs = document.getElementById('edit-stato').value;
      const parentIdMs = document.getElementById('edit-parent').value || null;
      if (!data) { alert('Inserisci la data della milestone.'); return; }
      salvaModificaTask(nome, data, data, statoMs, [], 0, tempDipendenzeEdit, parentIdMs);
      return;
    }

    const inizio    = document.getElementById('edit-inizio').value;
    const fine      = document.getElementById('edit-fine').value;
    const statoTask = document.getElementById('edit-stato').value;
    const stimaOre  = parseFloat(document.getElementById('edit-stima').value) || 0;
    const parentId  = document.getElementById('edit-parent').value || null;

    if (!inizio || !fine) return;
    if (fine < inizio) { alert('La data fine deve essere uguale o successiva all\'inizio.'); return; }
    if (!tempAssegnazioniEdit.filter(a => a.personaId).length) {
      alert('Assegna almeno una persona al task.'); return;
    }
    if (!validaSommaEffort(tempAssegnazioniEdit)) return;

    salvaModificaTask(nome, inizio, fine, statoTask, tempAssegnazioniEdit, stimaOre, tempDipendenzeEdit, parentId);
  });

  document.getElementById('btn-aggiungi-assegnazione-edit').addEventListener('click', () => {
    aggiungiRigaAssegnazione('lista-assegnazioni-edit', tempAssegnazioniEdit);
  });

  document.getElementById('btn-chiudi-modal').addEventListener('click', chiudiModale);
  // Chiude solo se mousedown e mouseup avvengono entrambi sull'overlay
  // (evita di chiudere se l'utente sta finendo un drag iniziato nel modal)
  const overlay = document.getElementById('modal-overlay');
  let overlayMouseDown = false;
  overlay.addEventListener('mousedown', e => {
    overlayMouseDown = (e.target === overlay);
  });
  overlay.addEventListener('mouseup', e => {
    if (overlayMouseDown && e.target === overlay) chiudiModale();
    overlayMouseDown = false;
  });

  // --- Modal report settimana ---
  document.getElementById('btn-report-settimana').addEventListener('click', apriModaleReport);
  document.getElementById('btn-chiudi-modal-report').addEventListener('click', chiudiModaleReport);
  document.getElementById('btn-report-settimana-corr').addEventListener('click', () => {
    const { lun, ven } = settimanaCorrenteLunVen();
    document.getElementById('report-data-da').value = lun;
    document.getElementById('report-data-a').value  = ven;
    renderReportSettimana();
  });
  document.getElementById('report-data-da').addEventListener('change', renderReportSettimana);
  document.getElementById('report-data-a').addEventListener('change', renderReportSettimana);
  document.getElementById('btn-report-csv').addEventListener('click', esportaReportCSV);
  document.getElementById('btn-report-stampa').addEventListener('click', stampaReport);
  const overlayReport = document.getElementById('modal-report-overlay');
  let reportMouseDown = false;
  overlayReport.addEventListener('mousedown', e => { reportMouseDown = (e.target === overlayReport); });
  overlayReport.addEventListener('mouseup', e => {
    if (reportMouseDown && e.target === overlayReport) chiudiModaleReport();
    reportMouseDown = false;
  });

  // --- Modal dettaglio giorno workload ---
  document.getElementById('btn-chiudi-modal-giorno').addEventListener('click', chiudiModaleGiorno);
  const overlayGiorno = document.getElementById('modal-giorno-overlay');
  let giornoMouseDown = false;
  overlayGiorno.addEventListener('mousedown', e => {
    giornoMouseDown = (e.target === overlayGiorno);
  });
  overlayGiorno.addEventListener('mouseup', e => {
    if (giornoMouseDown && e.target === overlayGiorno) chiudiModaleGiorno();
    giornoMouseDown = false;
  });

  // --- Vai a Oggi ---
  document.getElementById('btn-vai-oggi').addEventListener('click', () => {
    weekStripOffset = 0;
    weekStripGiornoSelezionato = null;
    renderWeekStrip();
    scrollAOggi();
  });

  // --- Ordina epiche per Eisenhower (importanza + urgenza) ---
  document.getElementById('btn-ordina-eisen')?.addEventListener('click', ordinaEpichePerEisenhower);

  // --- Week strip nav prev/next (Gantt + Workload) ---
  document.querySelectorAll('.week-nav').forEach(btn => {
    btn.addEventListener('click', () => {
      const direction = btn.dataset.weekNav || btn.dataset.weekNavWl;
      weekStripOffset += (direction === 'next' ? 7 : -7);
      renderWeekStrip();
    });
  });

  // --- Workload: bottone "Oggi" ---
  const btnOggiWl = document.getElementById('btn-vai-oggi-wl');
  if (btnOggiWl) btnOggiWl.addEventListener('click', () => {
    weekStripOffset = 0;
    weekStripGiornoSelezionato = null;
    renderWeekStrip();
    scrollWorkloadAOggi();
  });

  // --- Zoom: listener su tutti gli zoom buttons (toolbar desktop + bottom-bar mobile) ---
  document.querySelectorAll('[data-view]').forEach(b => {
    b.addEventListener('click', () => cambiaViewMode(b.dataset.view));
  });

  // --- Toggle filter bar desktop (click su "Filtri" nella toolbar) ---
  document.querySelectorAll('.btn-filtri-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      const v = btn.dataset.viewToggle;
      const bar = document.querySelector(`.filter-bar[data-view-filter="${v}"]`);
      if (bar) bar.classList.toggle('collapsed');
    });
  });

  // --- Filtri (Gantt + Workload) ---
  document.querySelectorAll('.filter-bar').forEach(bar => {
    const vista = bar.dataset.viewFilter;

    bar.querySelector('.filter-persone')?.addEventListener('change', e => {
      filtri[vista].persone = Array.from(e.target.selectedOptions).map(o => o.value);
      rerenderVista(vista);
    });
    bar.querySelector('.filter-stato')?.addEventListener('change', e => {
      filtri[vista].stati = Array.from(e.target.selectedOptions).map(o => o.value);
      rerenderVista(vista);
    });
    bar.querySelector('.filter-epica')?.addEventListener('change', e => {
      filtri[vista].epiche = Array.from(e.target.selectedOptions).map(o => o.value);
      filtri[vista].epica  = ''; // legacy, svuota
      rerenderVista(vista);
    });
    bar.querySelector('.filter-team')?.addEventListener('change', e => {
      filtri[vista].team = e.target.value;
      rerenderVista(vista);
    });
    bar.querySelector('.filter-progetto')?.addEventListener('change', e => {
      filtri[vista].progetti = Array.from(e.target.selectedOptions).map(o => o.value);
      filtri[vista].progetto = ''; // legacy, svuota
      rerenderVista(vista);
    });
    bar.querySelector('.filter-data-da')?.addEventListener('change', e => {
      filtri[vista].dataDa = e.target.value;
      rerenderVista(vista);
    });
    bar.querySelector('.filter-data-a')?.addEventListener('change', e => {
      filtri[vista].dataA = e.target.value;
      rerenderVista(vista);
    });
    bar.querySelector('.filter-reset')?.addEventListener('click', () => {
      filtri[vista].persone  = [];
      filtri[vista].stati    = [];
      filtri[vista].epica    = '';
      filtri[vista].progetto = '';
      filtri[vista].epiche   = [];
      filtri[vista].progetti = [];
      filtri[vista].team     = '';
      const def = rangeFiltroDefaultPerVista(vista);
      filtri[vista].dataDa  = def.dataDa;
      filtri[vista].dataA   = def.dataA;
      popolaFiltri();
      rerenderVista(vista);
    });
  });

  // --- Export Workload (solo PDF) ---
  document.getElementById('btn-stampa-workload').addEventListener('click', () => stampaVista('workload'));

  // --- Export Gantt: dropdown con PDF / PNG / CSV ---
  document.querySelectorAll('.export-menu').forEach(menu => {
    const vista = menu.dataset.export;
    const trigger = menu.querySelector('.export-trigger');
    const dd = menu.querySelector('.export-dropdown');
    trigger.addEventListener('click', e => {
      e.stopPropagation();
      // Chiudi altri dropdown aperti
      document.querySelectorAll('.export-dropdown').forEach(o => { if (o !== dd) o.classList.add('hidden'); });
      dd.classList.toggle('hidden');
    });
    menu.querySelectorAll('.export-opt').forEach(btn => {
      btn.addEventListener('click', async () => {
        dd.classList.add('hidden');
        const fmt = btn.dataset.exportFormat;
        if (fmt === 'pdf')      await esportaGanttPDF();
        else if (fmt === 'png') await esportaGanttPNG();
        else if (fmt === 'csv') esportaGanttCSV();
      });
    });
  });
  // Click fuori chiude i dropdown
  document.addEventListener('click', () => {
    document.querySelectorAll('.export-dropdown').forEach(o => o.classList.add('hidden'));
  });

  // --- Calendario: form festività ---
  document.getElementById('form-festivita').addEventListener('submit', e => {
    e.preventDefault();
    const data = document.getElementById('festivita-data').value;
    const nome = document.getElementById('festivita-nome').value.trim();
    if (!data || !nome) return;
    aggiungiFestivita(data, nome);
    e.target.reset();
  });
  document.getElementById('btn-aggiungi-italia').addEventListener('click', () => {
    const anno = parseInt(document.getElementById('festivita-anno-italia').value, 10);
    if (!anno) return;
    aggiungiFestivitaItalia(anno);
  });
  document.getElementById('lista-festivita').addEventListener('click', e => {
    const btn = e.target.closest('button[data-action="elimina-festivita"]');
    if (btn) eliminaFestivita(btn.dataset.data);
  });

  // --- Calendario: ferie (event delegation) ---
  const contFerie = document.getElementById('lista-ferie-persone');
  contFerie.addEventListener('submit', e => {
    const form = e.target.closest('form.form-ferie');
    if (!form) return;
    e.preventDefault();
    const personaId = form.dataset.id;
    const inizio = form.querySelector('.ferie-inizio').value;
    const fine = form.querySelector('.ferie-fine').value;
    const nome = form.querySelector('.ferie-nome').value.trim();
    if (!inizio || !fine) return;
    aggiungiFerie(personaId, inizio, fine, nome);
    form.reset();
  });
  contFerie.addEventListener('click', e => {
    const btn = e.target.closest('button[data-action="elimina-ferie"]');
    if (!btn) return;
    eliminaFerie(btn.dataset.id, Number(btn.dataset.i));
  });

  // --- Kebab menu (header) ---
  const kebabBtn = document.getElementById('btn-kebab');
  const kebabDrop = document.getElementById('kebab-dropdown');
  kebabBtn.addEventListener('click', e => {
    e.stopPropagation();
    kebabDrop.classList.toggle('hidden');
  });
  document.addEventListener('click', e => {
    if (!kebabDrop.contains(e.target) && e.target !== kebabBtn && !kebabBtn.contains(e.target)) {
      kebabDrop.classList.add('hidden');
    }
  });

  // --- Bottom bar (mobile) ---
  document.getElementById('bb-btn-new').addEventListener('click', () => {
    attivaTab('task');
    // Setta tipo Task come default e scrolla in cima al form
    document.querySelector('input[name="task-tipo"][value="task"]').checked = true;
    document.getElementById('form-task').dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('task-nome').scrollIntoView({ behavior: 'smooth', block: 'start' });
    setTimeout(() => document.getElementById('task-nome').focus(), 250);
  });
  document.getElementById('bb-btn-filtri').addEventListener('click', apriBottomSheetFiltri);
  document.getElementById('bb-btn-oggi').addEventListener('click', () => {
    const v = vistaAttiva();
    if (v === 'workload') {
      document.getElementById('btn-vai-oggi-wl')?.click();
    } else {
      attivaTab('gantt');
      scrollAOggi();
    }
  });
  document.getElementById('bb-btn-pdf').addEventListener('click', () => {
    const v = vistaAttiva();
    stampaVista(v === 'workload' ? 'workload' : 'gantt');
  });
  // Kebab nav (mobile): navigazione tab dentro l'hamburger
  document.querySelectorAll('.kebab-nav').forEach(btn => {
    btn.addEventListener('click', () => attivaTab(btn.dataset.nav));
  });

  // Eisenhower: switch modalità (epiche / task / tutti)
  document.querySelectorAll('[data-eisen-mode]').forEach(btn => {
    btn.addEventListener('click', () => {
      eisenModo = btn.dataset.eisenMode;
      document.querySelectorAll('[data-eisen-mode]').forEach(b =>
        b.classList.toggle('active', b.dataset.eisenMode === eisenModo));
      renderEisenhower();
    });
  });
  // Eisenhower: filtro progetto direttamente nella toolbar
  document.getElementById('eisen-progetto-select')?.addEventListener('change', e => {
    filtri.eisenhower.progetto = e.target.value;
    // Allinea anche la filter-bar piena (cosi' il chip "Filtri" mostra il badge giusto)
    const fb = document.querySelector('.filter-bar[data-view-filter="eisenhower"] .filter-progetto');
    if (fb) fb.value = e.target.value;
    aggiornaBadgeFiltri();
    renderEisenhower();
  });
  document.getElementById('bs-close').addEventListener('click', chiudiBottomSheet);
  document.querySelector('#bottom-sheet-filtri .bs-backdrop')
    .addEventListener('click', chiudiBottomSheet);

  // --- Import / Export ---
  document.getElementById('btn-esporta').addEventListener('click', esportaJSON);
  document.getElementById('input-importa').addEventListener('change', e => {
    const f = e.target.files[0];
    if (f) { importaJSON(f); e.target.value = ''; }
  });

  // Prima inizializzazione dei form (stato vuoto)
  renderAssegnazioni('lista-assegnazioni-nuovo', tempAssegnazioniNuovo);
  renderDipendenze('lista-dipendenze-nuovo', tempDipendenzeNuovo, null);

  // Default Month view su mobile: timeline più leggibile a colpo d'occhio
  if (window.matchMedia('(max-width: 900px)').matches) {
    cambiaViewMode('Month');
  }

  // Stato iniziale data-active-tab (per CSS bottom-bar)
  const tabIniziale = document.querySelector('.tab.active')?.dataset.tab || 'gantt';
  document.body.setAttribute('data-active-tab', tabIniziale);
  document.querySelectorAll('.kebab-nav').forEach(b =>
    b.classList.toggle('active', b.dataset.nav === tabIniziale));

  // Primo render
  aggiornaViste();
  renderWeekStrip();
  aggiornaBadgeFiltri();
  // Scroll automatico a oggi all'apertura, se la tab attiva è il Gantt
  if (document.querySelector('.tab.active')?.dataset.tab === 'gantt') {
    setTimeout(scrollAOggi, 100);
  }
}

document.addEventListener('DOMContentLoaded', inizializza);

// Ri-renderizza Gantt/Workload quando la finestra cambia dimensione
// (così dayW si ricalcola e il chart riempie sempre l'area disponibile)
let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    const tabAttiva = document.querySelector('.tab.active')?.dataset.tab;
    if (tabAttiva === 'gantt')    renderGantt();
    if (tabAttiva === 'workload') renderWorkload();
  }, 150);
});
