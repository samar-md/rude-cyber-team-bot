require("dotenv").config();

const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const pino = require("pino");
const { Boom } = require("@hapi/boom");
const {
  default: makeWASocket,
  DisconnectReason,
  Browsers,
  makeCacheableSignalKeyStore,
  downloadContentFromMessage
} = require("@whiskeysockets/baileys");
const { MongoStore } = require("./mongo-store");

const { handle, randomReactions, getText } = require("./commands");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const DATA = path.resolve(process.env.DATA_DIR || path.join(ROOT, "data"));
const LOGO = path.join(ROOT, "public", "logo.jpg");
const SITE_URL = (process.env.SITE_URL || "").replace(/\/$/, "");

fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(path.join(DATA, "downloads"), { recursive: true });

const sockets = new Map();
const starting = new Set();
const reconnectTimers = new Map();
const pairingJobs = new Map();
const pairingCodes = new Map();
const messageCache = new Map();

const cleanPhone = value => String(value || "").replace(/\D/g, "").replace(/^00/, "");
const sleep = ms => new Promise(r => setTimeout(r, ms));

const BAD_WORDS = String(process.env.BAD_WORDS || "")
  .split(",").map(x => x.trim().toLowerCase()).filter(Boolean);

function hasBadWord(value) {
  if (!BAD_WORDS.length) return false;
  const s = String(value || "").toLowerCase();
  return BAD_WORDS.some(w => w && s.includes(w));
}

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function sendAutoSticker(sock, remote, msg) {
  try {
    const raw = msg.message || {};
    const media = raw.imageMessage ? ["image", raw.imageMessage] : raw.videoMessage ? ["video", raw.videoMessage] : null;
    if (!media) return false;
    const stream = await downloadContentFromMessage(media[1], media[0]);
    const buffer = await streamToBuffer(stream);
    const { Sticker, StickerTypes } = require("wa-sticker-formatter");
    const sticker = new Sticker(buffer, {
      pack: process.env.STICKER_NAME || "SAMAR-MD",
      author: process.env.STICKER_AUTHOR || "The-RUDE-x",
      type: StickerTypes.FULL
    });
    await sock.sendMessage(remote, { sticker: await sticker.toBuffer() }, { quoted: msg });
    return true;
  } catch (e) {
    console.log("[STICKER] auto conversion failed:", e.message);
    return false;
  }
}

function defaultUser(phone) {
  return {
    phone,
    connected: false,
    lastSeen: 0,
    settings: {
      autoread: true,
      autoreact: false,
      statusview: true,
      statusDelayMs: 1500,
      fixedreact: null,
      autotyping: false,
      autorecording: false,
      alwaysonline: false,
      antilink: false,
      antiDelete: false,
      antiViewOnce: false,
      antiCall: false,
      antiBadWord: false,
      pmBlocker: false,
      mentionReply: false,
      autoReply: false,
      autoStatusReply: false,
      ownerReact: false,
      welcome: false,
      goodbye: false,
      adminAction: false,
      deleteLinks: false,
      autoSticker: false,
      autoBio: false,
      antiBot: false
    },
    replyText: process.env.AUTO_REPLY_TEXT || "🤖 SAMAR-MD is online.",
    statusReplyText: process.env.AUTO_STATUS_MSG || "👀 SAMAR-MD viewed your status.",
    customCommands: {}
  };
}

let users = {};
let mongoStore;

function normalizeUser(u, phone) {
  const d = defaultUser(phone);
  u = u && typeof u === "object" ? u : d;
  u.phone = phone;
  u.settings = { ...d.settings, ...(u.settings || {}) };
  u.customCommands = u.customCommands && typeof u.customCommands === "object" ? u.customCommands : {};
  if (typeof u.replyText !== "string") u.replyText = d.replyText;
  if (typeof u.statusReplyText !== "string") u.statusReplyText = d.statusReplyText;
  return u;
}

function getUser(phone) {
  const p = cleanPhone(phone);
  if (!users[p]) users[p] = defaultUser(p);
  users[p] = normalizeUser(users[p], p);
  return users[p];
}

let saveTimer = null;
function saveUsers() {
  clearTimeout(saveTimer);
  return new Promise(resolve => {
    saveTimer = setTimeout(async () => {
      try {
        if (mongoStore) await mongoStore.saveUsers(users);
      } catch (e) {
        console.error("[MONGO] user save failed:", e.message);
      } finally {
        resolve();
      }
    }, 50);
  });
}

function clearReconnect(phone) {
  const t = reconnectTimers.get(phone);
  if (t) clearTimeout(t);
  reconnectTimers.delete(phone);
}

function clearPairing(phone) {
  pairingCodes.delete(phone);
  const job = pairingJobs.get(phone);
  if (job?.timer) clearTimeout(job.timer);
  pairingJobs.delete(phone);
}

function statusCodeOf(error) {
  try { return new Boom(error)?.output?.statusCode; } catch { return undefined; }
}

function isLoggedOut(code) {
  return code === DisconnectReason.loggedOut || code === 401;
}

function shouldReconnect(code) {
  return !isLoggedOut(code) &&
    code !== DisconnectReason.badSession &&
    code !== DisconnectReason.multideviceMismatch;
}

async function setProfilePicture(sock) {
  if (!fs.existsSync(LOGO) || !sock.user?.id) return;
  try {
    await sock.updateProfilePicture(sock.user.id, { url: LOGO });
  } catch (e) {
    console.log("[DP] skipped:", e?.message || "unknown");
  }
}

function rememberMessage(phone, msg) {
  if (!msg?.key?.id) return;
  let cache = messageCache.get(phone);
  if (!cache) messageCache.set(phone, cache = new Map());
  cache.set(msg.key.id, msg);
  while (cache.size > 250) cache.delete(cache.keys().next().value);
}

async function startSession(phone, requestPairing = false) {
  phone = cleanPhone(phone);
  if (!/^\d{10,15}$/.test(phone)) throw new Error("Invalid phone number");
  if (sockets.has(phone)) return sockets.get(phone);
  if (starting.has(phone)) return null;

  clearReconnect(phone);
  starting.add(phone);
  try {
    const user = getUser(phone);
    const auth = mongoStore.authState(phone);
    const creds = await auth.init();
    auth.state.creds = creds;

    const sock = makeWASocket({
      auth: {
        creds: auth.state.creds,
        keys: makeCacheableSignalKeyStore(auth.state.keys, pino({ level: "silent" }))
      },
      logger: pino({ level: process.env.LOG_LEVEL || "silent" }),
      browser: Browsers.ubuntu("Chrome"),
      markOnlineOnConnect: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
      connectTimeoutMs: 60_000,
      keepAliveIntervalMs: 20_000,
      defaultQueryTimeoutMs: 60_000,
      getMessage: async key => {
        return messageCache.get(phone)?.get(key?.id)?.message;
      }
    });

    sockets.set(phone, sock);
    sock.ev.on("creds.update", auth.saveCreds);

    sock.ev.on("connection.update", async update => {
      const { connection, lastDisconnect } = update;

      if (connection === "open") {
        user.connected = true;
        user.lastSeen = Date.now();
        clearPairing(phone);
        await saveUsers();
        console.log(`[${phone}] CONNECTED`);
        await setProfilePicture(sock);
        if (user.settings.alwaysonline) {
          try { await sock.sendPresenceUpdate("available"); } catch {}
        }
        return;
      }

      if (connection === "close") {
        const code = statusCodeOf(lastDisconnect?.error);
        user.connected = false;
        user.lastSeen = Date.now();
        sockets.delete(phone);
        await saveUsers();

        console.log(`[${phone}] CLOSED status=${code || "unknown"}`);

        if (isLoggedOut(code)) {
          clearPairing(phone);
          try { await mongoStore.clearAuth(phone); } catch (e) {
            console.error(`[${phone}] Mongo auth cleanup failed:`, e.message);
          }
          user.connected = false;
          await saveUsers();
          console.log(`[${phone}] logged out; MongoDB auth cleared. Pair again to create a fresh session.`);
          return;
        }

        if (shouldReconnect(code)) {
          clearReconnect(phone);
          const delay = code === 515 ? 1000 : Math.min(30000, 3000 + Math.floor(Math.random() * 4000));
          reconnectTimers.set(phone, setTimeout(() => {
            startSession(phone).catch(e => console.error(`[${phone}] reconnect:`, e.message));
          }, delay));
        }
      }
    });

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      for (const msg of messages || []) {
        try {
          if (!msg?.message) continue;
          rememberMessage(phone, msg);
          const remote = msg.key?.remoteJid;
          if (!remote) continue;

          if (remote === "status@broadcast") {
            await handleStatus(sock, phone, user, msg);
            continue;
          }

          if (type === "notify" && !msg.key?.fromMe && user.settings.autoread) {
            try { await sock.readMessages([msg.key]); } catch {}
          }

          if (user.settings.autoreact && !msg.key?.fromMe && !isStatus(remote)) {
            await safeReact(sock, msg, user, false);
          }

          if (user.settings.autotyping && !msg.key?.fromMe) {
            try {
              await sock.sendPresenceUpdate("composing", remote);
              setTimeout(() => sock.sendPresenceUpdate("paused", remote).catch(() => {}), 1600);
            } catch {}
          }

          if (user.settings.autorecording && !msg.key?.fromMe) {
            try {
              await sock.sendPresenceUpdate("recording", remote);
              setTimeout(() => sock.sendPresenceUpdate("paused", remote).catch(() => {}), 2200);
            } catch {}
          }

          if (user.settings.antiViewOnce && !msg.key?.fromMe) {
            const rawMessage = msg.message || {};
            const isViewOnce = Boolean(
              rawMessage.viewOnceMessage ||
              rawMessage.viewOnceMessageV2 ||
              rawMessage.ephemeralMessage?.message?.viewOnceMessage ||
              rawMessage.ephemeralMessage?.message?.viewOnceMessageV2
            );
            if (isViewOnce) {
              try { await sock.sendMessage(remote, { delete: msg.key }); } catch {}
              continue;
            }
          }

          const bodyText = String(getText(msg) || "");
          if (user.settings.antiBadWord && hasBadWord(bodyText) && !msg.key?.fromMe) {
            try { await sock.sendMessage(remote, { delete: msg.key }); } catch {}
            continue;
          }

          if (user.settings.ownerReact && !msg.key?.fromMe) {
            const owners = String(process.env.OWNER_NUMBERS || "").split(",").map(cleanPhone).filter(Boolean);
            if (owners.includes(cleanPhone(msg.key?.participant || remote))) {
              await safeReact(sock, msg, user, false);
            }
          }

          if (user.settings.antilink && remote.endsWith("@g.us") && !msg.key?.fromMe) {
            const body = String(getText(msg) || "");
            if (/https?:\/\/|www\.|chat\.whatsapp\.com\//i.test(body)) {
              if (user.settings.deleteLinks) {
                try { await sock.sendMessage(remote, { delete: msg.key }); } catch {}
              }
              continue;
            }
          }

          if (user.settings.pmBlocker && remote.endsWith("@s.whatsapp.net") && !msg.key?.fromMe) {
            const ownerNumbers = String(process.env.OWNER_NUMBERS || "").split(",").map(cleanPhone).filter(Boolean);
            const sender = cleanPhone(msg.key?.participant || remote);
            if (!ownerNumbers.includes(sender)) continue;
          }

          if (user.settings.autoReply && !msg.key?.fromMe) {
            try { await sock.sendMessage(remote, { text: user.replyText }, { quoted: msg }); } catch {}
          }

          if (user.settings.autoSticker && !msg.key?.fromMe) {
            await sendAutoSticker(sock, remote, msg);
          }

          await handle({
            sock,
            msg,
            user,
            save: saveUsers,
            groupMeta: jid => sock.groupMetadata(jid)
          });
        } catch (e) {
          console.error(`[${phone}] message error:`, e?.stack || e?.message || e);
        }
      }
    });

    sock.ev.on("messages.delete", async event => {
      if (!user.settings.antiDelete) return;
      try {
        const ids = event?.keys || [];
        const cache = messageCache.get(phone);
        for (const key of ids) {
          const old = cache?.get(key.id);
          if (!old?.message) continue;
          const remote = key.remoteJid;
          const text = getText(old);
          if (text) {
            await sock.sendMessage(remote, { text: `🗑️ *Deleted message recovered:*\n${text}` });
          }
        }
      } catch (e) {
        console.log(`[${phone}] anti-delete:`, e.message);
      }
    });

    sock.ev.on("call", async calls => {
      if (!user.settings.antiCall) return;
      for (const call of calls || []) {
        if (!call?.id || !call?.from) continue;
        try { await sock.rejectCall(call.id, call.from); } catch {}
      }
    });

    sock.ev.on("group-participants.update", async update => {
      try {
        const group = update.id;
        const people = update.participants || [];
        if (!group || !people.length) return;
        if (update.action === "add" && user.settings.welcome) {
          await sock.sendMessage(group, {
            text: `👋 Welcome ${people.map(x => "@" + x.split("@")[0]).join(", ")} to the group!\n🤖 SAMAR-MD`,
            mentions: people
          });
        }
        if (update.action === "remove" && user.settings.goodbye) {
          await sock.sendMessage(group, {
            text: `👋 Goodbye ${people.map(x => "@" + x.split("@")[0]).join(", ")}!\n🤖 SAMAR-MD`,
            mentions: people
          });
        }

        if (user.settings.adminAction && (update.action === "promote" || update.action === "demote")) {
          const label = update.action === "promote" ? "promoted to admin" : "removed from admin";
          await sock.sendMessage(group, {
            text: `🛡️ Admin action: ${people.map(x => "@" + x.split("@")[0]).join(", ")} ${label}.`,
            mentions: people
          });
        }
      } catch (e) {
        console.log(`[${phone}] group event:`, e.message);
      }
    });

    if (requestPairing && !auth.state.creds.registered) {
      schedulePairingCode(phone, sock);
    }

    return sock;
  } finally {
    starting.delete(phone);
  }
}

function isStatus(jid) {
  return jid === "status@broadcast";
}

const reactBuckets = new Map();
function reactionAllowed(phone) {
  const now = Date.now();
  let a = reactBuckets.get(phone) || [];
  a = a.filter(t => now - t < 60000);
  const max = Number(process.env.MAX_REACTIONS_PER_MINUTE || 18);
  if (a.length >= max) {
    reactBuckets.set(phone, a);
    return false;
  }
  a.push(now);
  reactBuckets.set(phone, a);
  return true;
}

async function safeReact(sock, msg, user, status) {
  if (!reactionAllowed(cleanPhone(sock.user?.id))) return;
  const emoji = user.settings.fixedreact || randomReactions[Math.floor(Math.random() * randomReactions.length)];
  try {
    if (status) {
      const targets = [...new Set([msg.key?.participantAlt, msg.key?.participant].filter(Boolean))];
      for (const target of targets) {
        try {
          await sock.sendMessage("status@broadcast", {
            react: { text: emoji, key: {
              remoteJid: "status@broadcast",
              id: msg.key.id,
              participant: msg.key.participant,
              participantAlt: msg.key.participantAlt,
              fromMe: false
            }}
          }, { statusJidList: [target] });
          return;
        } catch {}
      }
      return;
    }
    await sock.sendMessage(msg.key.remoteJid, { react: { text: emoji, key: msg.key } });
  } catch {}
}

async function handleStatus(sock, phone, user, msg) {
  if (msg.key?.fromMe) return;
  const participant = msg.key?.participantAlt || msg.key?.participant;
  if (!participant) return;

  const delay = Math.max(0, Math.min(60000, Number(user.settings.statusDelayMs) || 0));
  if (delay) await sleep(delay);

  if (user.settings.statusview) {
    try { await sock.readMessages([msg.key]); } catch {}
  }

  if (user.settings.autoreact) await safeReact(sock, msg, user, true);

  if (user.settings.autoStatusReply) {
    try {
      await sock.sendMessage("status@broadcast", { text: user.statusReplyText }, { statusJidList: [participant] });
    } catch {}
  }
}

function schedulePairingCode(phone, sock) {
  if (pairingJobs.has(phone)) return;
  const attempts = { n: 0 };
  const run = async () => {
    if (!sockets.has(phone) || sock !== sockets.get(phone) || sock.authState?.creds?.registered) {
      pairingJobs.delete(phone); return;
    }
    attempts.n++;
    try {
      const code = await sock.requestPairingCode(phone);
      if (code) {
        pairingCodes.set(phone, String(code));
        console.log(`[${phone}] PAIRING CODE: ${code}`);
        pairingJobs.delete(phone);
        return;
      }
    } catch (e) {
      console.log(`[${phone}] pairing attempt ${attempts.n}: ${e.message}`);
    }
    if (attempts.n < 5) {
      const timer = setTimeout(run, 2500 + attempts.n * 500);
      pairingJobs.set(phone, { timer });
    } else {
      pairingJobs.delete(phone);
    }
  };
  const timer = setTimeout(run, 3500);
  pairingJobs.set(phone, { timer });
}

app.disable("x-powered-by");
app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use((req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});
app.use(express.static(path.join(ROOT, "public"), { etag: false, maxAge: 0 }));

app.get("/api/health", (req, res) => {
  const sessionList = Object.keys(users);
  res.json({
    ok: true,
    bot: process.env.BOT_NAME || "SAMAR-MD",
    team: process.env.TEAM_NAME || "The-RUDE-x Cyber Team",
    sessions: sessionList.length,
    connected: sessionList.filter(x => users[x].connected).length,
    pairing: pairingCodes.size,
    storage: "mongodb",
    uptime: Math.floor(process.uptime())
  });
});

app.post("/api/pair", async (req, res) => {
  const phone = cleanPhone(req.body?.phone);
  if (!/^\d{10,15}$/.test(phone)) {
    return res.status(400).json({ ok: false, message: "Use international digits only, e.g. 923001234567" });
  }
  try {
    const user = getUser(phone);
    if (user.connected && sockets.has(phone)) {
      return res.json({ ok: true, connected: true, phone });
    }
    clearPairing(phone);
    await startSession(phone, true);
    return res.json({ ok: true, pending: true, phone, requestId: crypto.randomUUID() });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e?.message || "Pairing failed" });
  }
});

app.get("/api/pair/:phone", (req, res) => {
  const phone = cleanPhone(req.params.phone);
  if (users[phone]?.connected && sockets.has(phone)) {
    return res.json({ ok: true, connected: true, phone, cacheBust: Date.now() });
  }
  const code = pairingCodes.get(phone);
  if (code) {
    return res.json({
      ok: true,
      pending: false,
      code: String(code).match(/.{1,4}/g)?.join("-") || String(code),
      generatedAt: Date.now()
    });
  }
  return res.json({ ok: true, pending: true, connected: false, generatedAt: Date.now() });
});

app.get("/api/user/:phone", (req, res) => {
  const phone = cleanPhone(req.params.phone);
  if (!users[phone]) return res.status(404).json({ ok: false, message: "Session not found" });
  const user = getUser(phone);
  res.json({
    ok: true,
    phone,
    connected: Boolean(user.connected && sockets.has(phone)),
    settings: user.settings,
    customCommands: Object.keys(user.customCommands)
  });
});

app.patch("/api/user/:phone/settings", async (req, res) => {
  const phone = cleanPhone(req.params.phone);
  const user = getUser(phone);
  const allowed = Object.keys(user.settings);
  for (const key of allowed) {
    if (typeof req.body?.[key] === "boolean") user.settings[key] = req.body[key];
  }
  if (Number.isFinite(Number(req.body?.statusDelayMs))) {
    user.settings.statusDelayMs = Math.max(0, Math.min(60000, Number(req.body.statusDelayMs)));
  }
  if (typeof req.body?.fixedreact === "string") user.settings.fixedreact = req.body.fixedreact || null;
  if (typeof req.body?.replyText === "string") user.replyText = req.body.replyText.slice(0, 1000);
  if (typeof req.body?.statusReplyText === "string") user.statusReplyText = req.body.statusReplyText.slice(0, 1000);
  await saveUsers();
  res.json({ ok: true, settings: user.settings });
});

app.get("/api/channel", (req, res) => {
  res.json({ channel: process.env.CHANNEL_LINK || "" });
});

app.get("/robots.txt", (req, res) => {
  const base = SITE_URL || `${req.protocol}://${req.get("host")}`;
  res.type("text/plain").send(`User-agent: *\nAllow: /\nSitemap: ${base}/sitemap.xml\n`);
});

app.get("/sitemap.xml", (req, res) => {
  const base = SITE_URL || `${req.protocol}://${req.get("host")}`;
  res.type("application/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${base}/</loc><changefreq>weekly</changefreq><priority>1.0</priority></url></urlset>`);
});

app.get("/manifest.webmanifest", (req, res) => {
  res.json({
    name: "SAMAR-MD - The-RUDE-x Cyber Team",
    short_name: "SAMAR-MD",
    start_url: "/",
    display: "standalone",
    theme_color: "#05070b",
    background_color: "#05070b",
    icons: [{ src: "/logo.jpg", sizes: "512x512", type: "image/jpeg" }]
  });
});

app.get("*", (req, res) => res.sendFile(path.join(ROOT, "public", "index.html")));

let server;

async function bootstrap() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI is missing. MongoDB is required for SAMAR-MD.");

  mongoStore = new MongoStore(
    uri,
    process.env.MONGODB_DB || "samar_md",
    process.env.MONGODB_AUTH_COLLECTION || "baileys_auth",
    process.env.MONGODB_USER_COLLECTION || "samar_users"
  );
  await mongoStore.connect();
  users = await mongoStore.loadUsers();
  for (const [phone, user] of Object.entries(users)) {
    users[phone] = normalizeUser(user, phone);
    users[phone].connected = false;
  }

  server = app.listen(PORT, () => {
    console.log(`SAMAR-MD REMASTERED dashboard on port ${PORT}`);
    console.log(`[MONGO] connected; users=${Object.keys(users).length}; auth=MongoDB`);
    for (const phone of Object.keys(users)) {
      startSession(phone).catch(e => console.error(`[${phone}] restore:`, e.message));
    }
  });
}

bootstrap().catch(error => {
  console.error("[BOOT] MongoDB/startup failed:", error?.stack || error);
  process.exit(1);
});

setInterval(() => {
  for (const [phone, sock] of sockets) {
    const user = users[phone];
    if (!user?.settings?.alwaysonline || !user.connected) continue;
    sock.sendPresenceUpdate("available").catch(() => {});
  }
}, 45_000);

setInterval(() => {
  for (const [phone, sock] of sockets) {
    const user = users[phone];
    if (!user?.settings?.autoBio || !user.connected) continue;
    sock.updateProfileStatus(`SAMAR-MD • ${Math.floor(process.uptime() / 60)}m uptime`).catch(() => {});
  }
}, 10 * 60_000);

process.on("unhandledRejection", error => {
  console.error("[PROCESS] unhandled rejection:", error?.stack || error);
});
process.on("uncaughtException", error => {
  console.error("[PROCESS] uncaught exception:", error?.stack || error);
});

async function shutdown() {
  try { if (server) await new Promise(resolve => server.close(resolve)); } catch {}
  try { if (mongoStore) await mongoStore.close(); } catch {}
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
