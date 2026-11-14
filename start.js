"use strict";
/* ==========================================================================
   DigiZORA – démarrage avec sauvegarde permanente (PostgreSQL : Neon, Supabase…)
   Principe :
   1. au démarrage : on restaure la base et les images depuis PostgreSQL ;
   2. pendant l'exécution : toute modification (SQLite ou nouveau fichier) est
      envoyée à PostgreSQL en moins de 5 secondes ;
   3. à l'arrêt (mise en veille / redéploiement) : dernière sauvegarde immédiate.
   Sans DATABASE_URL, le site fonctionne comme avant (données locales seulement).
   ========================================================================== */
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const { DatabaseSync } = require("node:sqlite");
const { PgClient, lit, hexLit, fromBytea } = require("./pgmini.js");

for (const fname of ["config.env", ".env"]) {
  try {
    for (const l of fs.readFileSync(path.join(__dirname, fname), "utf8").split(/\r?\n/)) {
      const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch { /* fichier absent : normal */ }
}

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, "data"));
const DIRS = { pub: path.join(DATA_DIR, "uploads"), priv: path.join(DATA_DIR, "private") };
const DB_FILE = path.join(DATA_DIR, "digizora.db");
const URL = process.env.DATABASE_URL;
const log = (...a) => console.log("[sauvegarde]", ...a);

async function main() {
  fs.mkdirSync(DIRS.pub, { recursive: true }); fs.mkdirSync(DIRS.priv, { recursive: true });
  if (!URL) {
    console.log("⚠  DATABASE_URL absent : les données sont stockées localement et seront PERDUES sur l'offre gratuite de Render (voir README).");
    require("./server.js"); return;
  }

  const pg = new PgClient(URL);
  /* Si la base est injoignable on arrête : mieux vaut ne pas démarrer que démarrer vide et écraser les vraies données. */
  await pg.query(`CREATE TABLE IF NOT EXISTS dz_snapshot(id INT PRIMARY KEY, data BYTEA NOT NULL, bytes INT, updated TIMESTAMPTZ DEFAULT now());
                  CREATE TABLE IF NOT EXISTS dz_files(kind TEXT NOT NULL, name TEXT NOT NULL, data BYTEA NOT NULL, created TIMESTAMPTZ DEFAULT now(), PRIMARY KEY(kind, name));`);

  /* ---- 1. restauration ---- */
  let hadRemote = false;
  if (!fs.existsSync(DB_FILE)) {
    const r = await pg.query("SELECT data FROM dz_snapshot WHERE id=1");
    if (r.rows.length) {
      for (const ext of ["-wal", "-shm"]) fs.rmSync(DB_FILE + ext, { force: true });
      fs.writeFileSync(DB_FILE, zlib.gunzipSync(fromBytea(r.rows[0].data)));
      hadRemote = true; log("base restaurée depuis PostgreSQL");
    } else log("aucune sauvegarde existante : première utilisation");
  } else hadRemote = true;

  const known = new Set();   // fichiers déjà présents dans PostgreSQL ("pub/abc.jpg")
  const list = await pg.query("SELECT kind, name FROM dz_files");
  let restored = 0;
  for (const { kind, name } of list.rows) {
    if (!DIRS[kind] || !/^[a-f0-9]{32}\.\w+$/.test(name)) continue;
    known.add(kind + "/" + name);
    const p = path.join(DIRS[kind], name);
    if (fs.existsSync(p)) continue;
    const f = await pg.query(`SELECT data FROM dz_files WHERE kind=${lit(kind)} AND name=${lit(name)}`);
    if (f.rows.length) { fs.writeFileSync(p, fromBytea(f.rows[0].data)); restored++; }
  }
  if (restored) log(restored + " fichier(s) restauré(s)");

  /* ---- 2. démarrage du site ---- */
  require("./server.js");

  /* ---- 3. synchronisation continue ---- */
  let reader = null, lastVer = null, force = !hadRemote, busy = false, lastError = 0;
  const version = () => {
    if (!reader) { try { reader = new DatabaseSync(DB_FILE); } catch { return null; } }
    return reader.prepare("PRAGMA data_version").get().data_version;
  };
  async function snapshot() {
    const tmp = DB_FILE + ".snap"; fs.rmSync(tmp, { force: true });
    reader.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
    const gz = zlib.gzipSync(fs.readFileSync(tmp), { level: 6 }); fs.rmSync(tmp, { force: true });
    await pg.query(`INSERT INTO dz_snapshot(id, data, bytes, updated) VALUES(1, ${hexLit(gz)}, ${gz.length}, now())
                    ON CONFLICT(id) DO UPDATE SET data=EXCLUDED.data, bytes=EXCLUDED.bytes, updated=now()`);
  }
  async function tick(final = false) {
    if (busy) return; busy = true;
    try {
      const v = version();
      if (v !== null && (force || v !== lastVer)) { const before = v; await snapshot(); lastVer = before; force = false; }
      for (const kind of Object.keys(DIRS)) {
        const here = new Set(fs.readdirSync(DIRS[kind]).filter(n => /^[a-f0-9]{32}\.\w+$/.test(n)));
        for (const n of here) {
          const key = kind + "/" + n; if (known.has(key)) continue;
          await pg.query(`INSERT INTO dz_files(kind, name, data) VALUES(${lit(kind)}, ${lit(n)}, ${hexLit(fs.readFileSync(path.join(DIRS[kind], n)))}) ON CONFLICT DO NOTHING`);
          known.add(key);
        }
        for (const key of [...known]) {
          if (!key.startsWith(kind + "/") || here.has(key.slice(kind.length + 1))) continue;
          await pg.query(`DELETE FROM dz_files WHERE kind=${lit(kind)} AND name=${lit(key.slice(kind.length + 1))}`);
          known.delete(key);
        }
      }
    } catch (e) {
      if (Date.now() - lastError > 60000) { console.error("[sauvegarde] erreur (nouvel essai dans 5 s) :", e.message); lastError = Date.now(); }
    } finally { busy = false; }
  }
  const timer = setInterval(tick, 5000); timer.unref();
  setTimeout(tick, 1500).unref();

  let stopping = false;
  const stop = async sig => {
    if (stopping) return; stopping = true; log("arrêt (" + sig + ") : dernière sauvegarde…");
    clearInterval(timer);
    for (let i = 0; i < 20 && busy; i++) await new Promise(r => setTimeout(r, 250));
    force = true; await tick(true); log("sauvegarde terminée"); process.exit(0);
  };
  process.on("SIGTERM", () => stop("SIGTERM")); process.on("SIGINT", () => stop("SIGINT"));
  log("active : les données sont enregistrées en continu dans PostgreSQL");
}

main().catch(e => { console.error("Démarrage impossible :", e.message); process.exit(1); });
