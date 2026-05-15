# Gantt App

Web app per gestione progetti con Gantt, workload e calendario lavorativo.

## Funzionalità

- **Persone** con ruolo, FTE e ferie
- **Task / Epiche / Milestone** con date, ore stimate, dipendenze
- **Gantt** interattivo con drag-and-drop per spostare e ridimensionare
- **Workload** timeline con swimlanes e heatmap di carico giornaliero
- **Calendario** con festività italiane (calcolo Pasqua automatico)
- **Filtri** per persone, stato, epica, intervallo date
- **Export PDF** del Gantt e del Workload
- **Sync cloud** in tempo reale via Firebase Firestore
- **Persistenza offline** con localStorage + IndexedDB

## Stack

HTML + CSS + JS vanilla. Nessun build step. Font Inter da Google Fonts. Firebase SDK 12 caricato da CDN.

## Esecuzione locale

Apri `index.html` in un browser moderno. Per sincronia cloud serve il `firebaseConfig` valido in `index.html`.

## Hosting

Pubblicato su GitHub Pages — file statici, nessun server.
