const express = require("express");
const cors = require("cors");
const QRCode = require("qrcode");
const pino = require("pino");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
} = require("@whiskeysockets/baileys");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 8080;
const API_KEY = process.env.API_KEY || "";
const AUTH_DIR = process.env.AUTH_DIR || "./auth_state";

const logger = pino({ level: "info" });

// ─── Auth middleware ───
function auth(req, res, next) {
  if (!API_KEY) return next();
  const key = req.headers["x-api-key"] || req.query.api_key;
  if (key !== API_KEY) return res.status(401).json({ error: "Unauthorized" });
  next();
}
app.use(auth);

// ─── State ───
let sock = null;
let qrData = null;
let clientReady = false;
let clientInfo = null; // { name, phone }
let connectionRetries = 0;
const MAX_RETRIES = 5;

async function startSocket() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" })),
    },
    logger: pino({ level: "silent" }),
    printQRInTerminal: false,
    generateHighQualityLinkPreview: false,
  });

  // Save credentials on update
  sock.ev.on("creds.update", saveCreds);

  // Connection updates (QR, open, close)
  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      qrData = qr;
      clientReady = false;
      logger.info("QR code received. Scan it from the /qr endpoint.");
    }

    if (connection === "open") {
      qrData = null;
      clientReady = true;
      connectionRetries = 0;
      // Extract user info
      const me = sock.user;
      clientInfo = me
        ? { name: me.name || me.notify || "", phone: me.id.split(":")[0].split("@")[0] }
        : null;
      logger.info(`WhatsApp client is ready! ${clientInfo?.name || ""}`);
    }

    if (connection === "close") {
      clientReady = false;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      logger.info(`Connection closed. Status: ${statusCode}. Reconnect: ${shouldReconnect}`);

      if (shouldReconnect && connectionRetries < MAX_RETRIES) {
        connectionRetries++;
        const delay = Math.min(connectionRetries * 2000, 10000);
        logger.info(`Reconnecting in ${delay}ms (attempt ${connectionRetries}/${MAX_RETRIES})...`);
        setTimeout(startSocket, delay);
      } else if (!shouldReconnect) {
        logger.info("Logged out. Clearing auth state...");
        clientInfo = null;
        // Auth state will be stale; user needs to re-scan
        const fs = require("fs");
        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
      }
    }
  });
}

startSocket();

// ─── Helper: ensure connected ───
function ensureReady(res) {
  if (!clientReady || !sock) {
    res.status(503).json({ error: "Client not ready" });
    return false;
  }
  return true;
}

// ─── Routes (same API as whatsapp-web.js version) ───

app.get("/status", (req, res) => {
  res.json({
    connected: clientReady,
    user: clientInfo
      ? { name: clientInfo.name, phone: clientInfo.phone }
      : null,
    qrPending: !!qrData,
  });
});

app.get("/qr", async (req, res) => {
  if (clientReady) return res.json({ status: "already_connected" });
  if (!qrData) return res.json({ status: "waiting_for_qr", qr: null });
  try {
    const qrImage = await QRCode.toDataURL(qrData);
    res.json({ status: "scan_required", qr: qrImage });
  } catch (err) {
    res.status(500).json({ error: "Failed to generate QR" });
  }
});

app.get("/contacts", async (req, res) => {
  if (!ensureReady(res)) return;
  try {
    // Baileys stores contacts in sock.store or via sock.contacts
    // We use the onWhatsApp method for contact verification
    const contacts = sock.store?.contacts || {};
    const mapped = Object.values(contacts)
      .filter((c) => c.id?.endsWith("@s.whatsapp.net") && c.name)
      .map((c) => ({
        wa_id: c.id,
        name: c.name || c.notify || c.id.split("@")[0],
        phone: c.id.split("@")[0],
        is_business: false,
        profile_pic_url: null,
      }));
    res.json(mapped);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/groups", async (req, res) => {
  if (!ensureReady(res)) return;
  try {
    const groups = await sock.groupFetchAllParticipating();
    const mapped = Object.values(groups).map((g) => ({
      wa_id: g.id,
      name: g.subject,
      description: g.desc || "",
      member_count: g.participants?.length || 0,
      members: (g.participants || []).map((p) => ({
        id: p.id,
        isAdmin: p.admin === "admin" || p.admin === "superadmin",
      })),
      admins: (g.participants || [])
        .filter((p) => p.admin === "admin" || p.admin === "superadmin")
        .map((p) => p.id),
    }));
    res.json(mapped);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/chats", async (req, res) => {
  if (!ensureReady(res)) return;
  try {
    // Baileys doesn't have a direct getChats — we return contacts + groups as chat list
    const groups = await sock.groupFetchAllParticipating();
    const contacts = sock.store?.contacts || {};

    const chatList = [];

    // Add group chats
    Object.values(groups).forEach((g) => {
      chatList.push({
        wa_id: g.id,
        name: g.subject,
        is_group: true,
        unread_count: 0,
        last_message: null,
        timestamp: g.creation || 0,
      });
    });

    // Add individual contacts
    Object.values(contacts)
      .filter((c) => c.id?.endsWith("@s.whatsapp.net") && c.name)
      .forEach((c) => {
        chatList.push({
          wa_id: c.id,
          name: c.name || c.notify || c.id.split("@")[0],
          is_group: false,
          unread_count: 0,
          last_message: null,
          timestamp: 0,
        });
      });

    res.json(chatList.slice(0, 100));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/messages/:chatId", async (req, res) => {
  if (!ensureReady(res)) return;
  try {
    // Baileys doesn't persist message history by default
    // Return empty array — messages will be logged in Supabase via webhook
    res.json([]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/send", async (req, res) => {
  if (!ensureReady(res)) return;
  try {
    const { chatId, message } = req.body;
    if (!chatId || !message) {
      return res.status(400).json({ error: "chatId and message are required" });
    }
    const result = await sock.sendMessage(chatId, { text: message });
    res.json({
      success: true,
      wa_message_id: result.key.id,
      timestamp: Math.floor(Date.now() / 1000),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/send-status", async (req, res) => {
  if (!ensureReady(res)) return;
  try {
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: "message is required" });
    const result = await sock.sendMessage("status@broadcast", { text: message });
    res.json({
      success: true,
      wa_message_id: result.key.id,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/logout", async (req, res) => {
  if (!ensureReady(res)) return;
  try {
    await sock.logout();
    clientReady = false;
    clientInfo = null;
    qrData = null;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/reset", async (req, res) => {
  try {
    clientReady = false;
    clientInfo = null;
    qrData = null;
    if (sock) {
      sock.end(undefined);
      sock = null;
    }
    const fs = require("fs");
    fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    // Restart
    setTimeout(startSocket, 1000);
    res.json({ success: true, message: "Session reset. A new QR will appear shortly." });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`WhatsApp server running on port ${PORT}`);
});
