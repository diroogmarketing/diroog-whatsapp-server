require("dotenv").config();

const express = require("express");
const qrcode = require("qrcode");
const qrcodeTerminal = require("qrcode-terminal");
const pino = require("pino");
const path = require("path");
const fs = require("fs");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3001;
const API_KEY = process.env.API_KEY || "changeme";

// ─── Auth middleware ──────────────────────────────────────────────────────────
function requireApiKey(req, res, next) {
  const key = req.headers["x-api-key"] || req.query["x-api-key"];
  if (key !== API_KEY) return res.status(401).json({ error: "Non autorisé" });
  next();
}

// ─── État global ──────────────────────────────────────────────────────────────
let sock = null;
let qrCodeData = null;
let connectionState = "disconnected"; // disconnected | connecting | connected

// ─── Démarrage Baileys ────────────────────────────────────────────────────────
async function startWhatsApp() {
  const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } =
    await import("@whiskeysockets/baileys");

  const sessionDir = path.join(__dirname, "session");
  if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir);

  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: "silent" }),
    printQRInTerminal: false,
    browser: ["Diroog CRM", "Chrome", "1.0.0"],
  });

  // Sauvegarde des credentials
  sock.ev.on("creds.update", saveCreds);

  // Gestion connexion
  sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      qrCodeData = qr;
      connectionState = "connecting";
      qrcodeTerminal.generate(qr, { small: true });
      console.log("📱 Scanne le QR code avec WhatsApp");
    }

    if (connection === "open") {
      connectionState = "connected";
      qrCodeData = null;
      console.log("✅ WhatsApp connecté !");
    }

    if (connection === "close") {
      connectionState = "disconnected";
      const code = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = code !== DisconnectReason.loggedOut;
      console.log(`❌ Déconnecté (code: ${code}). Reconnexion: ${shouldReconnect}`);
      if (shouldReconnect) {
        setTimeout(startWhatsApp, 3000);
      } else {
        // Session expirée → supprimer et redemander QR
        fs.rmSync(path.join(__dirname, "session"), { recursive: true, force: true });
        setTimeout(startWhatsApp, 3000);
      }
    }
  });
}

// ─── Routes API ───────────────────────────────────────────────────────────────

// GET /status — état de la connexion
app.get("/status", requireApiKey, (req, res) => {
  res.json({ status: connectionState });
});

// GET /qr — QR code en base64 (pour afficher dans le navigateur)
app.get("/qr", requireApiKey, async (req, res) => {
  if (connectionState === "connected") {
    return res.json({ connected: true, message: "Déjà connecté" });
  }
  if (!qrCodeData) {
    return res.json({ connected: false, message: "QR pas encore disponible, réessaie dans 5s" });
  }
  try {
    const qrImage = await qrcode.toDataURL(qrCodeData);
    res.json({ connected: false, qr: qrImage });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /send — envoyer un message
// Body: { phone: "0507565612", message: "Bonjour" }
app.post("/send", requireApiKey, async (req, res) => {
  const { phone, message } = req.body;

  if (!phone || !message) {
    return res.status(400).json({ error: "phone et message requis" });
  }
  if (connectionState !== "connected") {
    return res.status(503).json({ error: "WhatsApp non connecté", status: connectionState });
  }

  // Normaliser le numéro → format international sans +
  let normalized = phone.replace(/\s+/g, "").replace(/[^0-9+]/g, "");
  if (normalized.startsWith("+")) normalized = normalized.substring(1);
  else if (normalized.startsWith("0")) normalized = "972" + normalized.substring(1);

  const jid = `${normalized}@s.whatsapp.net`;

  try {
    await sock.sendMessage(jid, { text: message });
    console.log(`📤 Message envoyé à ${normalized}`);
    res.json({ success: true, to: normalized });
  } catch (e) {
    console.error("Erreur envoi:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /scan — page HTML avec le QR code à scanner
app.get("/scan", requireApiKey, async (req, res) => {
  if (connectionState === "connected") {
    return res.send(`<!DOCTYPE html><html><body style="font-family:sans-serif;text-align:center;padding:40px">
      <h2>✅ WhatsApp connecté !</h2><p>Le serveur est opérationnel.</p>
    </body></html>`);
  }
  if (!qrCodeData) {
    return res.send(`<!DOCTYPE html><html><head><meta http-equiv="refresh" content="3"></head>
      <body style="font-family:sans-serif;text-align:center;padding:40px">
      <h2>⏳ En attente du QR code...</h2><p>La page se rafraîchit automatiquement.</p>
    </body></html>`);
  }
  try {
    const qrImage = await qrcode.toDataURL(qrCodeData);
    res.send(`<!DOCTYPE html><html><head><meta http-equiv="refresh" content="30"></head>
      <body style="font-family:sans-serif;text-align:center;padding:40px;background:#f5f5f5">
      <h2>📱 Scanner avec WhatsApp</h2>
      <p>Ouvre WhatsApp → ⋮ → Appareils connectés → Connecter un appareil</p>
      <img src="${qrImage}" style="width:300px;height:300px;border:4px solid #25D366;border-radius:12px;padding:10px;background:white"/>
      <p style="color:#888;font-size:12px">Se rafraîchit toutes les 30 secondes</p>
    </body></html>`);
  } catch (e) {
    res.status(500).send(`Erreur: ${e.message}`);
  }
});

// GET / — health check
app.get("/", (req, res) => {
  res.json({ service: "Diroog WhatsApp Server", status: connectionState });
});

// ─── Démarrage ────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 Serveur démarré sur le port ${PORT}`);
  startWhatsApp();
});
