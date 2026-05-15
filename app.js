// ===== STATO APPLICAZIONE =====
// Dati in memoria, sincronizzati con localStorage ad ogni modifica
let stato = {
  persone: [],   // [{ id, nome, ruolo, fte, colore }]
  task: []       // [{ id, nome, inizio, fine, assegnazioni: [{personaId, effort}], stato }]
};

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
  // Side column più stretta su mobile (vedi media query in style.css)
  const w = window.innerWidth;
  const effectiveSide = w < 560 ? 130 : w < 900 ? 150 : sideWidthApprox;
  const disponibile = cont.clientWidth - effectiveSide - 4;
  if (disponibile <= 0) return baseDayW;
  const fitWidth = Math.floor(disponibile / giorniLen);
  return Math.max(baseDayW, fitWidth);
}

// Set di epiche collassate nel Gantt (transiente, non persistito)
let epicheCollassate = new Set();

// Filtri (transienti, indipendenti per vista)
let filtri = {
  gantt:    { persone: [], stati: [], epica: '', dataDa: '', dataA: '' },
  workload: { persone: [], stati: [], epica: '', dataDa: '', dataA: '' }
};

function rerenderVista(vista) {
  if (vista === 'gantt') renderGantt();
  else if (vista === 'workload') renderWorkload();
}

// Apre il dialog di stampa del browser (l'utente può salvare come PDF)
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

    // Epiche
    const selE = bar.querySelector('.filter-epica');
    if (selE) {
      const epiche = stato.task.filter(t => t.tipo === 'epica');
      selE.innerHTML = `<option value="">— Tutte —</option>` + epiche
        .map(e => `<option value="${e.id}" ${f.epica === e.id ? 'selected' : ''}>${escapeHtml(e.nome)}</option>`)
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
function passaFiltri(t, f) {
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
  if (f.epica) {
    // Il task deve essere figlio diretto/indiretto di quella epica (o esserlo)
    if (t.id !== f.epica && !eAntenato(f.epica, t.id)) return false;
  }
  if (f.dataDa || f.dataA) {
    const ti = t.inizio, tf = t.fine;
    if (!ti || !tf) return f.epica ? true : false;
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

  impostaSyncStato('saving');
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(async () => {
    try {
      const { db, doc, setDoc } = window.__firebase;
      // JSON serializzabile: rimuovo undefined ecc.
      const payload = JSON.parse(JSON.stringify(stato));
      await setDoc(doc(db, FIRESTORE_COLLECTION, FIRESTORE_DOC), payload);
      impostaSyncStato('connected');
    } catch (e) {
      console.error('Firestore save error:', e);
      impostaSyncStato('error');
    }
  }, 400); // debounce 400ms — accumula mini-modifiche prima del save
}

function caricaStato() {
  // 1) Carico fallback locale per non mostrare schermo vuoto in attesa di Firestore
  const raw = localStorage.getItem('gantt-app-stato');
  if (raw) {
    try { stato = migraStato(JSON.parse(raw)); } catch {}
  }

  // 2) Sottoscrivi Firestore (o quando il bridge è pronto)
  if (window.__firebase) {
    avviaSyncFirestore();
  } else {
    impostaSyncStato('loading');
    window.addEventListener('firebase-ready', avviaSyncFirestore, { once: true });
    // Timeout: se Firebase non si carica entro 5s, resta in modalità locale
    setTimeout(() => {
      if (!window.__firebase) impostaSyncStato('offline');
    }, 5000);
  }
}

function avviaSyncFirestore() {
  const { db, doc, onSnapshot } = window.__firebase;
  const ref = doc(db, FIRESTORE_COLLECTION, FIRESTORE_DOC);

  onSnapshot(ref, snap => {
    // I write locali pendenti producono uno snapshot subito: lo ignoriamo
    if (snap.metadata.hasPendingWrites) return;

    if (!snap.exists()) {
      // Doc nuovo: pushiamo lo stato locale corrente (o vuoto)
      salvaStato();
      impostaSyncStato('connected');
      return;
    }

    // Applica i dati remoti senza ri-scattare un save
    _isApplyingRemote = true;
    try {
      const remoto = migraStato(snap.data());
      // Mantieni il riferimento dell'oggetto se possibile
      stato.persone   = remoto.persone   || [];
      stato.task      = remoto.task      || [];
      stato.festivita = remoto.festivita || [];
      // Cache locale aggiornata
      try { localStorage.setItem('gantt-app-stato', JSON.stringify(stato)); } catch {}
      aggiornaViste();
      impostaSyncStato('connected');
    } catch (e) {
      console.error('Errore applicazione snapshot remoto:', e);
      impostaSyncStato('error');
    } finally {
      _isApplyingRemote = false;
    }
  }, err => {
    console.error('Firestore listen error:', err);
    impostaSyncStato('error');
  });
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
    return {
      id: t.id, nome: t.nome, inizio: t.inizio, fine: t.fine,
      assegnazioni: t.assegnazioni || [],
      stato: t.stato || 'todo',
      stimaOre: Number(t.stimaOre) || 0,
      dipendenze: Array.isArray(t.dipendenze) ? t.dipendenze.slice() : [],
      parentId: t.parentId || null,
      tipo: ['epica', 'milestone'].includes(t.tipo) ? t.tipo : 'task',
      ordine: Number.isFinite(t.ordine) ? t.ordine : null
    };
  });

  // Assegna un ordine progressivo ai task che non ce l'hanno (preserva l'ordine attuale)
  dati.task.forEach((t, i) => {
    if (t.ordine == null) t.ordine = i;
  });

  // Marca come epica retroattivamente qualunque task che abbia figli (backup vecchi)
  const idsConFigli = new Set(
    dati.task.filter(t => t.parentId).map(t => t.parentId)
  );
  dati.task.forEach(t => {
    if (idsConFigli.has(t.id)) t.tipo = 'epica';
  });

  // Festività (può essere vuoto)
  if (!Array.isArray(dati.festivita)) dati.festivita = [];

  // Ferie per persona
  dati.persone = dati.persone.map(p => ({
    ...p,
    ferie: Array.isArray(p.ferie) ? p.ferie.slice() : []
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
function effortAllocato(t) {
  const stima = Number(t.stimaOre) || 0;
  const sommaEffort = t.assegnazioni.reduce((s, a) => s + (Number(a.effort) || 0), 0);
  return Math.round(stima * sommaEffort / 100);
}

// Ore/giorno lavorativo per una singola persona su un task.
// Conta solo i giorni lavorativi della *persona* (escludendo le sue ferie),
// così se ha 3 giorni di ferie nel periodo le ore vengono concentrate sugli altri.
function oreGiornaliereAssegnazione(t, assegnazione) {
  const stima = Number(t.stimaOre) || 0;
  if (!stima) return 0;
  const ggLav = giorniLavorativi(t.inizio, t.fine, assegnazione.personaId);
  if (!ggLav) return 0;
  const orePersona = stima * (Number(assegnazione.effort) || 0) / 100;
  return orePersona / ggLav;
}

// ===== EPICHE / SOTTO-TASK =====

function figliDi(taskId) {
  return stato.task.filter(t => t.parentId === taskId);
}

function eEpica(taskId) {
  const t = stato.task.find(x => x.id === taskId);
  return t?.tipo === 'epica';
}

function eMilestone(taskId) {
  const t = stato.task.find(x => x.id === taskId);
  return t?.tipo === 'milestone';
}

// % di completamento di un singolo task in base allo stato
function percCompletamento(stato) {
  if (stato === 'done') return 100;
  if (stato === 'in-progress') return 50;
  return 0; // todo, blocked
}

// Aggrega ricorsivamente i dati di un'epica dai suoi discendenti foglia
function aggregaEpica(t) {
  const foglie = [];
  function raccogli(id) {
    const figli = figliDi(id);
    if (!figli.length) {
      const self = stato.task.find(x => x.id === id);
      if (self) foglie.push(self);
    } else {
      figli.forEach(f => raccogli(f.id));
    }
  }
  raccogli(t.id);

  if (!foglie.length) {
    return { inizio: t.inizio, fine: t.fine, stimaOre: 0, oreAllocate: 0,
             stato: 'todo', completamento: 0 };
  }

  const inizio = foglie.map(f => f.inizio).filter(Boolean).sort()[0];
  const fine = foglie.map(f => f.fine).filter(Boolean).sort().reverse()[0];
  // Solo i task contribuiscono alle ore (le milestone hanno 0)
  const stimaOre = foglie.reduce((s, f) => s + (Number(f.stimaOre) || 0), 0);
  const oreAllocate = foglie.reduce((s, f) => s + effortAllocato(f), 0);

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
      foglie.reduce((s, f) => s + percCompletamento(f.stato) * (Number(f.stimaOre) || 0), 0) / sommaStima
    );
  } else {
    completamento = Math.round(
      foglie.reduce((s, f) => s + percCompletamento(f.stato), 0) / foglie.length
    );
  }

  return { inizio, fine, stimaOre, oreAllocate, stato: statoEpica, completamento };
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
function ordineGerarchicoTask(rispettaCollasso = false, ammessi = null) {
  const out = [];
  function walk(parentId, livello) {
    stato.task
      .filter(t => (t.parentId || null) === parentId)
      .filter(t => !ammessi || ammessi.has(t.id))
      .slice()
      .sort((a, b) => (Number(a.ordine) || 0) - (Number(b.ordine) || 0))
      .forEach(t => {
        const isEpica = eEpica(t.id);
        const collassata = isEpica && epicheCollassate.has(t.id);
        out.push({ task: t, livello, isEpica, collassata });
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

// ===== GESTIONE TAB =====

function attivaTab(nome) {
  document.querySelectorAll('.tab').forEach(t =>
    t.classList.toggle('active', t.dataset.tab === nome));
  document.querySelectorAll('.tab-content').forEach(c =>
    c.classList.toggle('active', c.id === `tab-${nome}`));
  // Quando entro nelle tab grafiche, ri-renderizzo per avere dimensioni corrette
  if (nome === 'gantt') renderGantt();
  if (nome === 'workload') renderWorkload();
  if (nome === 'calendario') renderCalendario();
}

// ===== PERSONE =====

function renderPersone() {
  const lista = document.getElementById('lista-persone');
  lista.innerHTML = stato.persone.length
    ? stato.persone.map(p => `
      <li>
        <div class="info-persona">
          <span class="badge-colore" style="background:${escapeHtml(p.colore)}"></span>
          <strong>${escapeHtml(p.nome)}</strong>
          <span>${escapeHtml(p.ruolo)}</span>
          <span class="label-fte">FTE ${escapeHtml(p.fte)}</span>
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
  document.getElementById('modal-persona-overlay').classList.remove('hidden');
}

function chiudiModaleModificaPersona() {
  personaInModifica = null;
  document.getElementById('modal-persona-overlay').classList.add('hidden');
}

function salvaModificaPersona(nome, ruolo, fte, colore) {
  const p = trovaPersona(personaInModifica);
  if (!p) return;
  p.nome = nome;
  p.ruolo = ruolo;
  p.fte = fte;
  p.colore = colore;
  salvaStato();
  chiudiModaleModificaPersona();
  aggiornaViste();
}

function aggiungiPersona(nome, ruolo, fte) {
  stato.persone.push({
    id: generaId(),
    nome, ruolo, fte,
    colore: colorePerIndice(stato.persone.length)
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
    row.querySelector('.input-effort-ass').addEventListener('input', e => {
      assegnazioni[i].effort = Number(e.target.value) || 0;
      // Aggiorno il totale in tempo reale senza ri-creare gli input
      const tot = assegnazioni.reduce((s, a) => s + (Number(a.effort) || 0), 0);
      const totEl = c.querySelector('.assegnazioni-totale');
      if (totEl) {
        totEl.textContent = `Totale: ${tot}%${tot === 100 ? ' ✓' : ' — dovrebbe essere 100%'}`;
        totEl.classList.toggle('ok', tot === 100);
        totEl.classList.toggle('warn', tot !== 100);
      }
    });
    row.querySelector('.btn-rimuovi-ass').addEventListener('click', () => {
      assegnazioni.splice(i, 1);
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
  assegnazioni.push({ personaId: '', effort: 100 });
  renderAssegnazioni(containerId, assegnazioni);
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
          return `<span class="label-persona-tag" style="background:${escapeHtml(p.colore)}">${escapeHtml(p.nome)} ${a.effort}%</span>`;
        }).join('');

    const indent = livello * 24;
    const figliHTML = figli.length ? renderTaskHTML(figli, livello + 1) : '';
    const liClass = [
      isEpica ? 'task-epica' : (isMilestone ? 'task-milestone' : 'task-leaf'),
      isEpica ? 'drop-target' : ''
    ].filter(Boolean).join(' ');

    let datiMeta;
    if (isEpica) {
      datiMeta = figli.length
        ? `<span>${formatDataBreve(inizioMostrato)} → ${formatDataBreve(fineMostrata)}</span>
           <span class="label-fte" title="Σ figli">⏱ ${stima}h</span>
           <span class="label-fte" title="Giorni · Ore-uomo">${gg}gg · ${allocate}h</span>
           <span class="label-fte epica-badge" title="Completamento">${agg.completamento}%</span>`
        : '<em style="color:#94a3b8">vuota — trascina qui dei task</em>';
    } else if (isMilestone) {
      datiMeta = `<span>📅 ${formatDataBreve(t.inizio)}</span>`;
    } else {
      datiMeta = `<span>${formatDataBreve(inizioMostrato)} → ${formatDataBreve(fineMostrata)}</span>
         <span class="label-fte" title="Stima manuale">⏱ ${stima}h</span>
         <span class="label-fte" title="Giorni · Ore-uomo">${gg}gg · ${allocate}h</span>`;
    }

    const chevron = isEpica
      ? '<span class="task-tree-chevron">▾</span>'
      : (isMilestone
          ? '<span class="task-tree-chevron leaf">🔶</span>'
          : '<span class="task-tree-chevron leaf">⋮⋮</span>');

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

function aggiungiTask(nome, inizio, fine, statoTask, assegnazioni, stimaOre, dipendenze, parentId) {
  stato.task.push({
    id: generaId(),
    nome, inizio, fine,
    stato: statoTask,
    stimaOre: Number(stimaOre) || 0,
    assegnazioni: assegnazioni.filter(a => a.personaId).map(a => ({ ...a })),
    dipendenze: (dipendenze || []).slice(),
    parentId: parentId || null,
    tipo: 'task',
    ordine: prossimoOrdine(parentId || null)
  });
  salvaStato();
  aggiornaViste();
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

  if (isMilestone) {
    document.getElementById('edit-data-milestone').value = t.inizio || '';
    document.getElementById('edit-stato').value  = t.stato || 'todo';
    popolaSelectPadre('edit-parent', t.id, t.parentId);
    tempAssegnazioniEdit = [];
    tempDipendenzeEdit = (t.dipendenze || []).slice();
  } else if (isEpica) {
    tempAssegnazioniEdit = [];
    tempDipendenzeEdit = [];
  } else {
    document.getElementById('edit-inizio').value = t.inizio || '';
    document.getElementById('edit-fine').value   = t.fine || '';
    document.getElementById('edit-stato').value  = t.stato || 'todo';
    document.getElementById('edit-stima').value  = Number(t.stimaOre) || 0;

    tempAssegnazioniEdit = (t.assegnazioni || []).map(a => ({ ...a }));
    renderAssegnazioni('lista-assegnazioni-edit', tempAssegnazioniEdit);

    tempDipendenzeEdit = (t.dipendenze || []).slice();
    renderDipendenze('lista-dipendenze-edit', tempDipendenzeEdit, t.id);

    popolaSelectPadre('edit-parent', t.id, t.parentId);
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

  if (t.tipo === 'epica') {
    // Le epiche modificano solo il nome
    salvaStato();
    chiudiModale();
    aggiornaViste();
    return;
  }

  if (t.tipo === 'milestone') {
    // Milestone: data, stato, parent, dipendenze
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

function renderGantt() {
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
  const taskOrdinati = ordineGerarchicoTask(true, ammessi);

  // --- Righe task (sia colonna laterale che barre nella timeline) ---
  const sideRows = taskOrdinati.map(({ task: t, livello, isEpica, collassata }, i) => {
    const statoVis = isEpica ? aggregaEpica(t).stato : t.stato;
    const infoStato = STATI_TASK[statoVis] || STATI_TASK.todo;
    const indent = livello * 14;
    const altCls = i % 2 === 1 ? ' row-alt' : '';
    const chevron = isEpica
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

  const bodyRows = taskOrdinati.map(({ task: t, isEpica, collassata }, i) => {
    const isMilestone = t.tipo === 'milestone';
    const altCls = i % 2 === 1 ? ' row-alt' : '';
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
               title="${escapeHtml(tooltip)}">
            <span class="gantt-milestone-label">${escapeHtml(t.nome)}</span>
          </div>
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

    const tooltip = `${t.nome}\n${formatDataBreve(inizio)} → ${formatDataBreve(fine)}` +
      (stima ? `\nStima: ${stima}h` : '') +
      (sublabel ? `\n${sublabel}` : '') +
      (isEpica ? `\n[EPICA · ${completamento}% completato]` : '');

    const classeBarra = isEpica ? 'gantt-bar gantt-bar-epica' : 'gantt-bar';
    const draggableAttr = isEpica ? 'data-readonly="1"' : '';
    const handlesHTML = isEpica ? '' : `
      <div class="gantt-bar-handle handle-left" data-side="left"></div>
      <div class="gantt-bar-handle handle-right" data-side="right"></div>`;

    // Sublabel: persone visibili sui task larghi e sulle epiche collassate
    const showSublabel = sublabel && width > 80 && (!isEpica || collassata);
    const etichettaHTML = `
      <span class="gantt-bar-label">
        <span class="gantt-bar-title">${escapeHtml(t.nome)}${isEpica ? ` · ${completamento}%` : ''}</span>
        ${showSublabel ? `<span class="gantt-bar-sublabel">${escapeHtml(sublabel)}</span>` : ''}
      </span>`;

    // Barra di progresso per epiche
    const progressHTML = isEpica && completamento > 0
      ? `<div class="gantt-bar-progress" style="width:${completamento}%"></div>`
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
  const bodyH = taskOrdinati.length * 40;
  const archiSVG = `<svg class="gantt-arcs" width="${totaleW}" height="${bodyH}"></svg>`;

  container.innerHTML = `
    <div class="gantt-side">
      <div class="gantt-side-header">Task (${taskOrdinati.length})</div>
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
  // tranne click sul chevron che fa toggle collasso
  container.querySelectorAll('.gantt-side-row').forEach(el => {
    el.addEventListener('click', ev => {
      const chev = ev.target.closest('.gantt-chevron[data-toggle]');
      if (chev) {
        ev.stopPropagation();
        toggleCollassoEpica(chev.dataset.toggle);
        return;
      }
      apriModaleTask(el.dataset.id);
    });
  });

  // Drag-and-drop riordino delle righe Gantt
  abilitaRiordinoSideRows(container);

  // Drag delle barre (move + resize)
  abilitaDragGantt(dayW, minDate);

  // Disegna frecce dipendenze
  disegnaFrecceDipendenze(dayW, minDate);
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
  document.querySelectorAll('.gantt-controls [data-view]').forEach(b =>
    b.classList.toggle('active', b.dataset.view === vm));
  renderGantt();
  // Il workload usa lo stesso zoom: ri-renderizza anche quello
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
}

function scrollAOggi() {
  const container = document.getElementById('gantt-container');
  if (!container) return;
  const line = container.querySelector('.gantt-today-line');
  const side = container.querySelector('.gantt-side');
  if (!line) return;
  const lineLeft = parseFloat(line.style.left) || 0;
  const sideW = side ? side.offsetWidth : 0;
  // Centra "oggi" nell'area visibile a destra della colonna laterale
  const visibile = container.clientWidth - sideW;
  container.scrollLeft = lineLeft - visibile / 2;
}

// ===== WORKLOAD: calcolo carico (estratto per essere riutilizzato dal modal dettaglio) =====
function calcolaCaricoPersone(ammessi = null) {
  const carico = {};
  stato.persone.forEach(p => { carico[p.id] = {}; });
  stato.task.forEach(t => {
    if (eEpica(t.id) || eMilestone(t.id)) return;
    if (ammessi && !ammessi.has(t.id)) return;
    if (!t.assegnazioni.length || !t.stimaOre) return;
    const giorniTask = rangeDateISO(t.inizio, t.fine);
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

  // ---- Righe persona (filtrate) ----
  const sideRowsArr = [];
  const bodyRowsArr = [];
  const personeMostrate = filtri.workload.persone.length
    ? stato.persone.filter(p => filtri.workload.persone.includes(p.id))
    : stato.persone;

  personeMostrate.forEach(p => {
    const capacitaG = p.fte * ORE_GIORNO_PIENE;

    // Task assegnati a questa persona (solo foglie, escluse milestone), filtrati
    const tasksPersona = stato.task
      .filter(t => !eEpica(t.id) && !eMilestone(t.id))
      .filter(t => !ammessi || ammessi.has(t.id))
      .filter(t => t.assegnazioni.some(a => a.personaId === p.id))
      .sort((a, b) => a.inizio.localeCompare(b.inizio));

    // Algoritmo greedy per assegnare i task a corsie senza sovrapposizioni
    const corsie = []; // ogni corsia è una array di task (in ordine)
    const laneOf = new Map();
    tasksPersona.forEach(t => {
      let assigned = -1;
      for (let i = 0; i < corsie.length; i++) {
        const ultima = corsie[i][corsie[i].length - 1];
        if (ultima.fine < t.inizio) { assigned = i; break; }
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
    const rowH = taskAreaH + HEAT_H;

    // Side row (con altezza dinamica)
    sideRowsArr.push(`
      <div class="wl-side-row" style="border-left: 3px solid ${escapeHtml(p.colore)}; height:${rowH}px">
        <strong>${escapeHtml(p.nome)}</strong>
        <small>${escapeHtml(p.ruolo)} · FTE ${escapeHtml(p.fte)} · ${capacitaG}h/g</small>
        <small style="color:#94a3b8">${tasksPersona.length} task · ${numCorsie} corsia/e</small>
      </div>`);

    // Barre task — ciascuna posizionata su una corsia diversa
    const barreTask = tasksPersona.map(t => {
      const start = new Date(t.inizio);
      const end = new Date(t.fine);
      const off = Math.round((start - minDate) / 86400000);
      const dur = Math.round((end - start) / 86400000) + 1;
      const left = off * dayW;
      const width = Math.max(dur * dayW - 2, 6);
      const lane = laneOf.get(t.id);
      const top = lane * LANE_H + 3;
      const a = t.assegnazioni.find(x => x.personaId === p.id);
      const orePersona = (Number(t.stimaOre) || 0) * (Number(a.effort) || 0) / 100;
      const tooltip = `${t.nome}\n${a.effort}% × ${t.stimaOre}h = ${orePersona.toFixed(1)}h`;
      return `<div class="wl-task-bar stato-${t.stato}"
                   style="left:${left}px; width:${width}px; top:${top}px"
                   data-id="${t.id}"
                   title="${escapeHtml(tooltip)}">${escapeHtml(t.nome)}</div>`;
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

  // Click su una mini-barra → apre il modal modifica task
  container.querySelectorAll('.wl-task-bar').forEach(el => {
    el.addEventListener('click', () => apriModaleTask(el.dataset.id));
  });
  // Click su una cella heat → apre il modal dettaglio giorno
  container.querySelectorAll('.wl-heat[data-persona][data-giorno]').forEach(el => {
    el.addEventListener('click', () => apriModaleGiorno(el.dataset.persona, el.dataset.giorno));
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

// ===== AGGIORNA TUTTE LE VISTE =====

function aggiornaViste() {
  popolaFiltri();
  renderPersone();
  renderTask();
  renderGantt();
  renderWorkload();
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
    if (!nome || !ruolo || isNaN(fte)) return;
    salvaModificaPersona(nome, ruolo, fte, colore);
  });
  const listaTask = document.getElementById('lista-task');
  listaTask.addEventListener('click', e => {
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
    if (!nome || !ruolo || isNaN(fte)) return;
    aggiungiPersona(nome, ruolo, fte);
    e.target.reset();
    document.getElementById('persona-fte').value = '1.0';
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
    const parentId  = document.getElementById('task-parent').value || null;

    if (!inizio || !fine) { alert('Inserisci data inizio e fine.'); return; }
    if (fine < inizio) { alert('La data fine deve essere uguale o successiva all\'inizio.'); return; }
    if (!tempAssegnazioniNuovo.filter(a => a.personaId).length) {
      alert('Assegna almeno una persona al task.'); return;
    }
    if (!validaSommaEffort(tempAssegnazioniNuovo)) return;

    aggiungiTask(nome, inizio, fine, statoTask, tempAssegnazioniNuovo, stimaOre, tempDipendenzeNuovo, parentId);

    e.target.reset();
    document.getElementById('task-stima').value = '0';
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

  // --- Zoom Gantt ---
  document.querySelectorAll('.gantt-controls [data-view]').forEach(b => {
    b.addEventListener('click', () => cambiaViewMode(b.dataset.view));
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
  document.getElementById('btn-vai-oggi').addEventListener('click', scrollAOggi);

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
      filtri[vista].epica = e.target.value;
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
      filtri[vista].persone = [];
      filtri[vista].stati   = [];
      filtri[vista].epica   = '';
      filtri[vista].dataDa  = '';
      filtri[vista].dataA   = '';
      popolaFiltri();
      rerenderVista(vista);
    });
  });

  // --- Export PDF (sfrutta il print dialog del browser, "Salva come PDF") ---
  document.getElementById('btn-stampa-gantt').addEventListener('click', () => stampaVista('gantt'));
  document.getElementById('btn-stampa-workload').addEventListener('click', () => stampaVista('workload'));

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

  // --- Import / Export ---
  document.getElementById('btn-esporta').addEventListener('click', esportaJSON);
  document.getElementById('input-importa').addEventListener('change', e => {
    const f = e.target.files[0];
    if (f) { importaJSON(f); e.target.value = ''; }
  });

  // Prima inizializzazione dei form (stato vuoto)
  renderAssegnazioni('lista-assegnazioni-nuovo', tempAssegnazioniNuovo);
  renderDipendenze('lista-dipendenze-nuovo', tempDipendenzeNuovo, null);

  // Primo render
  aggiornaViste();
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
