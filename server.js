
"use strict";
globalThis.__DC_BUNDLE = true;
globalThis.__DC_EMBED = {};   // les fichiers du site sont lus depuis le disque (index.html, etc.)
"use strict";
/* ==========================================================================
   DigiZORA – Serveur unique (aucune dépendance à installer)
   - Sert index.html, manifest.json, sw.js et les images publiées
   - API JSON sous /api/*  – base de données SQLite (fichier local)
   - Nécessite Node.js 22.13 ou plus récent
   Démarrage : node server.js
   ========================================================================== */
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const zlib = require("node:zlib");
const { promisify } = require("node:util");
const { DatabaseSync } = require("node:sqlite");
const scrypt = promisify(crypto.scrypt);

/* ---------- 1. Configuration (variables d'environnement ou fichier .env) ---------- */
const APP_DIR = __dirname;
for (const fname of ["config.env", ".env"]) {
  try {
    for (const l of fs.readFileSync(path.join(APP_DIR, fname), "utf8").split(/\r?\n/)) {
      const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch { /* fichier absent : normal */ }
}
const PORT = +process.env.PORT || 3000;
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(APP_DIR, "data"));
const PUB_DIR = path.join(DATA_DIR, "uploads");   // images visibles publiquement
const PRIV_DIR = path.join(DATA_DIR, "private");  // preuves de paiement et CV (accès contrôlé)
fs.mkdirSync(PUB_DIR, { recursive: true });
fs.mkdirSync(PRIV_DIR, { recursive: true });
const TRUST_PROXY = process.env.TRUST_PROXY !== "0";
const DAY = 864e5;
const MAX_FILE = 2 * 1024 * 1024;

/* ---------- 2. Référentiels ---------- */
const CITIES = ["Brazzaville","Pointe-Noire","Dolisie","Nkayi","Ouesso","Owando","Impfondo","Sibiti","Madingou","Kinkala"];
const SHOP_CATS = ["Électronique","Vêtements","Alimentation","Informatique","Beauté","Maison","Autres"];
const MODS = {
  market:     { icon:"🛍️", cats:["Téléphones","Ordinateurs","Vêtements","Meubles","Véhicules","Accessoires","Équipements","Alimentation","Autres"], org:false },
  jobs:       { icon:"💼", cats:["Informatique","Finance","Éducation","Transport","Commerce","BTP","Santé","Administration","Autres"], org:true },
  realestate: { icon:"🏠", cats:["Location","Vente","Terrain","Bureau","Local commercial"], org:false },
  pros:       { icon:"🛠️", cats:["Électricien","Plombier","Mécanicien","Informaticien","Développeur","Maçon","Menuisier","Peintre","Enseignant","Photographe","Infographiste","Réparateur","Autre"], org:true },
  training:   { icon:"📚", cats:["Informatique","Bureautique","Comptabilité","Entrepreneuriat","Langues","Marketing","Programmation","Métiers techniques"], org:true },
  transport:  { icon:"🚚", cats:["Transport de personnes","Transport de marchandises","Livraison","Déménagement"], org:true },
  opps:       { icon:"🎯", cats:["Bourse","Concours","Stage","Appel à candidatures","Formation","Accompagnement"], org:true },
  community:  { icon:"🤝", cats:["Événement","Annonce utile","Actualité pratique","Entraide"], org:false },
  rental:     { icon:"🚗", cats:["Citadine","Berline","4x4 / SUV","Minibus / Bus","Pick-up / Camion","Moto","Avec chauffeur"], org:true }
};
const ROLES = ["particulier","commercant","entreprise","demandeur","recruteur","prestataire","formateur","admin"];
const ROLE_MODS = { particulier:["market","realestate","community"], commercant:["market"], entreprise:["jobs","market","opps"], demandeur:["community"], recruteur:["jobs"], prestataire:["pros","transport"], formateur:["training"], admin:Object.keys(MODS) };
const DEFAULT_SETTINGS = {
  plans: [
    { id:"basique", tier:0, name:"Boutique Basique", price:5000, products:10, features:["10 produits maximum","Logo et photo du vendeur","1 photo par produit","Commandes en ligne avec livraison","Lien WhatsApp"] },
    { id:"plus", tier:1, name:"Boutique Plus", price:10000, products:40, features:["40 produits","Image de couverture personnalisée","Présentation soignée des produits","Visibilité améliorée dans la liste","Recherche et tri dans la boutique","Description détaillée des produits"] },
    { id:"premium", tier:2, name:"Boutique Premium", price:15000, products:150, features:["150 produits","Design premium avec effets 3D","Bandeau publicitaire et annonces","Prix promotionnels (ancien prix barré)","Outils marketing : partage WhatsApp / Facebook","Mise en avant dans la catégorie"] },
    { id:"vip", tier:3, name:"Boutique VIP", price:35000, products:9999, features:["Produits illimités","Expérience haut de gamme (thème or et couleur au choix)","Visibilité maximale : en tête et page d'accueil","Badge VIP et boutique certifiée","Publicité incluse et outils marketing complets","Support prioritaire dédié"] }
  ],
  proPlans: [
    { id:"immobilier", label:"Immobilier", icon:"🏠", module:"realestate", price:25000, desc:"Agences, promoteurs, agents et bailleurs : publiez vos biens avec badge professionnel et passage en tête des listes." },
    { id:"transport", label:"Transport & livraison", icon:"🚚", module:"transport", price:20000, desc:"Transporteurs, chauffeurs et livreurs : présentez vos services de transport de personnes et de marchandises." },
    { id:"location", label:"Location de véhicules", icon:"🚗", module:"rental", price:20000, desc:"Loueurs de voitures, bus et engins : publiez votre parc de véhicules avec tarifs et contacts." },
    { id:"services", label:"Autres services professionnels", icon:"🛠️", module:"pros", price:15000, desc:"Artisans, bureaux d'études, prestataires et entreprises de services : soyez référencé comme professionnel vérifié." }
  ],
  durations: [ { id:"m", label:"Mensuel", months:1, discount:0 }, { id:"t", label:"Trimestriel", months:3, discount:5 }, { id:"s", label:"Semestriel", months:6, discount:10 }, { id:"a", label:"Annuel", months:12, discount:20 } ],
  jobValidationFee: 2000, freeAdLimit: 5, sponsoredAdFee: 3000, jobPostFee: 5000, commissionPct: 3,
  adPlans: [ { id:"j1", label:"1 jour", days:1, price:1000 }, { id:"j2", label:"2 jours", days:2, price:2000 }, { id:"j3", label:"3 jours", days:3, price:3000 }, { id:"j7", label:"1 semaine", days:7, price:10000 } ]
};

/* ---------- 3. Base de données ---------- */
const db = new DatabaseSync(path.join(DATA_DIR, "digizora.db"));
db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
db.exec(`
CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, role TEXT NOT NULL, name TEXT NOT NULL, phone TEXT UNIQUE, email TEXT UNIQUE, city TEXT, photo TEXT, pass TEXT NOT NULL, verified INTEGER DEFAULT 0, job_validated INTEGER DEFAULT 0, status TEXT DEFAULT 'active', created INTEGER, last_seen INTEGER);
CREATE TABLE IF NOT EXISTS sessions(sid TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS items(id TEXT PRIMARY KEY, module TEXT NOT NULL, user_id TEXT NOT NULL, title TEXT, cat TEXT, city TEXT, price REAL DEFAULT 0, contact TEXT, descr TEXT, photo TEXT, emoji TEXT, status TEXT DEFAULT 'published', created INTEGER);
CREATE INDEX IF NOT EXISTS ix_items ON items(module, status, created);
CREATE TABLE IF NOT EXISTS shops(id TEXT PRIMARY KEY, user_id TEXT, name TEXT, cat TEXT, city TEXT, wa TEXT, descr TEXT, emoji TEXT, plan TEXT, status TEXT DEFAULT 'active', expires INTEGER, remind7 INTEGER DEFAULT 0, expired_sent INTEGER DEFAULT 0, created INTEGER);
CREATE TABLE IF NOT EXISTS products(id TEXT PRIMARY KEY, shop_id TEXT, title TEXT, price REAL, created INTEGER);
CREATE TABLE IF NOT EXISTS requests(id TEXT PRIMARY KEY, ref TEXT UNIQUE, user_id TEXT, service TEXT, amount REAL, status TEXT DEFAULT 'pending', method TEXT DEFAULT 'manual', meta TEXT, proof_file TEXT, proof_name TEXT, txn TEXT, created INTEGER, decided INTEGER);
CREATE TABLE IF NOT EXISTS notifs(id TEXT PRIMARY KEY, user_id TEXT, text TEXT, seen INTEGER DEFAULT 0, created INTEGER);
CREATE TABLE IF NOT EXISTS apps(id TEXT PRIMARY KEY, user_id TEXT, item_id TEXT, module TEXT, title TEXT, owner_id TEXT, created INTEGER, UNIQUE(user_id, item_id));
CREATE TABLE IF NOT EXISTS reports(id TEXT PRIMARY KEY, user_id TEXT, module TEXT, item_id TEXT, title TEXT, created INTEGER, UNIQUE(user_id, item_id));
CREATE TABLE IF NOT EXISTS msgs(id TEXT PRIMARY KEY, user_id TEXT, type TEXT, subject TEXT, body TEXT, status TEXT DEFAULT 'open', created INTEGER);
CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY AUTOINCREMENT, t INTEGER, who TEXT, action TEXT);
CREATE TABLE IF NOT EXISTS kv(k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS jobprofiles(user_id TEXT PRIMARY KEY, title TEXT, skills TEXT, exp TEXT, cv_file TEXT, cv_name TEXT, updated INTEGER);
`);
const all = (s, ...p) => db.prepare(s).all(...p);
const one = (s, ...p) => db.prepare(s).get(...p);
const run = (s, ...p) => db.prepare(s).run(...p);
const tx = fn => { db.exec("BEGIN IMMEDIATE"); try { const r = fn(); db.exec("COMMIT"); return r; } catch (e) { db.exec("ROLLBACK"); throw e; } };
const uid = () => crypto.randomBytes(8).toString("hex");
const sha = s => crypto.createHash("sha256").update(s).digest("hex");
db.exec(`
CREATE TABLE IF NOT EXISTS ads(id TEXT PRIMARY KEY, user_id TEXT NOT NULL, title TEXT, link TEXT, media TEXT, mtype TEXT, label TEXT, days INTEGER, amount REAL DEFAULT 0, status TEXT DEFAULT 'pending', starts INTEGER, expires INTEGER, clicks INTEGER DEFAULT 0, created INTEGER);
CREATE TABLE IF NOT EXISTS outbox(id TEXT PRIMARY KEY, user_id TEXT, channel TEXT, dest TEXT, subject TEXT, body TEXT, status TEXT, error TEXT, created INTEGER);
`);
const addCol = (t, c, d) => { if (!db.prepare(`PRAGMA table_info(${t})`).all().some(x => x.name === c)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${d}`); };
addCol("products", "photo", "TEXT"); addCol("products", "sold", "INTEGER DEFAULT 0"); addCol("products", "phone", "TEXT"); addCol("products", "city", "TEXT"); addCol("products", "address", "TEXT");
addCol("items", "sold", "INTEGER DEFAULT 0"); addCol("items", "address", "TEXT");
for (const c of ["logo","cover","owner_photo","slogan","announce","color"]) addCol("shops", c, "TEXT");
addCol("products", "delivery", "INTEGER DEFAULT 0"); addCol("products", "old_price", "REAL"); addCol("products", "descr", "TEXT");
db.exec(`
CREATE TABLE IF NOT EXISTS orders(id TEXT PRIMARY KEY, ref TEXT UNIQUE, shop_id TEXT, seller_id TEXT, product_id TEXT, product_title TEXT, unit_price REAL, qty INTEGER, delivery REAL, total REAL, cust_name TEXT, cust_phone TEXT, cust_address TEXT, cust_city TEXT, note TEXT, status TEXT DEFAULT 'new', created INTEGER);
CREATE INDEX IF NOT EXISTS ix_orders_seller ON orders(seller_id, created);
CREATE TABLE IF NOT EXISTS docs(id TEXT PRIMARY KEY, kind TEXT NOT NULL, owner_id TEXT NOT NULL, target_id TEXT, shop_id TEXT, data TEXT NOT NULL, created INTEGER);
CREATE INDEX IF NOT EXISTS ix_docs_owner ON docs(owner_id, created);
CREATE INDEX IF NOT EXISTS ix_docs_target ON docs(target_id);
CREATE TABLE IF NOT EXISTS proaccts(id TEXT PRIMARY KEY, user_id TEXT NOT NULL, sector TEXT NOT NULL, company TEXT, phone TEXT, city TEXT, descr TEXT, status TEXT DEFAULT 'active', expires INTEGER, created INTEGER, UNIQUE(user_id, sector));
`);

function getSettings() { const r = one("SELECT v FROM kv WHERE k='settings'"); return { ...structuredClone(DEFAULT_SETTINGS), ...(r ? JSON.parse(r.v) : {}) }; }
const planOf = s => getSettings().plans.find(p => p.name === s.plan);
const tierOf = s => { const p = planOf(s); return p ? (p.tier ?? 0) : 0; };
const userMods = u => { const base = ROLE_MODS[u.role] || []; const st = getSettings(); const ex = all("SELECT sector FROM proaccts WHERE user_id=? AND status='active' AND expires>?", u.id, Date.now()).map(r => (st.proPlans.find(p => p.id === r.sector) || {}).module).filter(Boolean); return [...new Set([...base, ...ex])]; };
function audit(who, action) { run("INSERT INTO audit(t,who,action) VALUES(?,?,?)", Date.now(), who || "système", String(action).slice(0, 300)); }
function notify(userId, text) { if (userId) run("INSERT INTO notifs(id,user_id,text,created) VALUES(?,?,?,?)", uid(), userId, text, Date.now()); }
function notifyAdmins(text) { for (const a of all("SELECT id FROM users WHERE role='admin' AND status='active'")) notify(a.id, text); }

/* ---------- 4. Utilitaires ---------- */
class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const bad = (m, s = 400) => { throw new HttpError(s, m); };
const str = (v, min, max, label) => { const s = String(v ?? "").trim(); if (s.length < min || s.length > max) bad(`${label} invalide (${min} à ${max} caractères).`); return s; };
const normPhone = v => String(v || "").replace(/[\s.-]/g, "");
const phoneOk = v => /^\+?[0-9]{8,15}$/.test(v);
const emailOk = v => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) && v.length <= 120;
const slugify = s => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 40) || "boutique";
const cookies = req => Object.fromEntries((req.headers.cookie || "").split(";").map(c => c.trim().split(/=(.*)/s).slice(0, 2)).filter(c => c[0]));

async function hashPw(pw) { const salt = crypto.randomBytes(16); const h = await scrypt(pw, salt, 64); return `s1$${salt.toString("hex")}$${h.toString("hex")}`; }
async function checkPw(pw, stored) {
  const [v, s, h] = String(stored).split("$"); if (v !== "s1") return false;
  const calc = await scrypt(pw, Buffer.from(s, "hex"), 64); const exp = Buffer.from(h, "hex");
  return calc.length === exp.length && crypto.timingSafeEqual(calc, exp);
}
const DUMMY = "s1$" + "00".repeat(16) + "$" + "00".repeat(64);
const pwRule = pw => { if (typeof pw !== "string" || pw.length < 8 || pw.length > 100 || !/\d/.test(pw) || !/[A-Za-z]/.test(pw)) bad("Mot de passe : 8 caractères minimum, avec lettres et chiffres."); return pw; };

/* limitation de débit et verrouillage des connexions (en mémoire) */
const hits = new Map(), fails = new Map();
function rate(key, max, windowMs) {
  const n = Date.now(), h = hits.get(key);
  if (!h || h.reset < n) { hits.set(key, { n: 1, reset: n + windowMs }); return; }
  if (++h.n > max) bad("Trop de requêtes. Réessayez dans quelques instants.", 429);
}
const lockCheck = key => { const f = fails.get(key); if (f && f.until > Date.now()) bad("Trop de tentatives. Réessayez dans 15 minutes.", 429); };
const lockFail = key => { const f = fails.get(key) || { n: 0, until: 0 }; f.n++; if (f.n >= 5) { f.until = Date.now() + 15 * 60e3; f.n = 0; } fails.set(key, f); };
setInterval(() => { const n = Date.now(); for (const [k, v] of hits) if (v.reset < n) hits.delete(k); for (const [k, v] of fails) if (v.until < n && !v.n) fails.delete(k); }, 60e3).unref();

/* fichiers : contrôle du contenu réel (octets magiques), pas seulement l'extension */
function sniff(buf) {
  if (buf.length > 12 && buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return "jpg";
  if (buf.length > 12 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))) return "png";
  if (buf.length > 12 && buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WEBP") return "webp";
  if (buf.length > 12 && buf.toString("latin1", 0, 5) === "%PDF-") return "pdf";
  if (buf.length > 12 && buf.toString("latin1", 4, 8) === "ftyp") return "mp4";
  if (buf.length > 12 && buf[0] === 0x1A && buf[1] === 0x45 && buf[2] === 0xDF && buf[3] === 0xA3) return "webm";
  return null;
}
async function saveFile(file, { priv = false, pdf = false, video = false, max = MAX_FILE } = {}) {
  if (!file || typeof file === "string") return null;
  if (file.size === 0) return null;
  if (file.size > max) bad(`Fichier trop lourd (${Math.round(max / 1048576)} Mo maximum).`, 413);
  const buf = Buffer.from(await file.arrayBuffer()); const ext = sniff(buf);
  if (!ext || (ext === "pdf" && !pdf) || ((ext === "mp4" || ext === "webm") && !video)) bad(video ? "Format non accepté (JPG, PNG, WebP, MP4 ou WebM)." : pdf ? "Format non accepté (JPG, PNG, WebP ou PDF)." : "Format non accepté (JPG, PNG ou WebP).", 415);
  const name = crypto.randomBytes(16).toString("hex") + "." + ext;
  fs.writeFileSync(path.join(priv ? PRIV_DIR : PUB_DIR, name), buf);
  return { name, orig: String(file.name || "fichier").replace(/[^\w.\- ]/g, "_").slice(0, 80) };
}
const rmFile = (dir, name) => { if (name && /^[a-f0-9]{32}\.\w+$/.test(name)) fs.rm(path.join(dir, name), () => {}); };
const MIME = { jpg:"image/jpeg", png:"image/png", webp:"image/webp", pdf:"application/pdf", mp4:"video/mp4", webm:"video/webm" };

/* ---------- 5. Lecture des requêtes ---------- */
function readBody(req, max) {
  return new Promise((resolve, reject) => {
    const ch = []; let n = 0, over = false;
    req.on("data", c => { n += c.length; if (n > max) over = true; else ch.push(c); });
    req.on("end", () => over ? reject(new HttpError(413, "Requête trop volumineuse.")) : resolve(Buffer.concat(ch)));
    req.on("error", reject);
  });
}
async function parseBody(req) {
  if (["GET", "HEAD", "DELETE"].includes(req.method)) return { f: {}, files: {} };
  const ct = req.headers["content-type"] || "";
  if (ct.startsWith("multipart/form-data")) {
    const buf = await readBody(req, /^\/api\/ads/.test(req.url) ? 15 * 1024 * 1024 : 6 * 1024 * 1024); const f = {}, files = {};
    try { const fd = await new Response(buf, { headers: { "content-type": ct } }).formData(); for (const [k, v] of fd.entries()) typeof v === "string" ? f[k] = v : files[k] = v; }
    catch { bad("Formulaire invalide."); }
    return { f, files, raw: buf };
  }
  const buf = await readBody(req, 1024 * 1024); if (!buf.length) return { f: {}, files: {}, raw: buf };
  try { const f = JSON.parse(buf.toString("utf8")); return { f: f && typeof f === "object" ? f : {}, files: {}, raw: buf }; } catch { bad("JSON invalide."); }
}

/* ---------- 6. Sessions ---------- */
const isHttps = req => req.socket.encrypted || (TRUST_PROXY && req.headers["x-forwarded-proto"] === "https");
const clientIp = req => (TRUST_PROXY && String(req.headers["x-forwarded-for"] || "").split(",")[0].trim()) || req.socket.remoteAddress || "?";
function setCookie(res, req, name, value, { httpOnly = false, maxAge } = {}) {
  const c = `${name}=${value}; Path=/; SameSite=Lax${httpOnly ? "; HttpOnly" : ""}${isHttps(req) ? "; Secure" : ""}${maxAge !== undefined ? `; Max-Age=${maxAge}` : ""}`;
  const prev = res.getHeader("Set-Cookie") || []; res.setHeader("Set-Cookie", [].concat(prev, c));
}
function startSession(req, res, userId) {
  const token = crypto.randomBytes(32).toString("base64url");
  run("INSERT INTO sessions(sid,user_id,expires) VALUES(?,?,?)", sha(token), userId, Date.now() + 30 * DAY);
  setCookie(res, req, "dc_sid", token, { httpOnly: true, maxAge: 30 * 86400 });
}
function currentUser(req) {
  const t = cookies(req).dc_sid; if (!t) return null;
  const s = one("SELECT user_id, expires FROM sessions WHERE sid=?", sha(t)); if (!s || s.expires < Date.now()) return null;
  const u = one("SELECT * FROM users WHERE id=? AND status='active'", s.user_id); if (!u) return null;
  if (!u.last_seen || Date.now() - u.last_seen > 36e5) run("UPDATE users SET last_seen=? WHERE id=?", Date.now(), u.id);
  return u;
}
const pubUser = u => ({ id: u.id, name: u.name, role: u.role, phone: u.phone, email: u.email, city: u.city, photo: u.photo, verified: !!u.verified, jobValidated: !!u.job_validated });
const needUser = ctx => ctx.user || bad("Connexion requise.", 401);
const needAdmin = ctx => { needUser(ctx); if (ctx.user.role !== "admin") bad("Accès réservé aux administrateurs.", 403); return ctx.user; };


/* ---------- 6b. Messages de bienvenue : e-mail (SMTP) et WhatsApp (API Cloud) ---------- */
const net = require("node:net"), tls = require("node:tls");
const PUBLIC_URL = (process.env.PUBLIC_URL || "http://localhost:" + PORT).replace(/\/$/, "");
const SUPPORT_WA = String(process.env.SUPPORT_WHATSAPP || "242065292598").replace(/\D/g, "");
const SUPPORT_WA_LABEL = process.env.SUPPORT_WHATSAPP_LABEL || "+242 06 529 25 98";
const he = v => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const waNumber = p => { const raw = String(p || ""), d = raw.replace(/\D/g, ""); if (raw.trim().startsWith("+")) return d; if (d.startsWith("00")) return d.slice(2); return d.length >= 11 ? d : "242" + d; };

function smtpSend({ to, subject, html, text }) {
  const host = process.env.SMTP_HOST, port = +process.env.SMTP_PORT || 465, user = process.env.SMTP_USER, pass = process.env.SMTP_PASS;
  if (!host || !user || !pass) return Promise.reject(Object.assign(new Error("SMTP non configuré"), { notConfigured: true }));
  const from = process.env.SMTP_FROM || ("DigiZORA <" + user + ">"), fromAddr = (from.match(/<([^>]+)>/) || [0, from])[1].trim();
  return new Promise((resolve, reject) => {
    let sock, buf = "", fin = false; const pending = [];
    const fail = e => { if (fin) return; fin = true; clearTimeout(timer); try { sock && sock.destroy(); } catch { /* ignoré */ } reject(e); };
    const timer = setTimeout(() => fail(new Error("Délai SMTP dépassé")), 30000);
    const check = () => { while (pending.length) { const lines = buf.split(/\r?\n/), i = lines.findIndex(l => /^\d{3} /.test(l)); if (i < 0) return; buf = lines.slice(i + 1).join("\n"); pending.shift()({ code: +lines[i].slice(0, 3), text: lines.slice(0, i + 1).join(" ") }); } };
    const attach = k => { k.on("data", d => { buf += d.toString("utf8"); check(); }); k.on("error", fail); k.on("close", () => { if (!fin) fail(new Error("Connexion SMTP fermée")); }); };
    const read = () => new Promise(r => { pending.push(r); check(); });
    const cmd = async (line, ok) => { sock.write(line + "\r\n"); const r = await read(); if (!ok.includes(r.code)) throw new Error("SMTP " + r.text.slice(0, 200)); return r; };
    const b64 = x => Buffer.from(x, "utf8").toString("base64"), wrap = x => b64(x).replace(/.{1,76}/g, "$&\r\n");
    (async () => {
      sock = port === 465 ? tls.connect({ host, port, servername: host }) : net.connect({ host, port }); attach(sock);
      const g = await read(); if (g.code !== 220) throw new Error("SMTP " + g.text.slice(0, 200));
      await cmd("EHLO digizora.local", [250]);
      if (port !== 465) { await cmd("STARTTLS", [220]); sock = tls.connect({ socket: sock, servername: host }); buf = ""; attach(sock); await cmd("EHLO digizora.local", [250]); }
      await cmd("AUTH LOGIN", [334]); await cmd(b64(user), [334]); await cmd(b64(pass), [235]);
      await cmd(`MAIL FROM:<${fromAddr}>`, [250]); await cmd(`RCPT TO:<${to}>`, [250, 251]); await cmd("DATA", [354]);
      const bd = "dc" + crypto.randomBytes(8).toString("hex");
      const msg = [`From: ${from}`, `To: <${to}>`, `Subject: =?UTF-8?B?${b64(subject)}?=`, `Date: ${new Date().toUTCString()}`, `Message-ID: <${crypto.randomBytes(12).toString("hex")}@digizora>`, "MIME-Version: 1.0",
        `Content-Type: multipart/alternative; boundary="${bd}"`, "", `--${bd}`, "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64", "", wrap(text),
        `--${bd}`, "Content-Type: text/html; charset=UTF-8", "Content-Transfer-Encoding: base64", "", wrap(html), `--${bd}--`, ""].join("\r\n");
      await cmd(msg + "\r\n.", [250]);
      fin = true; clearTimeout(timer); try { sock.write("QUIT\r\n"); sock.end(); } catch { /* ignoré */ } resolve();
    })().catch(fail);
  });
}
async function waSend(to, text, name) {
  const token = process.env.WA_TOKEN, pid = process.env.WA_PHONE_ID;
  if (!token || !pid) throw Object.assign(new Error("WhatsApp non configuré"), { notConfigured: true });
  const body = process.env.WA_TEMPLATE
    ? { messaging_product: "whatsapp", to, type: "template", template: { name: process.env.WA_TEMPLATE, language: { code: process.env.WA_LANG || "fr" }, components: [{ type: "body", parameters: [{ type: "text", text: String(name || "").split(" ")[0] || "cher membre" }] }] } }
    : { messaging_product: "whatsapp", to, type: "text", text: { body: text } };
  const r = await fetch(`https://graph.facebook.com/v21.0/${pid}/messages`, { method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
  const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error("WhatsApp : " + (j.error?.message || r.status));
}
const ROLE_LABEL = { particulier: "Particulier", commercant: "Commerçant", entreprise: "Entreprise", demandeur: "Demandeur d'emploi", recruteur: "Recruteur", prestataire: "Prestataire de services", formateur: "Formateur" };
const ROLE_TIPS = {
  particulier: ["Publiez gratuitement vos annonces de vente, de location ou d'événements, avec photos et numéro de contact.", "Marquez vos articles « Vendu » dès qu'ils sont partis : votre vitrine reste claire et crédible.", "Louez l'espace publicitaire pour mettre en avant votre activité en image ou en vidéo."],
  commercant: ["Louez votre boutique numérique et présentez vos produits avec photo, prix, localité et téléphone.", "Indiquez le statut « En stock » ou « Vendu » sur chaque produit pour informer vos clients en temps réel.", "Partagez le lien de votre boutique sur WhatsApp et sur les réseaux sociaux."],
  entreprise: ["Publiez vos offres d'emploi et recevez les candidatures directement dans votre espace.", "Ouvrez une boutique et valorisez vos produits et services auprès de tout le pays.", "Diffusez vos campagnes grâce à l'espace publicitaire du site."],
  demandeur: ["Complétez votre profil professionnel et déposez votre CV pour être plus visible.", "Consultez chaque jour les nouvelles offres d'emploi, de stage et de bourses.", "Postulez en un clic et suivez vos candidatures depuis votre espace."],
  recruteur: ["Publiez vos offres d'emploi avec une description claire et un contact fiable.", "Recevez et consultez les profils et CV des candidats dans votre espace.", "Retirez une offre dès que le poste est pourvu."],
  prestataire: ["Présentez vos services et votre zone d'intervention dans l'annuaire des professionnels.", "Ajoutez vos coordonnées et vos réalisations pour inspirer confiance.", "Répondez rapidement aux demandes : la réactivité fait votre réputation."],
  formateur: ["Publiez vos formations, programmes, durées et tarifs.", "Précisez le lieu, les dates et vos coordonnées pour faciliter les inscriptions.", "Faites connaître vos sessions grâce à l'espace publicitaire."]
};
function welcomeContent(u) {
  const first = String(u.name || "").trim().split(/\s+/)[0] || "cher membre", role = ROLE_LABEL[u.role] || "Membre", ad0 = getSettings().adPlans[0], tips = ROLE_TIPS[u.role] || ROLE_TIPS.particulier;
  const url = PUBLIC_URL + "/#/tableau-de-bord";
  const services = ["Boutiques en ligne : louez votre boutique numérique et vendez partout au Congo", "Petites annonces : achetez et vendez téléphones, véhicules, meubles, vêtements…", "Emploi et recrutement : offres, candidatures et profils professionnels", "Immobilier : maisons, appartements, terrains, bureaux et locaux", "Services professionnels : artisans, techniciens et experts près de chez vous", "Formations, bourses, stages et opportunités", "Transport et livraison : chauffeurs, livreurs et déménagement", "Communauté : événements, entraide et actualités pratiques"];
  const steps = ["Complétez votre profil (photo, ville, coordonnées) pour inspirer confiance.", "Publiez votre première annonce ou ouvrez votre boutique, avec une photo de qualité : les publications illustrées sont bien plus consultées.", "Indiquez toujours un numéro de téléphone ou WhatsApp, votre localité et, si possible, votre adresse précise.", "Mettez à jour le statut de vos produits (« En stock » ou « Vendu ») et répondez rapidement aux messages."];
  const safety = ["Ne versez jamais d'argent à distance à une personne que vous ne connaissez pas.", "Vérifiez le produit, le bien ou le document avant tout paiement, et privilégiez une remise en main propre dans un lieu public.", "Signalez tout contenu suspect grâce au bouton ⚑ présent sur chaque publication.", "Ne communiquez jamais votre mot de passe : l'équipe DigiZORA ne vous le demandera jamais."];
  const subject = "Bienvenue sur DigiZORA, " + first + " – votre compte est activé";
  const li = a => a.map(x => `<li style="margin:0 0 8px 0">${he(x)}</li>`).join("");
  const h = t => `<h2 style="font-size:18px;color:#0a2f7a;margin:26px 0 10px 0;border-left:4px solid #ff8a00;padding-left:10px">${he(t)}</h2>`;
  const html = `<!DOCTYPE html><html lang="fr"><body style="margin:0;padding:0;background:#eef2ff;font-family:Segoe UI,Arial,sans-serif;color:#1d2433">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef2ff;padding:24px 10px"><tr><td align="center">
<table role="presentation" width="620" cellpadding="0" cellspacing="0" style="max-width:620px;width:100%;background:#ffffff;border-radius:16px;overflow:hidden">
<tr><td style="background:#0a2f7a;padding:28px 30px;color:#ffffff"><div style="font-size:26px;font-weight:800;letter-spacing:.5px">Digi<span style="color:#ff8a00">ZORA</span></div><div style="font-size:14px;opacity:.9;margin-top:4px">Le numérique sans frontières.</div></td></tr>
<tr><td style="padding:30px;font-size:15px;line-height:1.7">
<h1 style="font-size:24px;color:#0a2f7a;margin:0 0 14px 0">Bienvenue, ${he(first)} ! 🎉</h1>
<p style="margin:0 0 12px 0">Nous avons le plaisir de vous confirmer la création de votre compte <b>${he(role)}</b> sur <b>DigiZORA</b>, la plateforme congolaise qui réunit boutiques, annonces, emploi, immobilier, services et opportunités.</p>
<p style="margin:0 0 12px 0">Toute l'équipe de <b>Nexus Solutions Group</b> vous souhaite la bienvenue et vous remercie de votre confiance. Votre compte est actif : vous pouvez dès maintenant publier, vendre, rechercher et collaborer.</p>
${h("Récapitulatif de votre compte")}
<table role="presentation" width="100%" cellpadding="8" cellspacing="0" style="background:#f6f8ff;border-radius:10px;font-size:14px"><tr><td width="38%"><b>Nom</b></td><td>${he(u.name)}</td></tr><tr><td><b>Type de compte</b></td><td>${he(role)}</td></tr><tr><td><b>Ville</b></td><td>${he(u.city || "—")}</td></tr><tr><td><b>Identifiant de connexion</b></td><td>${he(u.email || u.phone || "—")}</td></tr></table>
${h("Ce que vous pouvez faire sur DigiZORA")}<ul style="padding-left:20px;margin:0">${li(services)}</ul>
${h("Nos conseils pour votre profil « " + role + " »")}<ul style="padding-left:20px;margin:0">${li(tips)}</ul>
${h("Bien démarrer en 4 étapes")}<ol style="padding-left:20px;margin:0">${li(steps)}</ol>
${h("Espace publicitaire")}<p style="margin:0">Faites connaître votre activité à tous les visiteurs : l'espace publicitaire du site se loue en image ou en vidéo, à partir de <b>${he(Number(ad0.price).toLocaleString("fr-FR"))} FCFA pour ${he(ad0.label)}</b>. Rendez-vous dans la rubrique « Publicité ».</p>
${h("Bonnes pratiques et sécurité")}<ul style="padding-left:20px;margin:0">${li(safety)}</ul>
<table role="presentation" cellpadding="0" cellspacing="0" style="margin:28px auto 10px auto"><tr><td style="background:#ff8a00;border-radius:10px"><a href="${he(url)}" style="display:inline-block;padding:14px 28px;color:#051b4d;font-weight:800;text-decoration:none;font-size:15px">Accéder à mon espace →</a></td></tr></table>
${h("Besoin d'aide ?")}<p style="margin:0">Notre assistance répond sur WhatsApp au <b>${he(SUPPORT_WA_LABEL)}</b>. N'hésitez pas à nous écrire : nous sommes là pour vous accompagner.</p>
<p style="margin:26px 0 0 0">Encore bienvenue dans la communauté DigiZORA !<br><b>L'équipe DigiZORA</b><br><span style="color:#5b6478">Nexus Solutions Group – Brazzaville, République du Congo</span></p>
</td></tr>
<tr><td style="background:#051b4d;color:#cfd8ff;padding:16px 30px;font-size:12px;line-height:1.5">Vous recevez ce message car un compte DigiZORA vient d'être créé avec cette adresse e-mail. Si vous n'êtes pas à l'origine de cette inscription, répondez simplement à ce message ou contactez-nous sur WhatsApp.</td></tr>
</table></td></tr></table></body></html>`;
  const bl = a => a.map(x => "  • " + x).join("\n"), nl = a => a.map((x, i) => `  ${i + 1}. ${x}`).join("\n");
  const text = `Bienvenue sur DigiZORA, ${first} !\n\nNous avons le plaisir de vous confirmer la création de votre compte ${role}. Toute l'équipe de Nexus Solutions Group vous souhaite la bienvenue.\n\nVOTRE COMPTE\n  Nom : ${u.name}\n  Type : ${role}\n  Ville : ${u.city || "—"}\n  Identifiant : ${u.email || u.phone || "—"}\n\nCE QUE VOUS POUVEZ FAIRE\n${bl(services)}\n\nNOS CONSEILS POUR VOTRE PROFIL\n${bl(tips)}\n\nBIEN DÉMARRER EN 4 ÉTAPES\n${nl(steps)}\n\nESPACE PUBLICITAIRE\n  À partir de ${Number(ad0.price).toLocaleString("fr-FR")} FCFA pour ${ad0.label}, en image ou en vidéo (rubrique « Publicité »).\n\nBONNES PRATIQUES ET SÉCURITÉ\n${bl(safety)}\n\nAccéder à mon espace : ${url}\nAssistance WhatsApp : ${SUPPORT_WA_LABEL}\n\nL'équipe DigiZORA\nNexus Solutions Group – Brazzaville, République du Congo`;
  const wa = `*Bienvenue sur DigiZORA, ${first} !* 🎉\n\nVotre compte *${role}* est bien créé et actif. ✅\n\n*Ce que vous pouvez faire dès maintenant :*\n🏬 Ouvrir votre boutique en ligne\n🛍️ Publier des annonces (avec photo, prix, téléphone et localité)\n💼 Trouver ou publier un emploi\n🏠 Louer ou vendre un bien immobilier\n📢 Faire votre publicité en image ou en vidéo (dès ${Number(ad0.price).toLocaleString("fr-FR")} FCFA)\n\n*Pour bien démarrer :*\n1️⃣ Complétez votre profil\n2️⃣ Publiez avec une belle photo\n3️⃣ Indiquez votre numéro et votre localité\n4️⃣ Mettez à jour « En stock » / « Vendu »\n\n👉 Accéder à votre espace : ${url}\n\n⚠️ Ne payez jamais à distance un inconnu et ne partagez jamais votre mot de passe.\n\nBesoin d'aide ? Écrivez-nous sur WhatsApp : ${SUPPORT_WA_LABEL}\n\n_L'équipe DigiZORA – Nexus Solutions Group_`;
  return { subject, html, text, wa };
}
const outboxAdd = (userId, channel, dest, subject, body, status, error) => run("INSERT INTO outbox(id,user_id,channel,dest,subject,body,status,error,created) VALUES(?,?,?,?,?,?,?,?,?)", uid(), userId, channel, dest, subject || null, String(body).slice(0, 8000), status, error ? String(error).slice(0, 300) : null, Date.now());
async function sendWelcome(u) {
  const w = welcomeContent(u);
  if (u.email) { try { await smtpSend({ to: u.email, subject: w.subject, html: w.html, text: w.text }); outboxAdd(u.id, "email", u.email, w.subject, w.text, "sent"); } catch (e) { outboxAdd(u.id, "email", u.email, w.subject, w.text, e.notConfigured ? "not_configured" : "failed", e.message); } }
  if (u.phone) { const to = waNumber(u.phone); try { await waSend(to, w.wa, u.name); outboxAdd(u.id, "whatsapp", to, null, w.wa, "sent"); } catch (e) { outboxAdd(u.id, "whatsapp", to, null, w.wa, e.notConfigured ? "not_configured" : "failed", e.message); } }
}

/* ---------- 7. Logique métier ---------- */
const itemOut = r => ({ id: r.id, title: r.title, cat: r.cat, city: r.city, price: r.price || 0, desc: r.descr, contact: r.contact || r.uphone || undefined, pro: r.pro ? true : undefined, address: r.address || undefined, sold: !!r.sold, photo: r.photo, emoji: r.emoji, org: r.org || undefined, userId: r.user_id, t: r.created });
const shopOut = (s, products) => { const t = tierOf(s); return { id: s.id, userId: s.user_id, name: s.name, cat: s.cat, city: s.city, wa: s.wa, desc: s.descr, emoji: s.emoji, plan: s.plan, tier: t, status: s.status, expires: s.expires, logo: s.logo || undefined, cover: t >= 1 ? (s.cover || undefined) : undefined, photo: s.owner_photo || undefined, slogan: s.slogan || undefined, announce: t >= 2 ? (s.announce || undefined) : undefined, color: t >= 3 ? (s.color || undefined) : undefined, products }; };
const shopProducts = id => all("SELECT id,title,price,photo,sold,phone,city,address,delivery,old_price,descr FROM products WHERE shop_id=? ORDER BY created", id);
const planPrice = (plan, dur) => Math.round(plan.price * dur.months * (1 - dur.discount / 100));

function newRef() { const d = new Date(), p = n => String(n).padStart(2, "0"); for (;;) { const r = `DZ-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${crypto.randomBytes(2).toString("hex").toUpperCase()}`; if (!one("SELECT 1 FROM requests WHERE ref=?", r)) return r; } }

/* Active le service payé (appelé dans une transaction, par l'admin ou par la confirmation serveur du prestataire) */
function activate(r, method, txn) {
  const meta = JSON.parse(r.meta || "{}");
  if (meta.type === "shop") {
    const dur = getSettings().durations.find(d => d.id === meta.durId); const sd = meta.shopData; const add = dur.months * 30 * DAY;
    const ex = one("SELECT * FROM shops WHERE user_id=? AND lower(name)=lower(?)", r.user_id, sd.name);
    if (ex) run("UPDATE shops SET expires=?, plan=?, remind7=0, expired_sent=0 WHERE id=?", Math.max(Date.now(), ex.expires || 0) + add, meta.planName, ex.id);
    else {
      let id = slugify(sd.name), n = 2; while (one("SELECT 1 FROM shops WHERE id=?", id)) id = slugify(sd.name) + "-" + n++;
      run("INSERT INTO shops(id,user_id,name,cat,city,wa,descr,emoji,plan,status,expires,created) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)", id, r.user_id, sd.name, sd.cat, sd.city, sd.wa, sd.desc, "🏬", meta.planName, "active", Date.now() + add, Date.now());
    }
  } else if (meta.type === "jobvalidation") run("UPDATE users SET job_validated=1 WHERE id=?", r.user_id);
  else if (meta.type === "pro") {
    const dur = getSettings().durations.find(d => d.id === meta.durId), pd = meta.proData, add = (dur ? dur.months : 1) * 30 * DAY, ex = one("SELECT * FROM proaccts WHERE user_id=? AND sector=?", r.user_id, meta.sector);
    if (ex) run("UPDATE proaccts SET expires=?, company=?, phone=?, city=?, descr=?, status='active' WHERE id=?", Math.max(Date.now(), ex.expires || 0) + add, pd.company, pd.phone, pd.city, pd.desc, ex.id);
    else run("INSERT INTO proaccts(id,user_id,sector,company,phone,city,descr,status,expires,created) VALUES(?,?,?,?,?,?,?,?,?,?)", uid(), r.user_id, meta.sector, pd.company, pd.phone, pd.city, pd.desc, "active", Date.now() + add, Date.now());
  }
  else if (meta.type === "ad") {
    const ad = one("SELECT * FROM ads WHERE id=?", meta.adId);
    if (ad && ad.status !== "removed") { const now = Date.now(), end = now + ad.days * DAY; run("UPDATE ads SET status='active', starts=?, expires=? WHERE id=?", now, end, ad.id); notify(r.user_id, `Votre publicité « ${ad.title} » est en ligne jusqu'au ${new Date(end).toLocaleDateString("fr-FR")}.`); }
  }
  run("UPDATE requests SET status='approved', decided=?, method=?, txn=COALESCE(?,txn) WHERE id=?", Date.now(), method, txn || null, r.id);
  notify(r.user_id, `Paiement ${r.ref} validé : votre service est activé.`);
}

function revenue() {
  const rows = all("SELECT service, amount, decided FROM requests WHERE status='approved'"), n = Date.now();
  const sum = ms => rows.filter(r => n - r.decided < ms).reduce((a, r) => a + r.amount, 0), by = {};
  rows.forEach(r => { const k = r.service.split(" – ")[0]; by[k] = (by[k] || 0) + r.amount; });
  return { today: sum(DAY), month: sum(30 * DAY), year: sum(365 * DAY), byService: by, transactions: rows.length };
}
function stats() {
  const c = (s, ...p) => one(s, ...p).n, n = Date.now();
  return {
    users: c("SELECT COUNT(*) n FROM users"), activeUsers: c("SELECT COUNT(*) n FROM users WHERE status='active' AND last_seen>?", n - 30 * DAY),
    shopsActive: c("SELECT COUNT(*) n FROM shops WHERE status='active' AND expires>?", n), shopsExpired: c("SELECT COUNT(*) n FROM shops WHERE expires<=?", n),
    shopsSuspended: c("SELECT COUNT(*) n FROM shops WHERE status='suspended'"), pending: c("SELECT COUNT(*) n FROM requests WHERE status='pending'"),
    apps: c("SELECT COUNT(*) n FROM apps"), items: c("SELECT COUNT(*) n FROM items WHERE status='published'"), revenue: revenue()
  };
}

function maintenance() { // rappels d'expiration et nettoyage (toutes les heures)
  try {
    const n = Date.now();
    for (const s of all("SELECT * FROM shops WHERE status='active' AND remind7=0 AND expires>? AND expires<?", n, n + 5 * DAY)) { notify(s.user_id, `⏰ Votre abonnement « ${s.plan} » (boutique « ${s.name} ») expire dans moins de 5 jours. Renouvelez-le pour éviter toute interruption.`); run("UPDATE shops SET remind7=1 WHERE id=?", s.id); }
    for (const s of all("SELECT * FROM shops WHERE expired_sent=0 AND expires<=?", n)) { notify(s.user_id, `Votre boutique « ${s.name} » a expiré. Renouvelez-la pour la réactiver.`); run("UPDATE shops SET expired_sent=1 WHERE id=?", s.id); }
    run("DELETE FROM sessions WHERE expires<?", n);
    for (const a of all("SELECT * FROM ads WHERE status='active' AND expires<=?", n)) { run("UPDATE ads SET status='expired' WHERE id=?", a.id); notify(a.user_id, `Votre publicité « ${a.title} » est terminée. Vous pouvez la renouveler depuis votre espace.`); }
  } catch (e) { console.error("maintenance:", e.message); }
}

/* ---------- 8. Routes de l'API ---------- */
const routes = [];
const route = (method, re, fn) => routes.push([method, re, fn]);

route("GET", /^\/api\/health$/, () => ({ app: "digizora", ok: true }));
route("GET", /^\/api\/settings$/, () => getSettings());

/* --- Authentification --- */
route("POST", /^\/api\/auth\/register$/, async ctx => {
  rate("reg|" + ctx.ip, 20, 3600e3); const f = ctx.f;
  const role = String(f.role || ""); if (!ROLES.includes(role) || role === "admin") bad("Type de compte invalide.");
  const name = str(f.name, 3, 80, "Nom"), phone = normPhone(f.phone); if (!phoneOk(phone)) bad("Téléphone invalide.");
  const email = f.email ? String(f.email).trim().toLowerCase() : null; if (email && !emailOk(email)) bad("E-mail invalide.");
  if (!CITIES.includes(f.city)) bad("Ville invalide."); const pw = pwRule(f.password);
  if (one("SELECT 1 FROM users WHERE phone=?", phone)) bad("Ce numéro de téléphone est déjà utilisé.", 409);
  if (email && one("SELECT 1 FROM users WHERE email=?", email)) bad("Cet e-mail est déjà utilisé.", 409);
  const id = uid(); run("INSERT INTO users(id,role,name,phone,email,city,pass,created,last_seen) VALUES(?,?,?,?,?,?,?,?,?)", id, role, name, phone, email, f.city, await hashPw(pw), Date.now(), Date.now());
  audit(name, "Création de compte (" + role + ")"); notify(id, "Bienvenue sur DigiZORA ! Un message de bienvenue vous a été envoyé.");
  sendWelcome(one("SELECT * FROM users WHERE id=?", id)).catch(e => console.error("welcome:", e.message));
  startSession(ctx.req, ctx.res, id); return { user: pubUser(one("SELECT * FROM users WHERE id=?", id)) };
});
route("POST", /^\/api\/auth\/login$/, async ctx => {
  rate("login|" + ctx.ip, 60, 600e3);
  const idf = String(ctx.f.identifier || "").trim(); if (!idf || typeof ctx.f.password !== "string") bad("Identifiants requis.");
  const key = "l|" + ctx.ip + "|" + idf.toLowerCase(); lockCheck(key);
  const u = idf.includes("@") ? one("SELECT * FROM users WHERE email=?", idf.toLowerCase()) : one("SELECT * FROM users WHERE phone=?", normPhone(idf));
  const ok = await checkPw(ctx.f.password, u ? u.pass : DUMMY);
  if (!u || !ok) { lockFail(key); bad("Identifiant ou mot de passe incorrect.", 401); }
  if (u.status !== "active") bad("Ce compte est suspendu. Contactez l'assistance.", 403);
  fails.delete(key); startSession(ctx.req, ctx.res, u.id); run("UPDATE users SET last_seen=? WHERE id=?", Date.now(), u.id);
  return { user: pubUser(u) };
});
route("POST", /^\/api\/auth\/logout$/, ctx => { const t = cookies(ctx.req).dc_sid; if (t) run("DELETE FROM sessions WHERE sid=?", sha(t)); setCookie(ctx.res, ctx.req, "dc_sid", "", { httpOnly: true, maxAge: 0 }); return { ok: true }; });
route("GET", /^\/api\/auth\/me$/, ctx => ({ user: ctx.user ? pubUser(ctx.user) : null }));
route("POST", /^\/api\/auth\/forgot$/, ctx => {
  rate("forgot|" + ctx.ip, 10, 3600e3); const idf = String(ctx.f.identifier || "").trim(); if (!idf) bad("Champ requis.");
  const u = idf.includes("@") ? one("SELECT id FROM users WHERE email=?", idf.toLowerCase()) : one("SELECT id FROM users WHERE phone=?", normPhone(idf));
  run("INSERT INTO msgs(id,user_id,type,subject,body,created) VALUES(?,?,?,?,?,?)", uid(), u ? u.id : null, "reset", "Mot de passe oublié", `Demande pour : ${idf.slice(0, 80)}${u ? "" : " (compte introuvable)"}`, Date.now());
  notifyAdmins("Demande de réinitialisation de mot de passe reçue.");
  return { message: `Demande enregistrée. Contactez l'assistance sur WhatsApp pour recevoir un mot de passe temporaire.` };
});

/* --- Profil --- */
route("PUT", /^\/api\/me$/, ctx => {
  const u = needUser(ctx), f = ctx.f; const name = str(f.name, 3, 80, "Nom");
  const phone = f.phone ? normPhone(f.phone) : null; if (phone && !phoneOk(phone)) bad("Téléphone invalide.");
  const email = f.email ? String(f.email).trim().toLowerCase() : null; if (email && !emailOk(email)) bad("E-mail invalide.");
  if (f.city && !CITIES.includes(f.city)) bad("Ville invalide.");
  if (phone && one("SELECT 1 FROM users WHERE phone=? AND id<>?", phone, u.id)) bad("Ce numéro est déjà utilisé.", 409);
  if (email && one("SELECT 1 FROM users WHERE email=? AND id<>?", email, u.id)) bad("Cet e-mail est déjà utilisé.", 409);
  const resetVerif = (phone !== u.phone || email !== u.email) ? 0 : u.verified;
  run("UPDATE users SET name=?, phone=?, email=?, city=?, verified=? WHERE id=?", name, phone, email, f.city || u.city, resetVerif, u.id);
  return { user: pubUser(one("SELECT * FROM users WHERE id=?", u.id)) };
});
route("POST", /^\/api\/me\/photo$/, async ctx => {
  const u = needUser(ctx); const sv = await saveFile(ctx.files.photo); if (!sv) bad("Aucune image reçue.");
  if (u.photo) rmFile(PUB_DIR, path.basename(u.photo)); const url = "/uploads/" + sv.name;
  run("UPDATE users SET photo=? WHERE id=?", url, u.id); return { url };
});
route("POST", /^\/api\/me\/password$/, async ctx => {
  const u = needUser(ctx); if (!(await checkPw(String(ctx.f.current || ""), u.pass))) bad("Mot de passe actuel incorrect.", 403);
  const pw = pwRule(ctx.f.password); run("UPDATE users SET pass=? WHERE id=?", await hashPw(pw), u.id);
  const t = cookies(ctx.req).dc_sid; run("DELETE FROM sessions WHERE user_id=? AND sid<>?", u.id, sha(t || "")); return { ok: true };
});
route("PUT", /^\/api\/job-profile$/, async ctx => {
  const u = needUser(ctx), f = ctx.f; const title = str(f.title, 2, 100, "Intitulé"), skills = String(f.skills || "").slice(0, 1000), exp = String(f.exp || "").slice(0, 3000);
  const cv = await saveFile(ctx.files.cv, { priv: true, pdf: true }); const old = one("SELECT cv_file FROM jobprofiles WHERE user_id=?", u.id);
  if (cv && old?.cv_file) rmFile(PRIV_DIR, old.cv_file);
  run("INSERT INTO jobprofiles(user_id,title,skills,exp,cv_file,cv_name,updated) VALUES(?,?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET title=excluded.title, skills=excluded.skills, exp=excluded.exp, cv_file=COALESCE(excluded.cv_file, cv_file), cv_name=COALESCE(excluded.cv_name, cv_name), updated=excluded.updated",
    u.id, title, skills, exp, cv?.name || null, cv?.orig || null, Date.now());
  return { ok: true };
});

/* --- Boutiques --- */
route("GET", /^\/api\/shops$/, () => { const arr = all("SELECT * FROM shops WHERE status='active' AND expires>? ORDER BY created DESC LIMIT 300", Date.now()).map(s => shopOut(s, shopProducts(s.id).map(p => ({ id: p.id, n: p.title, p: p.price, photo: p.photo, sold: !!p.sold, phone: p.phone, city: p.city, address: p.address, delivery: p.delivery || 0, old: p.old_price || undefined, desc: p.descr || undefined })))); arr.sort((a, b) => b.tier - a.tier); return { items: arr }; });
function productFields(f, s) {
  const title = str(f.title, 2, 100, "Nom du produit"), price = Number(f.price); if (!(price >= 0 && price < 1e11)) bad("Prix invalide.");
  const phone = f.phone ? normPhone(f.phone) : null; if (phone && !phoneOk(phone)) bad("Numéro de contact invalide.");
  const city = f.city ? String(f.city) : null; if (city && !CITIES.includes(city)) bad("Localité invalide.");
  const address = f.address ? String(f.address).trim().slice(0, 150) : null;
  const delivery = f.delivery === undefined || f.delivery === "" ? 0 : Math.round(Number(f.delivery)); if (!(delivery >= 0 && delivery <= 1e6)) bad("Frais de livraison invalides.");
  let oldPrice = f.old_price ? Number(f.old_price) : null;
  if (oldPrice) { if (tierOf(s) < 2) bad("Les prix promotionnels sont réservés aux formules Premium et VIP."); if (!(oldPrice > price)) bad("L'ancien prix doit être supérieur au prix actuel."); } else oldPrice = null;
  const descr = f.desc ? String(f.desc).trim().slice(0, 600) : null;
  return { title, price, phone, city, address, delivery, oldPrice, descr };
}
route("POST", /^\/api\/shops\/([\w-]+)\/products$/, async ctx => {
  const u = needUser(ctx), s = one("SELECT * FROM shops WHERE id=?", ctx.m[1]); if (!s || (s.user_id !== u.id && u.role !== "admin")) bad("Boutique introuvable.", 404);
  const x = productFields(ctx.f, s), plan = planOf(s);
  if (plan && one("SELECT COUNT(*) n FROM products WHERE shop_id=?", s.id).n >= plan.products) bad(`Limite de ${plan.products} produits atteinte pour cette formule. Passez à une formule supérieure.`, 403);
  const photo = await saveFile(ctx.files.photo);
  const id = uid(); run("INSERT INTO products(id,shop_id,title,price,created,photo,phone,city,address,delivery,old_price,descr) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)", id, s.id, x.title, x.price, Date.now(), photo ? "/uploads/" + photo.name : null, x.phone, x.city, x.address, x.delivery, x.oldPrice, x.descr); return { id };
});
route("PUT", /^\/api\/shops\/([\w-]+)\/products\/(\w+)$/, async ctx => {
  const u = needUser(ctx), s = one("SELECT * FROM shops WHERE id=?", ctx.m[1]); if (!s || (s.user_id !== u.id && u.role !== "admin")) bad("Boutique introuvable.", 404);
  const p = one("SELECT * FROM products WHERE id=? AND shop_id=?", ctx.m[2], s.id); if (!p) bad("Produit introuvable.", 404);
  const x = productFields(ctx.f, s), photo = await saveFile(ctx.files.photo); let url = p.photo;
  if (photo) { if (p.photo) rmFile(PUB_DIR, path.basename(p.photo)); url = "/uploads/" + photo.name; }
  else if (ctx.f.remove_photo === "1" && p.photo) { rmFile(PUB_DIR, path.basename(p.photo)); url = null; }
  run("UPDATE products SET title=?, price=?, photo=?, phone=?, city=?, address=?, delivery=?, old_price=?, descr=? WHERE id=?", x.title, x.price, url, x.phone, x.city, x.address, x.delivery, x.oldPrice, x.descr, p.id);
  audit(u.name, `Produit modifié : ${x.title}`); return { ok: true };
});
route("PUT", /^\/api\/shops\/([\w-]+)$/, async ctx => {
  const u = needUser(ctx), s = one("SELECT * FROM shops WHERE id=?", ctx.m[1]); if (!s || (s.user_id !== u.id && u.role !== "admin")) bad("Boutique introuvable.", 404);
  const f = ctx.f, t = tierOf(s), desc = str(f.desc, 10, 500, "Description"), wa = String(f.wa || s.wa || "").replace(/\D/g, "");
  if (wa.length < 8 || wa.length > 15) bad("Numéro WhatsApp invalide.");
  const city = f.city ? (CITIES.includes(f.city) ? f.city : bad("Ville invalide.")) : s.city;
  const slogan = f.slogan ? String(f.slogan).trim().slice(0, 80) : null;
  let announce = f.announce ? String(f.announce).trim().slice(0, 160) : null; if (announce && t < 2) bad("Le bandeau d'annonce est réservé aux formules Premium et VIP.");
  let color = f.color ? String(f.color).trim() : null; if (color) { if (!/^#[0-9a-fA-F]{6}$/.test(color)) bad("Couleur invalide."); if (t < 3) bad("La couleur personnalisée est réservée à la formule VIP."); }
  const logo = await saveFile(ctx.files.logo), photo = await saveFile(ctx.files.photo), cover = await saveFile(ctx.files.cover);
  if (cover && t < 1) { rmFile(PUB_DIR, cover.name); bad("L'image de couverture est disponible à partir de la formule Plus (10 000 FCFA)."); }
  const upd = (cur, nw, flag) => { if (nw) { if (cur) rmFile(PUB_DIR, path.basename(cur)); return "/uploads/" + nw.name; } if (flag === "1" && cur) { rmFile(PUB_DIR, path.basename(cur)); return null; } return cur; };
  run("UPDATE shops SET descr=?, wa=?, city=?, slogan=?, announce=?, color=?, logo=?, owner_photo=?, cover=? WHERE id=?", desc, wa, city, slogan, announce, color, upd(s.logo, logo, f.rm_logo), upd(s.owner_photo, photo, f.rm_photo), upd(s.cover, cover, f.rm_cover), s.id);
  audit(u.name, `Boutique personnalisée : ${s.name}`); return { ok: true };
});
route("DELETE", /^\/api\/shops\/([\w-]+)\/products\/(\w+)$/, ctx => {
  const u = needUser(ctx), s = one("SELECT * FROM shops WHERE id=?", ctx.m[1]); if (!s || (s.user_id !== u.id && u.role !== "admin")) bad("Boutique introuvable.", 404);
  const p = one("SELECT photo FROM products WHERE id=? AND shop_id=?", ctx.m[2], s.id); if (p?.photo) rmFile(PUB_DIR, path.basename(p.photo));
  run("DELETE FROM products WHERE id=? AND shop_id=?", ctx.m[2], s.id); return { ok: true };
});
route("POST", /^\/api\/shops\/([\w-]+)\/products\/(\w+)\/sold$/, ctx => {
  const u = needUser(ctx), s = one("SELECT * FROM shops WHERE id=?", ctx.m[1]); if (!s || (s.user_id !== u.id && u.role !== "admin")) bad("Boutique introuvable.", 404);
  if (!one("SELECT 1 FROM products WHERE id=? AND shop_id=?", ctx.m[2], s.id)) bad("Produit introuvable.", 404);
  run("UPDATE products SET sold=? WHERE id=?", ctx.f.sold === true || ctx.f.sold === "true" || ctx.f.sold === 1 ? 1 : 0, ctx.m[2]); return { ok: true };
});

/* --- Commandes (ouvertes à tout visiteur) --- */
const ORDER_ST = ["new", "confirmed", "shipped", "delivered", "cancelled"];
function newOrderRef() { for (;;) { const r = "CMD-" + crypto.randomBytes(3).toString("hex").toUpperCase(); if (!one("SELECT 1 FROM orders WHERE ref=?", r)) return r; } }
route("POST", /^\/api\/orders$/, ctx => {
  rate("ord|" + ctx.ip, 20, 3600e3); const f = ctx.f;
  const name = str(f.name, 3, 80, "Nom"), phone = normPhone(f.phone); if (!phoneOk(phone)) bad("Téléphone invalide.");
  const address = str(f.address, 5, 200, "Adresse de livraison"), city = CITIES.includes(f.city) ? f.city : null, note = f.note ? String(f.note).trim().slice(0, 300) : null;
  const qty = Math.round(Number(f.qty || 1)); if (!(qty >= 1 && qty <= 50)) bad("Quantité invalide.");
  const p = one("SELECT p.*, s.user_id suid, s.name sname, s.wa swa, s.status sstatus, s.expires sexp FROM products p JOIN shops s ON s.id=p.shop_id WHERE p.id=?", String(f.productId || ""));
  if (!p || p.sstatus !== "active" || p.sexp < Date.now()) bad("Ce produit n'est plus disponible.", 404);
  if (p.sold) bad("Ce produit est vendu.", 409);
  const delivery = p.delivery || 0, total = p.price * qty + delivery, id = uid(), ref = newOrderRef();
  run("INSERT INTO orders(id,ref,shop_id,seller_id,product_id,product_title,unit_price,qty,delivery,total,cust_name,cust_phone,cust_address,cust_city,note,created) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", id, ref, p.shop_id, p.suid, p.id, p.title, p.price, qty, delivery, total, name, phone, address, city, note, Date.now());
  notify(p.suid, `🛒 Nouvelle commande ${ref} : ${qty} × ${p.title} — ${name}, ${phone}. Total ${total} FCFA (livraison ${delivery} FCFA).`);
  return { ref, total, delivery, product: p.title, qty, shop: p.sname, wa: p.swa };
});
route("POST", /^\/api\/orders\/(\w+)\/status$/, ctx => {
  const u = needUser(ctx), o = one("SELECT * FROM orders WHERE id=?", ctx.m[1]); if (!o || (o.seller_id !== u.id && u.role !== "admin")) bad("Commande introuvable.", 404);
  if (!ORDER_ST.includes(ctx.f.status)) bad("Statut invalide."); run("UPDATE orders SET status=? WHERE id=?", ctx.f.status, o.id);
  if (ctx.f.status === "delivered" || ctx.f.status === "cancelled") audit(u.name, `Commande ${o.ref} : ${ctx.f.status}`); return { ok: true };
});

/* --- Comptes professionnels payants (immobilier, transport, location, services) --- */
route("GET", /^\/api\/pro-plans$/, () => ({ items: getSettings().proPlans }));

/* --- Demandes de paiement (boutiques, validations) --- */
route("POST", /^\/api\/payment-requests$/, ctx => {
  const u = needUser(ctx), f = ctx.f, st = getSettings(); let service, amount, meta;
  if (f.shopData && f.planName) {
    if (!["commercant", "entreprise", "particulier", "admin"].includes(u.role)) bad("Un compte Commerçant ou Entreprise est requis.", 403);
    const plan = st.plans.find(p => p.name === f.planName), dur = st.durations.find(d => d.id === f.durId); if (!plan || !dur) bad("Formule ou durée invalide.");
    const sd = f.shopData; const shopData = { name: str(sd.name, 3, 60, "Nom de la boutique"), cat: SHOP_CATS.includes(sd.cat) ? sd.cat : bad("Catégorie invalide."), city: CITIES.includes(sd.city) ? sd.city : bad("Ville invalide."), wa: String(sd.wa || "").replace(/\D/g, ""), desc: str(sd.desc, 10, 500, "Description") };
    if (shopData.wa.length < 8 || shopData.wa.length > 15) bad("Numéro WhatsApp invalide.");
    amount = planPrice(plan, dur); service = `Boutique – ${plan.name} (${dur.label})`; meta = { type: "shop", planName: plan.name, durId: dur.id, shopData };
  } else if (f.proData) {
    const pp = st.proPlans.find(p => p.id === f.proData.sector) || bad("Secteur invalide."), dur = st.durations.find(d => d.id === f.durId) || bad("Durée invalide."), pd = f.proData;
    const ph = normPhone(pd.phone); if (!phoneOk(ph)) bad("Téléphone invalide.");
    const proData = { sector: pp.id, company: str(pd.company, 3, 80, "Nom de l'entreprise"), phone: ph, city: CITIES.includes(pd.city) ? pd.city : bad("Ville invalide."), desc: str(pd.desc, 10, 500, "Présentation de l'activité") };
    if (one("SELECT 1 FROM requests WHERE user_id=? AND status='pending' AND service LIKE ?", u.id, `Compte professionnel – ${pp.label}%`)) bad("Une demande est déjà en attente pour ce secteur.", 409);
    amount = Math.round(pp.price * dur.months * (1 - dur.discount / 100)); service = `Compte professionnel – ${pp.label} (${dur.label})`; meta = { type: "pro", sector: pp.id, durId: dur.id, proData };
  } else if (f.service === "Validation compte demandeur d'emploi") {
    if (u.role !== "demandeur") bad("Réservé aux comptes Demandeur d'emploi.", 403);
    if (u.job_validated) bad("Votre compte est déjà validé.", 409);
    if (one("SELECT 1 FROM requests WHERE user_id=? AND status='pending' AND service=?", u.id, f.service)) bad("Une demande est déjà en attente.", 409);
    amount = st.jobValidationFee; service = f.service; meta = { type: "jobvalidation" };
  } else bad("Service inconnu.");
  const id = uid(), ref = newRef(); run("INSERT INTO requests(id,ref,user_id,service,amount,meta,created) VALUES(?,?,?,?,?,?,?)", id, ref, u.id, service, amount, JSON.stringify(meta), Date.now());
  audit(u.name, `Demande créée : ${service} (${ref})`); notifyAdmins(`Nouvelle demande de paiement ${ref} : ${service}.`); return { id, ref, amount };
});
route("POST", /^\/api\/uploads$/, async ctx => {
  const u = needUser(ctx); const r = one("SELECT * FROM requests WHERE ref=?", String(ctx.f.reference || "")); if (!r || (r.user_id !== u.id && u.role !== "admin")) bad("Demande introuvable.", 404);
  if (r.status !== "pending") bad("Cette demande est déjà traitée.", 409);
  const sv = await saveFile(ctx.files.proof, { priv: true, pdf: true }); if (!sv) bad("Aucun fichier reçu.");
  rmFile(PRIV_DIR, r.proof_file); run("UPDATE requests SET proof_file=?, proof_name=? WHERE id=?", sv.name, sv.orig, r.id);
  notifyAdmins(`Preuve de paiement reçue pour ${r.ref}. Elle ne vaut pas confirmation : vérifiez le paiement.`); return { ok: true };
});
route("GET", /^\/api\/files\/([a-f0-9]{32}\.(?:jpg|png|webp|pdf))$/, ctx => {
  const u = needUser(ctx), name = ctx.m[1]; let allowed = u.role === "admin";
  const r = one("SELECT user_id FROM requests WHERE proof_file=?", name); if (r && r.user_id === u.id) allowed = true;
  const j = one("SELECT user_id FROM jobprofiles WHERE cv_file=?", name);
  if (j && (j.user_id === u.id || one("SELECT 1 FROM apps WHERE user_id=? AND owner_id=?", j.user_id, u.id))) allowed = true;
  if (!allowed) bad("Accès refusé.", 403); return { file: path.join(PRIV_DIR, name), priv: true };
});

/* --- Paiement électronique (Mobile Money) --- */
route("POST", /^\/api\/payments\/initiate$/, ctx => {
  needUser(ctx);
  // À adapter au prestataire choisi : créer la transaction chez lui avec la clé SECRÈTE (variables d'environnement), puis renvoyer { redirectUrl }.
  bad("Paiement électronique non configuré sur ce serveur. Utilisez le paiement manuel via WhatsApp.", 501);
});
route("POST", /^\/api\/payments\/webhook$/, ctx => {
  const secret = process.env.PAY_WEBHOOK_SECRET; if (!secret) bad("Webhook non configuré.", 503);
  const sig = String(ctx.req.headers["x-signature"] || ""), calc = crypto.createHmac("sha256", secret).update(ctx.raw || "").digest("hex");
  if (sig.length !== calc.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(calc))) bad("Signature invalide.", 401);
  const r = one("SELECT * FROM requests WHERE ref=?", String(ctx.f.reference || "")); if (!r) bad("Référence inconnue.", 404);
  if (Number(ctx.f.amount) !== r.amount) { audit("webhook", `Montant incohérent pour ${r.ref}`); bad("Montant incohérent.", 409); }
  if (ctx.f.status === "success" && r.status === "pending") { tx(() => activate(r, "electronic", String(ctx.f.transactionId || "").slice(0, 80))); audit("webhook", `Paiement électronique confirmé : ${r.ref}`); }
  else if (ctx.f.status === "failed") { notify(r.user_id, `Le paiement électronique de ${r.ref} a échoué.`); audit("webhook", `Échec paiement : ${r.ref}`); }
  return { ok: true };
});

/* --- Notifications, messages, signalements --- */
route("POST", /^\/api\/notifs\/read$/, ctx => { const u = needUser(ctx); run("UPDATE notifs SET seen=1 WHERE user_id=?", u.id); return { ok: true }; });
route("POST", /^\/api\/messages$/, ctx => {
  const u = needUser(ctx); rate("msg|" + u.id, 20, 3600e3); const type = ctx.f.type === "claim" ? "claim" : "msg";
  run("INSERT INTO msgs(id,user_id,type,subject,body,created) VALUES(?,?,?,?,?,?)", uid(), u.id, type, str(ctx.f.subject, 2, 120, "Sujet"), str(ctx.f.body, 3, 3000, "Message"), Date.now());
  notifyAdmins(`${type === "claim" ? "Nouvelle réclamation" : "Nouveau message"} de ${u.name}.`); return { ok: true };
});
route("POST", /^\/api\/reports$/, ctx => {
  const u = needUser(ctx); rate("rep|" + u.id, 30, 3600e3); const it = MODS[ctx.f.module] && one("SELECT * FROM items WHERE id=? AND module=?", String(ctx.f.id), ctx.f.module);
  if (!it) bad("Contenu introuvable.", 404);
  run("INSERT OR IGNORE INTO reports(id,user_id,module,item_id,title,created) VALUES(?,?,?,?,?,?)", uid(), u.id, it.module, it.id, it.title, Date.now()); notifyAdmins(`Contenu signalé : « ${it.title} ».`); return { ok: true };
});

/* --- Espace publicitaire (location par durée) --- */
const adOut = a => ({ id: a.id, title: a.title, link: a.link, media: "/uploads/" + a.media, type: a.mtype, label: a.label, days: a.days, amount: a.amount, status: a.status, starts: a.starts, expires: a.expires, clicks: a.clicks || 0, t: a.created, userId: a.user_id, userName: a.uname });
function adLink(v) { const x = String(v || "").trim(); if (!x) return null; if (/^https?:\/\/[^\s]{3,400}$/i.test(x)) return x; const p = normPhone(x); if (phoneOk(p)) return "https://wa.me/" + waNumber(p); bad("Lien invalide : indiquez une adresse web (https://…) ou un numéro WhatsApp."); }
function adRequest(u, adId, plan, title) {
  const id = uid(), ref = newRef();
  run("INSERT INTO requests(id,ref,user_id,service,amount,meta,created) VALUES(?,?,?,?,?,?,?)", id, ref, u.id, `Publicité – ${plan.label}`, plan.price, JSON.stringify({ type: "ad", adId }), Date.now());
  audit(u.name, `Demande créée : Publicité – ${plan.label} (${ref})`); notifyAdmins(`Nouvelle demande de paiement ${ref} : publicité « ${title} » (${plan.label}).`); return { id, ref };
}
route("GET", /^\/api\/ads\/active$/, () => ({ items: all("SELECT id,title,link,media,mtype FROM ads WHERE status='active' AND expires>? ORDER BY created DESC LIMIT 20", Date.now()).map(a => ({ id: a.id, title: a.title, link: a.link, media: "/uploads/" + a.media, type: a.mtype })) }));
route("POST", /^\/api\/ads$/, async ctx => {
  const u = needUser(ctx), f = ctx.f, st = getSettings(); rate("ad|" + u.id, 10, 3600e3);
  const plan = st.adPlans.find(p => p.id === f.plan) || bad("Durée de location invalide.");
  const title = str(f.title, 2, 80, "Titre de la publicité"), link = adLink(f.link);
  const media = await saveFile(ctx.files.media, { video: true, max: 12 * 1024 * 1024 }); if (!media) bad("Ajoutez une image ou une vidéo.");
  const mtype = /\.(mp4|webm)$/.test(media.name) ? "video" : "image", id = uid(), now = Date.now(), adm = u.role === "admin";
  run("INSERT INTO ads(id,user_id,title,link,media,mtype,label,days,amount,status,starts,expires,created) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)", id, u.id, title, link, media.name, mtype, plan.label, plan.days, adm ? 0 : plan.price, adm ? "active" : "pending", adm ? now : null, adm ? now + plan.days * DAY : null, now);
  if (adm) { audit(u.name, `Publicité mise en ligne : ${title}`); return { id, active: true }; }
  const q = adRequest(u, id, plan, title); return { id, requestId: q.id, ref: q.ref, amount: plan.price };
});
route("POST", /^\/api\/ads\/(\w+)\/click$/, ctx => { rate("adc|" + ctx.ip + "|" + ctx.m[1], 3, 600e3); run("UPDATE ads SET clicks=clicks+1 WHERE id=? AND status='active'", ctx.m[1]); return { ok: true }; });
route("POST", /^\/api\/ads\/(\w+)\/renew$/, ctx => {
  const u = needUser(ctx), ad = one("SELECT * FROM ads WHERE id=?", ctx.m[1]); if (!ad || ad.user_id !== u.id || ad.status === "removed") bad("Publicité introuvable.", 404);
  if (!["expired", "rejected"].includes(ad.status)) bad("Cette publicité est déjà en cours ou en attente.", 409);
  const plan = getSettings().adPlans.find(p => p.id === ctx.f.plan) || bad("Durée de location invalide.");
  run("UPDATE ads SET status='pending', days=?, label=?, amount=?, starts=NULL, expires=NULL WHERE id=?", plan.days, plan.label, plan.price, ad.id);
  const q = adRequest(u, ad.id, plan, ad.title); return { id: ad.id, requestId: q.id, ref: q.ref, amount: plan.price };
});
route("DELETE", /^\/api\/ads\/(\w+)$/, ctx => {
  const u = needUser(ctx), ad = one("SELECT * FROM ads WHERE id=?", ctx.m[1]); if (!ad || (ad.user_id !== u.id && u.role !== "admin") || ad.status === "removed") bad("Publicité introuvable.", 404);
  run("UPDATE ads SET status='removed' WHERE id=?", ad.id); rmFile(PUB_DIR, ad.media); audit(u.name, `Publicité retirée : ${ad.title}`); return { ok: true };
});

/* --- Administration --- */
route("POST", /^\/api\/admin\/requests\/(\w+)\/decision$/, ctx => {
  const a = needAdmin(ctx), r = one("SELECT * FROM requests WHERE id=?", ctx.m[1]); if (!r) bad("Demande introuvable.", 404);
  if (r.status !== "pending") bad("Cette demande est déjà traitée.", 409);
  if (ctx.f.status === "approved") tx(() => activate(r, "manual"));
  else if (ctx.f.status === "refused") { { const mt = JSON.parse(r.meta || "{}"); if (mt.type === "ad") run("UPDATE ads SET status='rejected' WHERE id=?", mt.adId); } run("UPDATE requests SET status='refused', decided=? WHERE id=?", Date.now(), r.id); notify(r.user_id, `Paiement ${r.ref} refusé. Contactez l'assistance.`); }
  else bad("Décision invalide.");
  audit(a.name, `${ctx.f.status === "approved" ? "Validation" : "Refus"} du paiement ${r.ref} (${r.amount} FCFA)`); return { ok: true };
});
route("POST", /^\/api\/admin\/shops\/([\w-]+)$/, ctx => {
  const a = needAdmin(ctx), s = one("SELECT * FROM shops WHERE id=?", ctx.m[1]); if (!s) bad("Boutique introuvable.", 404);
  if (!["active", "suspended"].includes(ctx.f.status)) bad("Statut invalide."); run("UPDATE shops SET status=? WHERE id=?", ctx.f.status, s.id);
  notify(s.user_id, ctx.f.status === "suspended" ? `Votre boutique « ${s.name} » a été suspendue.` : `Votre boutique « ${s.name} » a été réactivée.`);
  audit(a.name, `Boutique « ${s.name} » : ${ctx.f.status}`); return { ok: true };
});
route("POST", /^\/api\/admin\/reports\/(\w+)$/, ctx => {
  const a = needAdmin(ctx), r = one("SELECT * FROM reports WHERE id=?", ctx.m[1]); if (!r) bad("Signalement introuvable.", 404);
  tx(() => { if (ctx.f.delete) { const it = one("SELECT * FROM items WHERE id=?", r.item_id); if (it) { run("UPDATE items SET status='removed' WHERE id=?", it.id); rmFile(PUB_DIR, it.photo && path.basename(it.photo)); notify(it.user_id, `Votre publication « ${it.title} » a été retirée par la modération.`); } run("DELETE FROM reports WHERE item_id=?", r.item_id); } else run("DELETE FROM reports WHERE id=?", r.id); });
  audit(a.name, `${ctx.f.delete ? "Contenu retiré" : "Signalement ignoré"} : ${r.title}`); return { ok: true };
});
route("POST", /^\/api\/admin\/users\/(\w+)$/, async ctx => {
  const a = needAdmin(ctx), u = one("SELECT * FROM users WHERE id=?", ctx.m[1]); if (!u) bad("Utilisateur introuvable.", 404);
  const act = ctx.f.action; let extra = {};
  if (u.id === a.id && ["suspend", "role"].includes(act)) bad("Action impossible sur votre propre compte.");
  if (act === "verify") run("UPDATE users SET verified=1 WHERE id=?", u.id);
  else if (act === "suspend") { run("UPDATE users SET status='suspended' WHERE id=?", u.id); run("DELETE FROM sessions WHERE user_id=?", u.id); }
  else if (act === "activate") run("UPDATE users SET status='active' WHERE id=?", u.id);
  else if (act === "role") { if (!ROLES.includes(ctx.f.role)) bad("Rôle invalide."); run("UPDATE users SET role=? WHERE id=?", ctx.f.role, u.id); }
  else if (act === "resetpw") { const tmp = crypto.randomBytes(5).toString("hex") + "A1"; run("UPDATE users SET pass=? WHERE id=?", await hashPw(tmp), u.id); run("DELETE FROM sessions WHERE user_id=?", u.id); extra = { tempPassword: tmp }; }
  else bad("Action inconnue.");
  audit(a.name, `Utilisateur ${u.name} : ${act}${act === "role" ? " → " + ctx.f.role : ""}`); return { ok: true, ...extra };
});
route("POST", /^\/api\/admin\/msgs\/(\w+)$/, ctx => { const a = needAdmin(ctx); run("UPDATE msgs SET status='closed' WHERE id=?", ctx.m[1]); audit(a.name, "Message clôturé"); return { ok: true }; });
route("PUT", /^\/api\/admin\/settings$/, ctx => {
  const a = needAdmin(ctx), cur = getSettings(), f = ctx.f, num = (v, min, max, l) => { const n = Number(v); if (!(n >= min && n <= max)) bad(`${l} invalide.`); return n; };
  const next = { ...cur };
  if (Array.isArray(f.plans)) next.plans = cur.plans.map((p, i) => ({ ...p, price: num(f.plans[i]?.price ?? p.price, 0, 1e9, "Prix"), products: num(f.plans[i]?.products ?? p.products, 1, 99999, "Produits") }));
  if (Array.isArray(f.durations)) next.durations = cur.durations.map((d, i) => ({ ...d, discount: num(f.durations[i]?.discount ?? d.discount, 0, 90, "Remise") }));
  if (Array.isArray(f.adPlans)) next.adPlans = cur.adPlans.map((p, i) => ({ ...p, price: num(f.adPlans[i]?.price ?? p.price, 0, 1e9, "Prix publicité") }));
  if (Array.isArray(f.proPlans)) next.proPlans = cur.proPlans.map((p, i) => ({ ...p, price: num(f.proPlans[i]?.price ?? p.price, 0, 1e9, "Prix compte pro") }));
  for (const [k, max] of [["jobValidationFee", 1e9], ["jobPostFee", 1e9], ["sponsoredAdFee", 1e9], ["freeAdLimit", 1000], ["commissionPct", 50]]) if (f[k] !== undefined) next[k] = num(f[k], 0, max, k);
  run("INSERT INTO kv(k,v) VALUES('settings',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", JSON.stringify(next)); audit(a.name, "Tarifs et paramètres modifiés"); return { ok: true, settings: next };
});

/* --- Synchronisation des données de l'utilisateur connecté --- */
/* --- Factures, journaux de caisse et proforma administrateur --- */
const docOut = r => ({ id: r.id, kind: r.kind, t: r.created, ownerId: r.owner_id, targetId: r.target_id || null, shopId: r.shop_id || null, data: JSON.parse(r.data) });
route("POST", /^\/api\/docs$/, ctx => {
  const u = needUser(ctx); rate("doc|" + u.id, 80, 3600e3); const f = ctx.f, kind = String(f.kind || "");
  if (!["invoice", "journal", "adminpro"].includes(kind)) bad("Type de document invalide.");
  if (!f.data || typeof f.data !== "object" || Array.isArray(f.data)) bad("Données invalides.");
  const raw = JSON.stringify(f.data); if (raw.length > 60000) bad("Document trop volumineux.", 413);
  const s = one("SELECT * FROM shops WHERE id=?", String(f.shopId || "")); if (!s) bad("Boutique introuvable.", 404);
  let target = null;
  if (kind === "adminpro") { needAdmin(ctx); target = s.user_id; }
  else if (s.user_id !== u.id && u.role !== "admin") bad("Boutique introuvable.", 404);
  const id = uid(), now = Date.now();
  run("INSERT INTO docs(id,kind,owner_id,target_id,shop_id,data,created) VALUES(?,?,?,?,?,?,?)", id, kind, u.id, target, s.id, raw, now);
  if (kind === "adminpro") { notify(target, `🧾 Facture proforma ${String(f.data.number || "").slice(0, 30)} reçue de DigiZORA (${Math.round(Number(f.data.total) || 0)} FCFA). Consultez-la dans « Factures ».`); audit(u.name, `Facture proforma ${String(f.data.number || "").slice(0, 30)} envoyée à « ${s.name} »`); }
  return { doc: docOut(one("SELECT * FROM docs WHERE id=?", id)) };
});
route("DELETE", /^\/api\/docs\/(\w+)$/, ctx => {
  const u = needUser(ctx), d = one("SELECT * FROM docs WHERE id=?", ctx.m[1]); if (!d || (d.owner_id !== u.id && u.role !== "admin")) bad("Document introuvable.", 404);
  run("DELETE FROM docs WHERE id=?", d.id); return { ok: true };
});
route("GET", /^\/api\/sync$/, ctx => {
  const u = needUser(ctx), adm = u.role === "admin", out = { settings: getSettings(), items: {} };
  out.notifs = all("SELECT id, created t, text, seen FROM notifs WHERE user_id=? ORDER BY created DESC LIMIT 100", u.id).map(n => ({ id: n.id, t: n.t, text: n.text, read: !!n.seen }));
  const rq = r => ({ id: r.id, ref: r.ref, service: r.service, amount: r.amount, status: r.status, t: r.created, userId: r.user_id, userName: r.uname, proof: r.proof_name || undefined, proofUrl: r.proof_file ? "/api/files/" + r.proof_file : undefined });
  out.requests = all(`SELECT r.*, u.name uname FROM requests r JOIN users u ON u.id=r.user_id ${adm ? "" : "WHERE r.user_id=?"} ORDER BY r.created DESC LIMIT 500`, ...(adm ? [] : [u.id])).map(rq);
  const shops = all(`SELECT * FROM shops ${adm ? "" : "WHERE user_id=?"} ORDER BY created DESC`, ...(adm ? [] : [u.id]));
  out.shops = shops.map(s => shopOut(s)); for (const s of shops) out.items["prod_" + s.id] = shopProducts(s.id);
  for (const r of all("SELECT * FROM items WHERE user_id=? AND status='published' ORDER BY created DESC", u.id)) (out.items[r.module] ||= []).push(itemOut(r));
  out.apps = all("SELECT id, created t, title, user_id FROM apps WHERE user_id=? ORDER BY created DESC", u.id).map(a => ({ id: a.id, t: a.t, title: a.title, userId: a.user_id }));
  out.received = all(`SELECT a.id, a.created t, a.title, u.name, u.phone, u.email, j.title jt, j.skills, j.cv_file FROM apps a JOIN users u ON u.id=a.user_id LEFT JOIN jobprofiles j ON j.user_id=a.user_id WHERE a.owner_id=? ORDER BY a.created DESC LIMIT 200`, u.id)
    .map(a => ({ id: a.id, t: a.t, title: a.title, name: a.name, phone: a.phone, email: a.email, profile: a.jt, skills: a.skills, cvUrl: a.cv_file ? "/api/files/" + a.cv_file : undefined }));
  out.ads = all(`SELECT a.*, u.name uname FROM ads a JOIN users u ON u.id=a.user_id WHERE a.status<>'removed' ${adm ? "" : "AND a.user_id=?"} ORDER BY a.created DESC LIMIT 300`, ...(adm ? [] : [u.id])).map(adOut);
  out.msgs = all("SELECT id, created t, type, subject, body, status FROM msgs WHERE user_id=? AND type IN ('msg','claim') ORDER BY created DESC LIMIT 100", u.id);
  const jp = one("SELECT title, skills, exp, cv_name FROM jobprofiles WHERE user_id=?", u.id); out.jobprofile = jp || null;
  out.orders = all(`SELECT o.*, s.name shop_name FROM orders o LEFT JOIN shops s ON s.id=o.shop_id ${adm ? "" : "WHERE o.seller_id=?"} ORDER BY o.created DESC LIMIT 300`, ...(adm ? [] : [u.id])).map(o => ({ id: o.id, ref: o.ref, shop: o.shop_name, product: o.product_title, qty: o.qty, unit: o.unit_price, delivery: o.delivery, total: o.total, name: o.cust_name, phone: o.cust_phone, address: o.cust_address, city: o.cust_city, note: o.note, status: o.status, t: o.created }));
  out.pro = all("SELECT id, sector, company, phone, city, status, expires FROM proaccts WHERE user_id=?", u.id);
  out.userMods = userMods(u);
  out.docs = all(adm ? "SELECT * FROM docs ORDER BY created DESC LIMIT 500" : "SELECT * FROM docs WHERE owner_id=? OR target_id=? ORDER BY created DESC LIMIT 500", ...(adm ? [] : [u.id, u.id])).map(docOut);
  if (adm) {
    out.reports = all("SELECT id, created t, module mod, item_id itemId, title FROM reports ORDER BY created DESC LIMIT 200");
    out.audit = all("SELECT t, who, action a FROM audit ORDER BY id DESC LIMIT 200");
    out.users = all("SELECT id, name, role, phone, email, city, verified, job_validated, status, created, last_seen FROM users ORDER BY created DESC LIMIT 1000").map(x => ({ ...x, verified: !!x.verified, jobValidated: !!x.job_validated }));
    out.adminMsgs = all("SELECT m.id, m.created t, m.type, m.subject, m.body, m.status, u.name userName, u.phone FROM msgs m LEFT JOIN users u ON u.id=m.user_id WHERE m.status='open' ORDER BY m.created DESC LIMIT 200");
    out.outbox = all("SELECT id, created t, channel, dest, subject, body, status, error FROM outbox ORDER BY created DESC LIMIT 200");
    out.stats = stats();
  }
  return out;
});

/* --- Modules publics (annonces, emplois, immobilier, services…) : doit rester après les routes précises --- */
const MODRE = Object.keys(MODS).join("|");
route("GET", new RegExp(`^/api/(${MODRE})$`), ctx => {
  const m = ctx.m[1];
  return { items: all("SELECT i.*, u.name org, u.phone uphone, EXISTS(SELECT 1 FROM proaccts pa WHERE pa.user_id=i.user_id AND pa.status='active' AND pa.expires>" + Date.now() + ") pro FROM items i JOIN users u ON u.id=i.user_id WHERE i.module=? AND i.status='published' ORDER BY pro DESC, i.created DESC LIMIT 500", m).map(r => itemOut({ ...r, org: MODS[m].org ? r.org : undefined })) };
});
route("POST", new RegExp(`^/api/(${MODRE})$`), async ctx => {
  const u = needUser(ctx), m = ctx.m[1], M = MODS[m], f = ctx.f; rate("pub|" + u.id, 30, 3600e3);
  if (!userMods(u).includes(m)) bad(m === "rental" || m === "realestate" || m === "transport" ? "Cette rubrique requiert un compte professionnel : faites une demande dans « Comptes pro »." : "Votre type de compte ne permet pas de publier dans cette rubrique.", 403);
  const title = str(f.title, 4, 120, "Titre"), desc = str(f.desc, 10, 3000, "Description");
  if (!M.cats.includes(f.cat)) bad("Catégorie invalide."); if (!CITIES.includes(f.city)) bad("Ville invalide.");
  const price = f.price === undefined || f.price === "" ? 0 : Number(f.price); if (!(price >= 0 && price < 1e12)) bad("Prix invalide.");
  const contact = f.contact ? normPhone(f.contact) : null; if (contact && !phoneOk(contact)) bad("Numéro de contact invalide.");
  if (m === "market" && u.role !== "admin" && one("SELECT COUNT(*) n FROM items WHERE user_id=? AND module='market' AND status='published'", u.id).n >= getSettings().freeAdLimit)
    bad(`Limite de ${getSettings().freeAdLimit} annonces gratuites atteinte. Contactez l'assistance pour les options premium.`, 403);
  const photo = await saveFile(ctx.files.photo); const id = uid(), address = f.address ? String(f.address).trim().slice(0, 150) : null;
  run("INSERT INTO items(id,module,user_id,title,cat,city,price,contact,descr,photo,emoji,created,address) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)", id, m, u.id, title, f.cat, f.city, price, contact, desc, photo ? "/uploads/" + photo.name : null, M.icon, Date.now(), address);
  return { id };
});
route("POST", new RegExp(`^/api/(${MODRE})/(\\w+)/apply$`), ctx => {
  const u = needUser(ctx), it = one("SELECT * FROM items WHERE id=? AND module=? AND status='published'", ctx.m[2], ctx.m[1]); if (!it) bad("Annonce introuvable.", 404);
  if (it.user_id === u.id) bad("Vous ne pouvez pas répondre à votre propre publication.");
  if (one("SELECT 1 FROM apps WHERE user_id=? AND item_id=?", u.id, it.id)) bad("Vous avez déjà envoyé une demande pour cette publication.", 409);
  run("INSERT INTO apps(id,user_id,item_id,module,title,owner_id,created) VALUES(?,?,?,?,?,?,?)", uid(), u.id, it.id, it.module, it.title, it.user_id, Date.now());
  notify(it.user_id, `${u.name} a répondu à « ${it.title} ».`); return { ok: true };
});
route("POST", new RegExp(`^/api/(${MODRE})/(\\w+)/sold$`), ctx => {
  const u = needUser(ctx), it = one("SELECT * FROM items WHERE id=? AND module=?", ctx.m[2], ctx.m[1]); if (!it || (it.user_id !== u.id && u.role !== "admin")) bad("Publication introuvable.", 404);
  run("UPDATE items SET sold=? WHERE id=?", ctx.f.sold === true || ctx.f.sold === "true" || ctx.f.sold === 1 ? 1 : 0, it.id); return { ok: true };
});
route("DELETE", new RegExp(`^/api/(${MODRE})/(\\w+)$`), ctx => {
  const u = needUser(ctx), it = one("SELECT * FROM items WHERE id=? AND module=?", ctx.m[2], ctx.m[1]); if (!it || (it.user_id !== u.id && u.role !== "admin")) bad("Publication introuvable.", 404);
  run("UPDATE items SET status='removed' WHERE id=?", it.id); rmFile(PUB_DIR, it.photo && path.basename(it.photo)); audit(u.name, `Publication supprimée : ${it.title}`); return { ok: true };
});

/* ---------- 9. Serveur HTTP ---------- */
const STATIC = { "/": "index.html", "/index.html": "index.html", "/manifest.json": "manifest.json", "/sw.js": "sw.js", "/logo.png": "logo.png", "/icon-192.png": "icon-192.png", "/icon-512.png": "icon-512.png" };
const TYPES = { "index.html": "text/html; charset=utf-8", "manifest.json": "application/manifest+json", "sw.js": "text/javascript; charset=utf-8", "logo.png": "image/png", "icon-192.png": "image/png", "icon-512.png": "image/png" };
const gz = new Map();
const EMBED = globalThis.__DC_EMBED || {};   // version « fichier unique » : le site est intégré dans le serveur
function serveStatic(req, res, file) {
  let c = gz.get(file);
  if (EMBED[file]) { if (!c) { const raw = zlib.gunzipSync(Buffer.from(EMBED[file], "base64")); c = { m: 0, raw, z: zlib.gzipSync(raw, { level: 9 }) }; gz.set(file, c); } }
  else {
    const p = path.join(APP_DIR, file); let st; try { st = fs.statSync(p); } catch { res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }); return res.end("Fichier introuvable : " + file); }
    if (!c || c.m !== st.mtimeMs) { const raw = fs.readFileSync(p); c = { m: st.mtimeMs, raw, z: zlib.gzipSync(raw, { level: 9 }) }; gz.set(file, c); }
  }
  const useGz = /\bgzip\b/.test(req.headers["accept-encoding"] || "");
  res.writeHead(200, { "Content-Type": TYPES[file], "Cache-Control": "no-cache", ...(useGz ? { "Content-Encoding": "gzip", Vary: "Accept-Encoding" } : {}) });
  res.end(req.method === "HEAD" ? undefined : useGz ? c.z : c.raw);
}
function sendFile(res, req, p, priv) {
  const ext = path.extname(p).slice(1); let st; try { st = fs.statSync(p); } catch { res.writeHead(404); return res.end(); }
  const hd = { "Content-Type": MIME[ext] || "application/octet-stream", "Cache-Control": priv ? "private, no-store" : "public, max-age=2592000, immutable", "Content-Disposition": "inline", "Accept-Ranges": "bytes" };
  const rg = !priv && req.headers.range && /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
  if (rg && st.size) {
    const a = rg[1] === "" ? Math.max(0, st.size - +rg[2]) : +rg[1], b = rg[1] !== "" && rg[2] !== "" ? Math.min(+rg[2], st.size - 1) : st.size - 1;
    if (!(a >= 0 && a <= b)) { res.writeHead(416, { "Content-Range": `bytes */${st.size}` }); return res.end(); }
    res.writeHead(206, { ...hd, "Content-Range": `bytes ${a}-${b}/${st.size}`, "Content-Length": b - a + 1 });
    if (req.method === "HEAD") return res.end(); return fs.createReadStream(p, { start: a, end: b }).pipe(res);
  }
  res.writeHead(200, { ...hd, "Content-Length": st.size });
  if (req.method === "HEAD") return res.end(); fs.createReadStream(p).pipe(res);
}
function json(res, status, obj) { const b = JSON.stringify(obj); res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }); res.end(b); }

const server = http.createServer(async (req, res) => {
  const ip = clientIp(req); let url;
  try { url = new URL(req.url, "http://x"); } catch { res.writeHead(400); return res.end(); }
  res.setHeader("X-Content-Type-Options", "nosniff"); res.setHeader("X-Frame-Options", "DENY"); res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self' data:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  if (isHttps(req)) res.setHeader("Strict-Transport-Security", "max-age=15552000");
  const p = url.pathname;
  try {
    if (!["GET", "HEAD", "POST", "PUT", "DELETE"].includes(req.method)) { res.writeHead(405); return res.end(); }
    if (p.startsWith("/uploads/")) { const n = p.slice(9); if (!/^[a-f0-9]{32}\.(jpg|png|webp|mp4|webm)$/.test(n)) { res.writeHead(404); return res.end(); } return sendFile(res, req, path.join(PUB_DIR, n), false); }
    const sm = p.match(/^\/b\/([\w-]+)$/); if (sm) { res.writeHead(302, { Location: "/#/boutique/" + sm[1] }); return res.end(); }
    if (!p.startsWith("/api/")) { if (STATIC[p] && ["GET", "HEAD"].includes(req.method)) return serveStatic(req, res, STATIC[p]); res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }); return res.end("Page introuvable"); }

    rate("ip|" + ip, 600, 60e3);
    const ck = cookies(req); if (!ck["XSRF-TOKEN"]) { ck["XSRF-TOKEN"] = crypto.randomBytes(18).toString("base64url"); setCookie(res, req, "XSRF-TOKEN", ck["XSRF-TOKEN"], { maxAge: 31536000 }); }
    const unsafe = req.method !== "GET" && req.method !== "HEAD", isHook = p === "/api/payments/webhook";
    if (unsafe && !isHook) {
      const origin = req.headers.origin; if (origin) { let oh; try { oh = new URL(origin).host; } catch { oh = ""; } if (oh !== req.headers.host) bad("Origine non autorisée.", 403); }
      const h = String(req.headers["x-xsrf-token"] || ""), c = ck["XSRF-TOKEN"]; if (!h || h.length !== c.length || !crypto.timingSafeEqual(Buffer.from(h), Buffer.from(c))) bad("Jeton de sécurité invalide. Rechargez la page.", 403);
    }
    for (const [method, re, fn] of routes) {
      if (method !== req.method && !(method === "GET" && req.method === "HEAD")) continue; const m = p.match(re); if (!m) continue;
      const body = await parseBody(req); const ctx = { req, res, ip, m, f: body.f, files: body.files, raw: body.raw, user: currentUser(req) };
      const out = await fn(ctx); if (out && out.file) return sendFile(res, req, out.file, out.priv); return json(res, 200, out ?? { ok: true });
    }
    bad("Route introuvable.", 404);
  } catch (e) {
    if (e instanceof HttpError) return json(res, e.status, { message: e.message });
    console.error(e); json(res, 500, { message: "Erreur interne du serveur." });
  }
});

/* ---------- 10. Démarrage ---------- */
async function ensureAdmin() {
  const { ADMIN_EMAIL: em, ADMIN_PASSWORD: pw, ADMIN_NAME: nm, ADMIN_PHONE: ph } = process.env;
  const mark = () => { try { fs.writeFileSync(path.join(DATA_DIR, "admin-ok.txt"), "ok"); } catch { /* sans importance */ } };
  if (one("SELECT 1 FROM users WHERE role='admin'")) return mark();
  if (!em || !pw) { console.log("⚠  Aucun administrateur. Définissez ADMIN_EMAIL et ADMIN_PASSWORD puis redémarrez (voir .env.example)."); return; }
  pwRule(pw); run("INSERT INTO users(id,role,name,phone,email,city,pass,verified,created) VALUES(?,?,?,?,?,?,?,1,?)", uid(), "admin", nm || "Administrateur", ph ? normPhone(ph) : null, em.toLowerCase(), "Brazzaville", await hashPw(pw), Date.now());
  audit("système", "Compte administrateur créé"); console.log("✔ Compte administrateur créé :", em); mark();
}
process.on("unhandledRejection", e => console.error("unhandledRejection:", e));
if (require.main === module || globalThis.__DC_BUNDLE) {
  ensureAdmin().then(() => { maintenance(); setInterval(maintenance, 36e5).unref(); server.listen(PORT, process.env.HOST || undefined, () => console.log(`DigiZORA prêt sur http://localhost:${PORT}  (données : ${DATA_DIR})`)); }).catch(e => { console.error(e.message); process.exit(1); });
}
module.exports = { server, ensureAdmin };
