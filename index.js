const express = require("express");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
} = require("@whiskeysockets/baileys");
const pino = require("pino");
const QRCode = require("qrcode");
const path = require("path");
const fs = require("fs");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8080;
const API_KEY = process.env.API_KEY || null;
const AUTH_DIR = path.join(__dirname, "auth_state");
const WEBHOOK_URL = process.env.WEBHOOK_URL || null;

const logger = pino({ level: process.env.LOG_LEVEL || "warn" });

let sock = null;
let qrCode = null;
let isConnected = false;
let connectionUser = null;
let retryCount = 0;
const MAX_RETRIES = 5;

// ── Middleware ──────────────────────────────────────────────
function authMiddleware(req, res, next) {
  if (!API_KEY) return next();
  const key = req.headers["x-api-key"];
  if (key === API_KEY) return next();
  return res.status(401).json({ error: "Unauthorized" });
}
app.use(authMiddleware);

// ── WhatsApp Connection ────────────────────────────────────
async function startWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    logger,
    printQRInTerminal: true,
    generateHighQualityLinkPreview: false,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log("[WA] QR code received");
      try {
        qrCode = await QRCode.toDataURL(qr);
      } catch (e) {
        console.error("[WA] QR generation error:", e.message);
      }
    }

    if (connection === "open") {
      console.log("[WA] Connected!");
      isConnected = true;
      qrCode = null;
      retryCount = 0;
      connectionUser = {
        phone: sock.user?.id?.split(":")[0] || null,
        name: sock.user?.name || null,
      };
    }

    if (connection === "close") {
      isConnected = false;
      connectionUser = null;
      const statusCode =
        lastDisconnect?.error?.output?.statusCode ||
        lastDisconnect?.error?.output?.payload?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;

      if (loggedOut) {
        console.log("[WA] Logged out — clearing session");
        if (fs.existsSync(AUTH_DIR)) {
          fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        }
        qrCode = null;
        // Restart to get a new QR
        setTimeout(startWhatsApp, 2000);
      } else if (retryCount < MAX_RETRIES) {
        retryCount++;
        const delay = Math.min(retryCount * 2000, 10000);
        console.log(`[WA] Reconnecting (attempt ${retryCount}) in ${delay}ms...`);
        setTimeout(startWhatsApp, delay);
      } else {
        console.error("[WA] Max retries reached. Call /reset to try again.");
      }
    }
  });

  // Forward incoming messages to webhook
  sock.ev.on("messages.upsert", async ({ messages }) => {
    if (!WEBHOOK_URL) return;
    for (const msg of messages) {
      if (msg.key.fromMe) continue;
      try {
        await fetch(WEBHOOK_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            event: "message",
            data: {
              from: msg.key.remoteJid,
              participant: msg.key.participant || null,
              message: msg.message,
              pushName: msg.pushName || null,
              messageTimestamp: msg.messageTimestamp,
            },
          }),
        });
      } catch (e) {
        console.error("[WA] Webhook delivery failed:", e.message);
      }
    }
  });
}

// ── Routes ─────────────────────────────────────────────────

app.get("/status", (req, res) => {
  res.json({
    connected: isConnected,
    qrPending: !!qrCode && !isConnected,
    user: connectionUser,
  });
});

app.get("/qr", (req, res) => {
  if (isConnected) return res.json({ connected: true, qr: null });
  if (!qrCode) return res.json({ connected: false, qr: null, message: "QR not yet generated — wait a moment" });
  res.json({ qr: qrCode });
});

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    uptime: process.uptime(),
    modules: {
      baileys: "ok",
      express: "ok",
      qrcode: "ok",
    },
    env: {
      PORT: PORT ? "set" : "missing",
      API_KEY: API_KEY ? "set" : "not set",
      WEBHOOK_URL: WEBHOOK_URL ? "set" : "not set",
    },
    client: {
      ready: isConnected,
      qrPending: !!qrCode && !isConnected,
      user: connectionUser,
    },
  });
});

app.post("/reset", async (req, res) => {
  console.log("[WA] Session reset requested");
  isConnected = false;
  connectionUser = null;
  qrCode = null;
  retryCount = 0;

  try {
    if (sock) {
      await sock.logout().catch(() => {});
      sock.end();
      sock = null;
    }
  } catch (e) {
    console.error("[WA] Error during logout:", e.message);
  }

  if (fs.existsSync(AUTH_DIR)) {
    fs.rmSync(AUTH_DIR, { recursive: true, force: true });
  }

  setTimeout(startWhatsApp, 1000);
  res.json({ success: true, message: "Session reset — new QR will appear shortly" });
});

app.post("/send", async (req, res) => {
  if (!isConnected || !sock) {
    return res.status(503).json({ error: "Client not ready" });
  }

  const { to, message, type = "text" } = req.body;
  if (!to || !message) {
    return res.status(400).json({ error: "Missing 'to' and/or 'message'" });
  }

  // Ensure JID format
  const jid = to.includes("@") ? to : `${to.replace(/\D/g, "")}@s.whatsapp.net`;

  try {
    let result;
    if (type === "image" && message.url) {
      result = await sock.sendMessage(jid, {
        image: { url: message.url },
        caption: message.caption || "",
      });
    } else {
      result = await sock.sendMessage(jid, { text: String(message) });
    }
    res.json({ success: true, id: result?.key?.id });
  } catch (e) {
    console.error("[WA] Send error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get("/contacts", async (req, res) => {
  if (!isConnected || !sock) {
    return res.status(503).json({ error: "Client not ready" });
  }
  try {
    const contacts = await sock.store?.contacts || {};
    res.json({ contacts });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Start ──────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[Server] Listening on port ${PORT}`);
  startWhatsApp();
});
