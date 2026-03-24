const express = require("express");
const cors = require("cors");
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require("@whiskeysockets/baileys");
const QRCode = require("qrcode");
const pino = require("pino");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || "";
const SESSION_DIR = process.env.SESSION_DIR || "./auth_session";

// ─── Auth middleware ───
function auth(req, res, next) {
  if (!API_KEY) return next();
  const key = req.headers["x-api-key"] || req.query.api_key;
  if (key !== API_KEY) return res.status(401).json({ error: "Unauthorized" });
  next();
}
app.use(auth);

// ─── Baileys state ───
let sock = null;
let qrData = null;
let clientReady = false;
let clientInfo = null;
let contactStore = {};   // jid -> { name, notify, ... }
let groupCache = {};     // jid -> group metadata

async function startSocket() {
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: true,
    logger: pino({ level: "warn" }),
    browser: ["WhatsApp Server", "Chrome", "1.0.0"],
    generateHighQualityLinkPreview: false,
  });

  // Save credentials on update
  sock.ev.on("creds.update", saveCreds);

  // QR code
  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      qrData = qr;
      clientReady = false;
      console.log("QR code received. Scan from /qr endpoint.");
    }

    if (connection === "open") {
      qrData = null;
      clientReady = true;
      clientInfo = {
        pushname: sock.user?.name || "Unknown",
        wid: sock.user?.id?.split(":")[0] || "",
      };
      console.log("WhatsApp connected!", clientInfo.pushname);
    }

    if (connection === "close") {
      clientReady = false;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log("Connection closed. Status:", statusCode, "Reconnecting:", shouldReconnect);
      if (shouldReconnect) {
        setTimeout(startSocket, 3000);
      } else {
        console.log("Logged out. Delete session folder and restart to re-link.");
      }
    }
  });

  // ─── Contact store: capture contacts pushed by WhatsApp ───
  sock.ev.on("contacts.upsert", (contacts) => {
    for (const c of contacts) {
      contactStore[c.id] = { ...contactStore[c.id], ...c };
    }
    console.log(`Contacts upserted: ${contacts.length} (total: ${Object.keys(contactStore).length})`);
  });

  sock.ev.on("contacts.update", (updates) => {
    for (const u of updates) {
      if (contactStore[u.id]) {
        contactStore[u.id] = { ...contactStore[u.id], ...u };
      } else {
        contactStore[u.id] = u;
      }
    }
  });

  // ─── Group metadata cache ───
  sock.ev.on("groups.upsert", (groups) => {
    for (const g of groups) {
      groupCache[g.id] = g;
    }
  });

  sock.ev.on("groups.update", (updates) => {
    for (const u of updates) {
      if (groupCache[u.id]) {
        groupCache[u.id] = { ...groupCache[u.id], ...u };
      }
    }
  });
}

startSocket();

// ─── Helper ───
function ensureReady(req, res) {
  if (!clientReady || !sock) {
    res.status(503).json({ error: "Client not ready" });
    return false;
  }
  return true;
}

// ─── Routes ───

app.get("/status", (req, res) => {
  res.json({
    connected: clientReady,
    user: clientInfo ? { name: clientInfo.pushname, phone: clientInfo.wid } : null,
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

// ─── CONTACTS: returns individual contacts from the Baileys store ───
app.get("/contacts", async (req, res) => {
  if (!ensureReady(req, res)) return;
  try {
    const contacts = Object.values(contactStore)
      .filter((c) => {
        // Only individual contacts (not groups, not status broadcast)
        const id = c.id || "";
        return id.endsWith("@s.whatsapp.net") && !id.startsWith("status");
      })
      .map((c) => ({
        wa_id: c.id,
        name: c.name || c.notify || c.verifiedName || null,
        phone: (c.id || "").replace("@s.whatsapp.net", ""),
        is_business: !!c.verifiedName,
        profile_pic_url: null,
      }));

    console.log(`Returning ${contacts.length} contacts`);
    res.json(contacts);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GROUPS ───
app.get("/groups", async (req, res) => {
  if (!ensureReady(req, res)) return;
  try {
    // Fetch all groups the user participates in
    const groups = await sock.groupFetchAllParticipating();
    const mapped = Object.values(groups).map((g) => ({
      wa_id: g.id,
      name: g.subject || "Unknown Group",
      description: g.desc || "",
      member_count: g.participants?.length || 0,
      members: (g.participants || []).map((p) => ({
        id: p.id,
        isAdmin: p.admin === "admin" || p.admin === "superadmin",
      })),
      admins: (g.participants || [])
        .filter((p) => p.admin === "admin" || p.admin === "superadmin")
        .map((p) => p.id),
      profile_pic_url: null,
    }));
    res.json(mapped);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── CHATS: returns recent conversations ───
app.get("/chats", async (req, res) => {
  if (!ensureReady(req, res)) return;
  try {
    // Baileys doesn't have a built-in chat list like whatsapp-web.js.
    // We build it from contacts + groups that have been seen.
    const chats = [];

    // Add groups
    try {
      const groups = await sock.groupFetchAllParticipating();
      for (const g of Object.values(groups)) {
        chats.push({
          wa_id: g.id,
          name: g.subject || "Unknown Group",
          is_group: true,
          unread_count: 0,
          last_message: null,
          timestamp: g.subjectTime || 0,
        });
      }
    } catch (e) {
      console.warn("Failed to fetch groups for chats:", e.message);
    }

    // Add individual contacts from store
    for (const c of Object.values(contactStore)) {
      const id = c.id || "";
      if (!id.endsWith("@s.whatsapp.net") || id.startsWith("status")) continue;
      chats.push({
        wa_id: id,
        name: c.name || c.notify || c.verifiedName || id.replace("@s.whatsapp.net", ""),
        is_group: false,
        unread_count: 0,
        last_message: null,
        timestamp: 0,
      });
    }

    res.json(chats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── MESSAGES ───
app.get("/messages/:chatId", async (req, res) => {
  if (!ensureReady(req, res)) return;
  // Baileys does not store message history by default.
  // Return empty — the dashboard uses its own message_log DB.
  res.json([]);
});

// ─── SEND MESSAGE ───
app.post("/send", async (req, res) => {
  if (!ensureReady(req, res)) return;
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

// ─── SEND STATUS ───
app.post("/send-status", async (req, res) => {
  if (!ensureReady(req, res)) return;
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

// ─── LOGOUT ───
app.post("/logout", async (req, res) => {
  if (!ensureReady(req, res)) return;
  try {
    await sock.logout();
    clientReady = false;
    clientInfo = null;
    contactStore = {};
    groupCache = {};
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`WhatsApp Baileys server running on port ${PORT}`);
});
