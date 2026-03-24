const express = require("express");
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require("@whiskeysockets/baileys");
const pino = require("pino");
const qrcode = require("qrcode");
const fs = require("fs");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8080;
const API_KEY = process.env.API_KEY || "";
const WEBHOOK_URL = process.env.WEBHOOK_URL || "";
const SESSION_NAME = process.env.SESSION_NAME || "default";
const AUTH_DIR = "./auth_state";

let sock = null;
let qrString = null;
let isConnected = false;
let qrPending = false;
let userInfo = null;
let startTime = Date.now();
let contactStore = {};
let chatStore = {};
let messageStore = {};

// API key middleware
if (API_KEY) {
  app.use((req, res, next) => {
    if (req.path === "/health") return next();
    const key = req.headers["x-api-key"] || req.query.apiKey;
    if (key !== API_KEY) return res.status(401).json({ error: "Unauthorized" });
    next();
  });
}

// ── Baileys connection ──
async function startSock() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: "warn" }),
    printQRInTerminal: true,
    browser: [SESSION_NAME, "Chrome", "20.0.0"],
    generateHighQualityLinkPreview: false,
    syncFullHistory: false,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      qrString = qr;
      qrPending = true;
      isConnected = false;
      console.log("[WA] QR code received");
    }
    if (connection === "open") {
      isConnected = true;
      qrPending = false;
      qrString = null;
      userInfo = {
        phone: sock.user?.id?.split(":")[0] || sock.user?.id?.split("@")[0] || null,
        name: sock.user?.name || null,
      };
      console.log("[WA] Connected as", userInfo.phone);
    }
    if (connection === "close") {
      isConnected = false;
      const code = lastDisconnect?.error?.output?.statusCode;
      console.log("[WA] Disconnected, code:", code);
      if (code !== DisconnectReason.loggedOut) {
        console.log("[WA] Reconnecting...");
        setTimeout(startSock, 3000);
      } else {
        console.log("[WA] Logged out — clearing session");
        if (fs.existsSync(AUTH_DIR)) fs.rmSync(AUTH_DIR, { recursive: true });
      }
    }
  });

  // Store contacts
  sock.ev.on("contacts.upsert", (contacts) => {
    for (const c of contacts) {
      contactStore[c.id] = c;
    }
    console.log(`[WA] Contacts updated: ${Object.keys(contactStore).length} total`);
  });

  sock.ev.on("contacts.update", (updates) => {
    for (const u of updates) {
      if (contactStore[u.id]) {
        Object.assign(contactStore[u.id], u);
      } else {
        contactStore[u.id] = u;
      }
    }
  });

  // Store chats
  sock.ev.on("chats.upsert", (chats) => {
    for (const c of chats) {
      chatStore[c.id] = { ...chatStore[c.id], ...c };
    }
    console.log(`[WA] Chats upserted: ${Object.keys(chatStore).length} total`);
  });

  sock.ev.on("chats.update", (updates) => {
    for (const u of updates) {
      if (chatStore[u.id]) {
        Object.assign(chatStore[u.id], u);
      } else {
        chatStore[u.id] = u;
      }
    }
  });

  // Store messages & forward to webhook
  sock.ev.on("messages.upsert", async ({ messages: msgs, type }) => {
    for (const msg of msgs) {
      const chatId = msg.key.remoteJid;
      if (!chatId) continue;

      // Store in memory
      if (!messageStore[chatId]) messageStore[chatId] = [];
      messageStore[chatId].push(msg);
      // Keep only last 200 per chat
      if (messageStore[chatId].length > 200) {
        messageStore[chatId] = messageStore[chatId].slice(-200);
      }

      // Forward to webhook
      if (WEBHOOK_URL && !msg.key.fromMe && type === "notify") {
        try {
          await fetch(WEBHOOK_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              event: "message",
              sessionName: SESSION_NAME,
              message: msg,
            }),
          });
        } catch (e) {
          console.error("[WA] Webhook error:", e.message);
        }
      }
    }
  });

  // Group events
  sock.ev.on("groups.upsert", (groups) => {
    for (const g of groups) {
      chatStore[g.id] = { ...chatStore[g.id], ...g, is_group: true };
    }
  });

  sock.ev.on("groups.update", (updates) => {
    for (const u of updates) {
      if (chatStore[u.id]) Object.assign(chatStore[u.id], u);
    }
  });
}

// ── REST Endpoints ──

app.get("/status", (req, res) => {
  res.json({
    connected: isConnected,
    qrPending,
    user: userInfo,
  });
});

app.get("/qr", async (req, res) => {
  if (isConnected) return res.json({ connected: true, qr: null });
  if (!qrString) return res.json({ connected: false, qr: null, message: "QR not yet generated" });
  try {
    const dataUrl = await qrcode.toDataURL(qrString);
    res.json({ connected: false, qr: dataUrl });
  } catch (e) {
    res.status(500).json({ error: "QR generation failed" });
  }
});

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    uptime: (Date.now() - startTime) / 1000,
    modules: {
      baileys: "ok",
      express: "ok",
      qrcode: "ok",
    },
    env: {
      PORT: process.env.PORT ? "set" : "unset",
      API_KEY: API_KEY ? "set" : "unset",
      WEBHOOK_URL: WEBHOOK_URL ? "set" : "unset",
    },
    client: {
      ready: isConnected,
      qrPending,
      user: userInfo,
    },
  });
});

app.get("/contacts", (req, res) => {
  const contacts = Object.values(contactStore)
    .filter((c) => c.id?.endsWith("@s.whatsapp.net"))
    .map((c) => ({
      wa_id: c.id,
      name: c.name || c.notify || c.verifiedName || null,
      phone: c.id.replace("@s.whatsapp.net", ""),
      is_business: !!c.verifiedName,
    }));
  res.json({ contacts });
});

app.get("/chats", (req, res) => {
  const chats = Object.entries(chatStore).map(([id, c]) => {
    const isGroup = id.endsWith("@g.us");
    return {
      wa_id: id,
      id: id,
      name: c.name || c.subject || contactStore[id]?.name || contactStore[id]?.notify || id.replace("@s.whatsapp.net", "").replace("@g.us", ""),
      is_group: isGroup,
      unread_count: c.unreadCount || 0,
      last_message_time: c.conversationTimestamp
        ? typeof c.conversationTimestamp === "object"
          ? c.conversationTimestamp.low || 0
          : Number(c.conversationTimestamp)
        : 0,
    };
  });
  // Sort by last message time descending
  chats.sort((a, b) => b.last_message_time - a.last_message_time);
  res.json({ chats });
});

app.get("/groups", async (req, res) => {
  try {
    const groupIds = Object.keys(chatStore).filter((id) => id.endsWith("@g.us"));
    const groups = [];
    for (const gid of groupIds) {
      let meta = chatStore[gid];
      // Try to fetch full metadata if we have a connection
      if (isConnected && sock) {
        try {
          const full = await sock.groupMetadata(gid);
          meta = { ...meta, ...full };
          chatStore[gid] = meta;
        } catch {}
      }
      groups.push({
        wa_id: gid,
        id: gid,
        name: meta.subject || meta.name || gid,
        description: meta.desc || meta.description || null,
        member_count: meta.participants?.length || meta.size || 0,
        participants: (meta.participants || []).map((p) => ({
          id: p.id,
          wa_id: p.id,
          name: contactStore[p.id]?.name || contactStore[p.id]?.notify || null,
          isAdmin: p.admin === "admin" || p.admin === "superadmin",
        })),
      });
    }
    res.json({ groups });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/groups/:groupId/participants", async (req, res) => {
  const { groupId } = req.params;
  try {
    if (!isConnected || !sock) return res.status(503).json({ error: "Client not ready" });
    const meta = await sock.groupMetadata(groupId);
    const participants = (meta.participants || []).map((p) => ({
      wa_id: p.id,
      name: contactStore[p.id]?.name || contactStore[p.id]?.notify || null,
      phone: p.id.replace("@s.whatsapp.net", ""),
      isAdmin: p.admin === "admin" || p.admin === "superadmin",
    }));
    res.json({ participants });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/messages/:chatId", (req, res) => {
  const chatId = decodeURIComponent(req.params.chatId);
  const limit = parseInt(req.query.limit) || 50;
  const before = req.query.before ? parseInt(req.query.before) : null;

  let msgs = messageStore[chatId] || [];

  // Filter by before timestamp
  if (before) {
    msgs = msgs.filter((m) => {
      const ts = m.messageTimestamp
        ? typeof m.messageTimestamp === "object"
          ? m.messageTimestamp.low || 0
          : Number(m.messageTimestamp)
        : 0;
      return ts < before;
    });
  }

  // Take latest N
  const slice = msgs.slice(-limit);

  const formatted = slice.map((m) => {
    const ts = m.messageTimestamp
      ? typeof m.messageTimestamp === "object"
        ? m.messageTimestamp.low || 0
        : Number(m.messageTimestamp)
      : 0;
    const content =
      m.message?.conversation ||
      m.message?.extendedTextMessage?.text ||
      m.message?.imageMessage?.caption ||
      m.message?.videoMessage?.caption ||
      (m.message?.imageMessage ? "[Image]" : "") ||
      (m.message?.videoMessage ? "[Video]" : "") ||
      (m.message?.audioMessage ? "[Audio]" : "") ||
      (m.message?.documentMessage ? "[Document]" : "") ||
      (m.message?.stickerMessage ? "[Sticker]" : "") ||
      (m.message?.contactMessage ? "[Contact]" : "") ||
      (m.message?.locationMessage ? "[Location]" : "") ||
      "";

    return {
      id: m.key.id,
      wa_message_id: m.key.id,
      chat_id: m.key.remoteJid,
      sender: m.key.fromMe ? "me" : m.key.participant || m.key.remoteJid,
      from_me: m.key.fromMe || false,
      content,
      timestamp: ts,
      type: Object.keys(m.message || {})[0] || "unknown",
    };
  });

  res.json({ messages: formatted });
});

app.post("/send", async (req, res) => {
  const { chatId, message } = req.body;
  if (!chatId || !message) return res.status(400).json({ error: "chatId and message required" });
  if (!isConnected || !sock) return res.status(503).json({ error: "Client not ready" });
  try {
    const result = await sock.sendMessage(chatId, { text: message });
    res.json({ success: true, id: result?.key?.id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/send-status", async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: "message required" });
  if (!isConnected || !sock) return res.status(503).json({ error: "Client not ready" });
  try {
    const result = await sock.sendMessage("status@broadcast", { text: message });
    res.json({ success: true, id: result?.key?.id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/logout", async (req, res) => {
  try {
    if (sock) await sock.logout();
    if (fs.existsSync(AUTH_DIR)) fs.rmSync(AUTH_DIR, { recursive: true });
    isConnected = false;
    qrString = null;
    qrPending = false;
    userInfo = null;
    contactStore = {};
    chatStore = {};
    messageStore = {};
    res.json({ success: true });
    setTimeout(startSock, 2000);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/reset", async (req, res) => {
  try {
    if (sock) {
      try { sock.end(); } catch {}
    }
    if (fs.existsSync(AUTH_DIR)) fs.rmSync(AUTH_DIR, { recursive: true });
    isConnected = false;
    qrString = null;
    qrPending = false;
    userInfo = null;
    contactStore = {};
    chatStore = {};
    messageStore = {};
    res.json({ success: true, message: "Session cleared, reconnecting..." });
    setTimeout(startSock, 1000);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Start
app.listen(PORT, () => {
  console.log(`[Server] Listening on port ${PORT}`);
  startSock();
});
