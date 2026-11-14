"use strict";
/* Mini-client PostgreSQL sans aucune dépendance (protocole v3, TLS, SCRAM-SHA-256).
   Suffisant pour sauvegarder/restaurer les données de DigiZORA dans Neon / Supabase / Render Postgres. */
const net = require("node:net");
const tls = require("node:tls");
const crypto = require("node:crypto");

const hmac = (k, d) => crypto.createHmac("sha256", k).update(d).digest();
const sha256 = d => crypto.createHash("sha256").update(d).digest();
const xor = (a, b) => Buffer.from(a.map((x, i) => x ^ b[i]));

class PgClient {
  constructor(url) {
    const u = new URL(url);
    this.host = u.hostname; this.port = +u.port || 5432;
    this.user = decodeURIComponent(u.username); this.password = decodeURIComponent(u.password);
    this.database = decodeURIComponent(u.pathname.slice(1)) || this.user;
    this.sslmode = u.searchParams.get("sslmode") || "require";
    this.sock = null; this.buf = Buffer.alloc(0); this.handler = null; this.chain = Promise.resolve();
  }

  /* ---- connexion ---- */
  async connect() {
    this.close();
    let sock = await new Promise((res, rej) => {
      const s = net.connect({ host: this.host, port: this.port });
      s.setTimeout(20000, () => { s.destroy(); rej(new Error("Délai dépassé (connexion à la base)")); });
      s.once("connect", () => { s.setTimeout(0); res(s); }); s.once("error", rej);
    });
    if (this.sslmode !== "disable") {
      sock.write(Buffer.from([0, 0, 0, 8, 4, 210, 22, 47]));
      const ans = await new Promise((res, rej) => { sock.once("data", res); sock.once("error", rej); });
      if (ans[0] !== 0x53) { sock.destroy(); throw new Error("Le serveur de base de données refuse le chiffrement TLS"); }
      sock = await new Promise((res, rej) => {
        const t = tls.connect({ socket: sock, servername: net.isIP(this.host) ? undefined : this.host, rejectUnauthorized: this.sslmode !== "no-verify" }, () => res(t));
        t.once("error", rej);
      });
    }
    sock.setKeepAlive(true, 30000);
    this.sock = sock; this.buf = Buffer.alloc(0);
    sock.on("data", d => { this.buf = Buffer.concat([this.buf, d]); this._pump(); });
    const dead = e => { if (this.sock === sock) { this.sock = null; } if (this.handler) { const h = this.handler; this.handler = null; h({ t: "!", err: e || new Error("Connexion à la base interrompue") }); } };
    sock.on("error", dead); sock.on("close", () => dead());
    await this._startup();
  }
  close() { if (this.sock) { try { this.sock.destroy(); } catch { /* rien */ } this.sock = null; } }

  _pump() {
    while (this.handler && this.buf.length >= 5) {
      const len = this.buf.readInt32BE(1);
      if (this.buf.length < 1 + len) return;
      const t = String.fromCharCode(this.buf[0]); const body = this.buf.subarray(5, 1 + len);
      this.buf = this.buf.subarray(1 + len);
      if (this.handler) this.handler({ t, body });
    }
  }
  _next() { return new Promise(res => { this.handler = m => { this.handler = null; res(m); }; this._pump(); }); }
  _send(type, body) {
    const b = Buffer.alloc(5 + body.length); b.write(type, 0, "latin1"); b.writeInt32BE(4 + body.length, 1); body.copy(b, 5);
    this.sock.write(b);
  }

  async _startup() {
    const params = ["user", this.user, "database", this.database, "client_encoding", "UTF8"].map(s => Buffer.from(s + "\0"));
    const body = Buffer.concat([Buffer.from([0, 3, 0, 0]), ...params, Buffer.from([0])]);
    const msg = Buffer.alloc(4 + body.length); msg.writeInt32BE(msg.length, 0); body.copy(msg, 4);
    this.sock.write(msg);
    let scram = null;
    for (;;) {
      const m = await this._next();
      if (m.t === "!") throw m.err;
      if (m.t === "E") throw new Error("Base de données : " + this._err(m.body));
      if (m.t === "R") {
        const code = m.body.readInt32BE(0);
        if (code === 0) continue;
        if (code === 3) { this._send("p", Buffer.from(this.password + "\0")); continue; }
        if (code === 5) {
          const salt = m.body.subarray(4, 8);
          const md5 = s => crypto.createHash("md5").update(s).digest("hex");
          this._send("p", Buffer.from("md5" + md5(Buffer.concat([Buffer.from(md5(this.password + this.user)), salt])) + "\0")); continue;
        }
        if (code === 10) {
          const nonce = crypto.randomBytes(18).toString("base64");
          scram = { nonce, first: `n=*,r=${nonce}` };
          const first = Buffer.from("n,," + scram.first);
          const mech = Buffer.from("SCRAM-SHA-256\0"); const len = Buffer.alloc(4); len.writeInt32BE(first.length);
          this._send("p", Buffer.concat([mech, len, first])); continue;
        }
        if (code === 11) {
          const sv = m.body.subarray(4).toString(); const kv = Object.fromEntries(sv.split(",").map(x => [x[0], x.slice(2)]));
          if (!kv.r.startsWith(scram.nonce)) throw new Error("Authentification SCRAM invalide");
          const salted = crypto.pbkdf2Sync(this.password.normalize("NFKC"), Buffer.from(kv.s, "base64"), +kv.i, 32, "sha256");
          const clientKey = hmac(salted, "Client Key"); const storedKey = sha256(clientKey);
          const withoutProof = `c=biws,r=${kv.r}`;
          const authMsg = `${scram.first},${sv},${withoutProof}`;
          const proof = xor(clientKey, hmac(storedKey, authMsg));
          scram.serverSig = hmac(hmac(salted, "Server Key"), authMsg).toString("base64");
          this._send("p", Buffer.from(`${withoutProof},p=${proof.toString("base64")}`)); continue;
        }
        if (code === 12) {
          const v = m.body.subarray(4).toString().replace(/^v=/, "");
          if (v !== scram.serverSig) throw new Error("Signature du serveur de base de données invalide");
          continue;
        }
        throw new Error("Méthode d'authentification non prise en charge (" + code + ")");
      }
      if (m.t === "Z") return;
    }
  }

  _err(body) {
    const f = {}; let i = 0;
    while (i < body.length && body[i] !== 0) { const k = String.fromCharCode(body[i]); const e = body.indexOf(0, i + 1); f[k] = body.toString("utf8", i + 1, e); i = e + 1; }
    return f.M || "erreur inconnue";
  }

  /* ---- requête (protocole simple). Retourne { rows:[{col:valeur}] } ---- */
  query(sql) {
    const job = this.chain.then(() => this._query(sql, true));
    this.chain = job.catch(() => {});
    return job;
  }
  async _query(sql, retry) {
    try {
      if (!this.sock) await this.connect();
      this._send("Q", Buffer.from(sql + "\0"));
      let cols = [], rows = [], error = null;
      for (;;) {
        const m = await this._next();
        if (m.t === "!") { const e = m.err; e.conn = true; throw e; }
        if (m.t === "T") {
          cols = []; let p = 2; const n = m.body.readInt16BE(0);
          for (let i = 0; i < n; i++) { const e = m.body.indexOf(0, p); cols.push(m.body.toString("utf8", p, e)); p = e + 19; }
          rows = [];
        } else if (m.t === "D") {
          const n = m.body.readInt16BE(0); let p = 2; const r = {};
          for (let i = 0; i < n; i++) { const l = m.body.readInt32BE(p); p += 4; if (l < 0) r[cols[i]] = null; else { r[cols[i]] = m.body.toString("utf8", p, p + l); p += l; } }
          rows.push(r);
        } else if (m.t === "E") error = new Error("Base de données : " + this._err(m.body));
        else if (m.t === "Z") { if (error) throw error; return { rows }; }
      }
    } catch (e) {
      if (e.conn || /Délai|ECONN|ENOTFOUND|EPIPE|ETIMEDOUT|socket/i.test(e.message)) {
        this.close();
        if (retry) return this._query(sql, false);
      }
      throw e;
    }
  }
}

const lit = s => { s = String(s); if (s.includes("\0")) throw new Error("caractère nul interdit"); return "'" + s.replace(/'/g, "''") + "'"; };
const hexLit = buf => "'\\x" + buf.toString("hex") + "'";
const fromBytea = s => Buffer.from(s.slice(2), "hex");

module.exports = { PgClient, lit, hexLit, fromBytea };
