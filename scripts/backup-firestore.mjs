/**
 * Backup del workspace Firestore in JSON, salvato in /backups/.
 * Eseguito dal workflow GitHub Actions "backup-firestore.yml".
 *
 * Env richiesti:
 *   FIREBASE_SERVICE_ACCOUNT  JSON intero della service account Firebase
 *
 * Output:
 *   backups/latest.json                       sempre l'ultimo snapshot
 *   backups/YYYY-MM-DD_HH-MM_workspace.json   archivio storico
 */

import admin from 'firebase-admin';
import fs from 'node:fs/promises';
import path from 'node:path';

const { FIREBASE_SERVICE_ACCOUNT } = process.env;
if (!FIREBASE_SERVICE_ACCOUNT) {
  console.error('❌ Manca FIREBASE_SERVICE_ACCOUNT');
  process.exit(1);
}

let serviceAccount;
try { serviceAccount = JSON.parse(FIREBASE_SERVICE_ACCOUNT); }
catch (e) { console.error('❌ FIREBASE_SERVICE_ACCOUNT non e\' JSON valido'); process.exit(1); }

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

const BACKUP_DIR = path.resolve('..', 'backups');

async function main() {
  console.log('▶ Backup Firestore in corso...');
  await fs.mkdir(BACKUP_DIR, { recursive: true });

  const snapshot = {
    timestamp: new Date().toISOString(),
    workspaces: {},
    config: {}
  };

  // Collection workspaces
  const wsSnap = await db.collection('workspaces').get();
  wsSnap.forEach(doc => { snapshot.workspaces[doc.id] = doc.data(); });

  // Collection config (whitelist)
  const cfgSnap = await db.collection('config').get();
  cfgSnap.forEach(doc => { snapshot.config[doc.id] = doc.data(); });

  const totalTask = Object.values(snapshot.workspaces)
    .reduce((s, w) => s + (Array.isArray(w.task) ? w.task.length : 0), 0);
  const totalPersone = Object.values(snapshot.workspaces)
    .reduce((s, w) => s + (Array.isArray(w.persone) ? w.persone.length : 0), 0);

  console.log(`  workspaces: ${Object.keys(snapshot.workspaces).length}`);
  console.log(`  task totali: ${totalTask}`);
  console.log(`  persone totali: ${totalPersone}`);

  // Sempre "latest.json"
  const latestPath = path.join(BACKUP_DIR, 'latest.json');
  await fs.writeFile(latestPath, JSON.stringify(snapshot, null, 2));
  console.log(`  ✓ ${latestPath}`);

  // Archivio datato
  const dateSafe = snapshot.timestamp.replace(/[:.]/g, '-').slice(0, 16);
  const archivePath = path.join(BACKUP_DIR, `${dateSafe}_workspace.json`);
  await fs.writeFile(archivePath, JSON.stringify(snapshot, null, 2));
  console.log(`  ✓ ${archivePath}`);

  // Retention: tieni solo gli ultimi 12 backup archiviati
  const files = (await fs.readdir(BACKUP_DIR))
    .filter(f => f.endsWith('_workspace.json'))
    .sort();
  if (files.length > 12) {
    const toDelete = files.slice(0, files.length - 12);
    for (const f of toDelete) {
      await fs.unlink(path.join(BACKUP_DIR, f));
      console.log(`  − rimosso vecchio backup: ${f}`);
    }
  }

  console.log('✅ Backup completato');
}

main().catch(err => { console.error('💥 Backup fallito:', err); process.exit(1); });
