# Backlog — TUTTO COMPLETATO

> Tutte le fasi sono state implementate. Questo file resta come storico.

Ordine consigliato di esecuzione: prima i fix rapidi (sbloccano l'uso quotidiano), poi le modifiche al modello dati (epiche + calendario) — vanno fatte ora che il dataset è ancora piccolo — infine le feature visive che si appoggiano sul nuovo modello.

---

## FASE 1 — Quick wins (mezza giornata)

Lavoro piccolo, ad alto impatto, nessuna modifica al modello dati. Da fare per primi.

### 1.1 Fix step degli input effort
- **Problema**: `<input min="1" step="5">` accetta solo `1, 6, 11, 21, 26…`. Digitando `25` il browser blocca con "valori validi più vicini 21 e 26".
- **Fix**: in [app.js:211](app.js#L211) cambiare `min="1"` → `min="0"`.
- **Test**: digitare 25, 50, 100 senza errori.

### 1.2 Modal: non chiudere su drag rilasciato fuori
- **Problema**: in [app.js:763](app.js#L763) il listener su `modal-overlay` chiude se `e.target === e.currentTarget` su `click`. Un drag che parte dentro il modal e rilascia sull'overlay viene interpretato come click → modal si chiude perdendo le modifiche.
- **Fix**: usare `mousedown` per registrare il punto di partenza; chiudere solo se `mousedown` e `mouseup` avvengono entrambi sull'overlay.
- **File**: [app.js:763](app.js#L763), event listener su `#modal-overlay`.

### 1.3 Conferme su eliminazione
- **Problema**: `eliminaPersona` ed `eliminaTask` agiscono senza conferma. Click accidentale = perdita dati.
- **Fix**: `confirm("Eliminare il task '<nome>'? Verrà rimosso anche dalle dipendenze.")` prima di procedere.
- **File**: [app.js](app.js) funzioni `eliminaPersona` e `eliminaTask`.

### 1.4 Validazione somma effort
- **Problema**: si possono assegnare 3 persone al 100% ognuna; il calcolo del workload diventa errato perché Σeffort dovrebbe essere ~100%.
- **Fix**: in `renderAssegnazioni` mostrare in fondo un riepilogo `"Totale: 240% — dovrebbe essere 100%"` in rosso/verde. Bloccare il submit del form se ≠ 100% (con conferma override).
- **File**: [app.js:194](app.js#L194) `renderAssegnazioni` + listener submit form.

### 1.5 XSS + event delegation
- **Problema**: `innerHTML` con dati utente non escapati in più punti, e `onclick="…('${p.id}')"` inline rompe con caratteri speciali e con CSP.
- **Fix**:
  - Wrappare ogni interpolazione di testo utente con `escapeHtml()` (la funzione esiste già).
  - Sostituire gli `onclick` inline con event delegation: un listener su `#lista-persone` e `#lista-task` che legge `data-action` e `data-id` dai bottoni.
- **File**: [app.js:194](app.js#L194), [app.js:247](app.js#L247), [app.js:154](app.js#L154).

---

## FASE 2 — Refactor modello dati (epiche + calendario)

**Importante**: fare insieme perché entrambi modificano il modello e la migrazione. Eseguire prima di Fase 3.

### 2.1 Epiche e sotto-task
- **Obiettivo**: i task diventano alberi. Ogni task può avere `parentId`. Una epica (= task con figli) ha:
  - Durata = `min(figli.inizio)` → `max(figli.fine)` (calcolata, non editabile direttamente).
  - Stima ore = `Σ figli.stimaOre` (calcolata).
  - Stato = derivato (es. tutti `done` → `done`; almeno uno `in-progress` → `in-progress`).
  - Persone assegnate = union dei figli (le assegnazioni si fanno solo sulle foglie).
- **Modello**:
  ```js
  // task: aggiungere
  parentId: null | string,    // id del task padre, null se top-level
  // (le epiche non hanno assegnazioni proprie né stimaOre editabile)
  ```
- **Migrazione**: tutti i task esistenti diventano top-level con `parentId: null`.
- **UI Task list**: rendering a albero con indentazione + chevron espandi/comprimi.
- **UI Form**: select "Padre (epica)" opzionale; quando selezionato, i campi date/stima/assegnazioni della foglia rimangono, ma il padre li aggrega.
- **UI Gantt**:
  - Le epiche si rendono come barre più alte/contrassegnate (es. cap a punta tipo `▼━━━━▼`).
  - Sotto, le foglie in righe indentate.
  - Click su chevron della colonna laterale espande/comprime.
- **Workload**: continua a contare solo dalle foglie (le epiche non hanno assegnazioni).
- **Validazione**: non permettere cicli (padre = se stesso o suo discendente).

### 2.2 Calendario lavorativo (festività + ferie)
- **Modello**:
  ```js
  stato.festivita: [
    { data: 'YYYY-MM-DD', nome: 'string', ricorrente: bool }
    // ricorrente = ripeti ogni anno (es. 25 dicembre); per Pasqua serve calcolo
  ]
  // su ogni persona:
  persona.ferie: [
    { inizio: 'YYYY-MM-DD', fine: 'YYYY-MM-DD', nome?: 'string' }
  ]
  ```
- **Pasqua**: implementare algoritmo di Gauss per calcolarla automaticamente. Aggiungere preset "Festività italiane" con: 1/1, 6/1, Pasqua, Pasquetta, 25/4, 1/5, 2/6, 15/8, 1/11, 8/12, 25/12, 26/12.
- **UI**: nuova tab "Calendario" o sezione nella tab Persone:
  - Lista festività con add/remove e bottone "Aggiungi festività italiane".
  - Per ogni persona, lista intervalli di ferie con add/remove.
- **Logica**:
  - Helper `eGiornoLavorativo(iso, personaId?)`: false se weekend, festività, o (se personaId) ferie di quella persona.
  - Aggiornare `giorniLavorativi(inizio, fine, personaId?)` per usarlo.
  - `renderWorkload`: heat-cell vuota e barrata (`grigio scuro`) nei giorni festivi/ferie. Tooltip che dice "Ferie" o "Festività: Pasqua".
- **File**: [app.js](app.js) — nuove funzioni + estensione `migraStato`.

---

## FASE 3 — Feature visive (dopo il refactor)

Si appoggiano sul nuovo modello dati e sul calendario.

### 3.1 Etichetta sotto la barra Gantt con persone + %
- **Obiettivo**: oggi la barra mostra `nome task · ABC, DEF` con iniziali. Sostituire con due righe nella barra:
  - Riga 1 (corrente): nome task.
  - Riga 2 piccola: `Mario Rossi 50% · Anna Bianchi 50%` (nomi completi + %).
- Se la barra è troppo corta per la riga 2, nasconderla.
- **File**: [app.js:528-538](app.js#L528) blocco barra del Gantt + CSS in [style.css](style.css) (aumentare `height` della barra a ~36px e usare `flex-direction: column`).

### 3.2 Workload: mostrare TUTTE le task allocate
- **Problema attuale**: nella riga della persona si vede una sola barra per task. Se due task si sovrappongono nello stesso giorno, le barre si accavallano (la seconda finisce sopra la prima).
- **Fix**: layout "swimlanes" automatico — calcolare le sovrapposizioni per ogni persona e impilare le barre in più "corsie" verticali nella stessa riga. La riga della persona cresce in altezza in base al numero di corsie.
- **Algoritmo**: ordina i task per `inizio`, assegna ciascuno alla prima corsia libera (greedy interval graph coloring).
- **File**: [app.js:618-637](app.js#L618) `bodyRows` in `renderWorkload`; CSS `.wl-row` non più altezza fissa.

### 3.3 Workload: click sul giorno → dettaglio
- **Obiettivo**: cliccando una cella heat-strip si apre un popup/modal che mostra:
  - Persona, data, capacità del giorno (es. "8h · FTE 1.0").
  - Lista task assegnati quel giorno con: nome, % effort, ore/giorno, link "Modifica task".
  - Totale ore allocate / capacità con % e barra grafica.
  - Se festività/ferie: indicarlo.
- **Implementazione**:
  - Nuovo modal generico riutilizzabile (`#modal-dettaglio-giorno`).
  - Listener su `.wl-heat` (non solo sulle barre) che chiama `apriDettaglioGiorno(personaId, giorno)`.
  - Il calcolo è già pronto: la struttura `carico[personaId][giorno].tasks` esiste già in `renderWorkload`. Estrarla in una funzione condivisa.
- **File**: [app.js:584-596](app.js#L584) (estrai calcolo); nuovo blocco modal in [index.html](index.html); nuova funzione `apriDettaglioGiorno`.

---

## Ordine di esecuzione consigliato

1. **Fase 1 tutta** in blocco (mezza giornata): sblocca l'uso, riduce bug e dà fiducia per refactor.
2. **2.1 Epiche** prima di 2.2 perché il calendario tocca meno punti.
3. **2.2 Calendario lavorativo** subito dopo, mentre il modello dati è ancora "fresco".
4. **3.2 e 3.3 insieme** (workload completo).
5. **3.1 Etichetta barre** alla fine, è cosmetica.

## Note per il prossimo "me"

- Lo stato è in `localStorage` chiave `gantt-app-stato`. Ogni cambio al modello richiede aggiornamento di `migraStato` ([app.js:55](app.js#L55)) per non rompere i backup esistenti.
- L'export/import JSON deve continuare a funzionare con file vecchi.
- Test manuali da fare a ogni fase: creare task, assegnare persone, drag nel Gantt, verificare workload, esportare/reimportare JSON.
