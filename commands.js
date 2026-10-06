const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const {
  downloadContentFromMessage
} = require("@whiskeysockets/baileys");

const PREFIX = process.env.PREFIX || ".";
const OWN = String(process.env.OWNER_NUMBERS || "")
  .split(",").map(x => x.trim()).filter(Boolean);

const num = j => String(j || "").split("@")[0].split(":")[0];
const owner = j => OWN.includes(num(j));

function unwrap(m) {
  let x = m?.message || {};
  for (const k of ["ephemeralMessage", "viewOnceMessage", "viewOnceMessageV2", "documentWithCaptionMessage"]) {
    if (x[k]) x = x[k].message;
  }
  return x || {};
}

function text(m) {
  const x = unwrap(m);
  return x.conversation ||
    x.extendedTextMessage?.text ||
    x.imageMessage?.caption ||
    x.videoMessage?.caption ||
    x.documentMessage?.caption ||
    "";
}

function contextInfo(m) {
  const x = unwrap(m);
  return x.extendedTextMessage?.contextInfo ||
    x.imageMessage?.contextInfo ||
    x.videoMessage?.contextInfo ||
    {};
}

function parse(s) {
  if (!s || !s.startsWith(PREFIX)) return null;
  const p = s.slice(PREFIX.length).trim().split(/\s+/);
  return { command: (p.shift() || "").toLowerCase(), args: p };
}

const randomReactions = [
  "❤️","🩷","🧡","💛","💚","🩵","💙","💜","🤎","🖤","🩶","🤍",
  "💖","💗","💓","💞","💕","💘","💝","💟","❣️","❤️‍🔥","❤️‍🩹",
  "😍","🥰","😘","😗","😙","😚","😻","🤩","😊","☺️","😇","🥹",
  "😂","🤣","😄","😁","😆","😅","🙂","🙃","😉","😌","🤗","🤭",
  "😎","🥳","🤠","🫶","🫰","🤟","🤞","✌️","👌","👍","👏","🙌",
  "🙏","💪","🤝","👐","🤲","🤜","🤛","✍️","🤌","✨","🌟","⭐",
  "💫","🔥","💯","🎉","🎊","🎁","🏆","🥇","🚀","⚡","🌈","☀️",
  "🌸","🌹","🌺","🌻","🌷","🌼","💐","🍀","🌿","🌱","🪷","🕊️",
  "🦋","💎","👑","🎯","🎵","🎶","🫂","🙋","💃","🕺","🎀","🪄"
];
const reacts = randomReactions;

const menu = () => `╭━━〔 *SAMAR-MD REMASTERED* 〕━━╮
┃ 👑 *The-RUDE-x Cyber Team*
╰━━━━━━━━━━━━━━━━━━━━╯
⚡ *GENERAL*
• ${PREFIX}menu ${PREFIX}help ${PREFIX}ping ${PREFIX}ping2
• ${PREFIX}alive ${PREFIX}uptime ${PREFIX}id ${PREFIX}owner
• ${PREFIX}info ${PREFIX}settings
🛡️ *AUTO / STATUS*
• ${PREFIX}autoread on/off
• ${PREFIX}autoreact on/off
• ${PREFIX}statusview on/off
• ${PREFIX}statuslike on/off
• ${PREFIX}autotyping on/off
• ${PREFIX}autorecording on/off
• ${PREFIX}alwaysonline on/off
• ${PREFIX}autobio on/off
• ${PREFIX}setdelay 0-60
• ${PREFIX}setreact random/emoji
• ${PREFIX}autoreply on/off
• ${PREFIX}setreply text
• ${PREFIX}autostatusreply on/off
• ${PREFIX}setstatusmsg text
• ${PREFIX}mentionreply on/off
• ${PREFIX}emojis ${PREFIX}reacts
👥 *GROUP*
• ${PREFIX}tagall ${PREFIX}hidetag ${PREFIX}admins ${PREFIX}ginfo
• ${PREFIX}antilink on/off
• ${PREFIX}deletelinks on/off
• ${PREFIX}welcome on/off ${PREFIX}goodbye on/off
🛡️ *SECURITY*
• ${PREFIX}antidelete on/off ${PREFIX}antiviewonce on/off
• ${PREFIX}anticall on/off ${PREFIX}antibadword on/off
• ${PREFIX}pblocker on/off ${PREFIX}antibot on/off
• ${PREFIX}adminaction on/off
🧰 *TOOLS*
• ${PREFIX}addcmd name reply
• ${PREFIX}delcmd name ${PREFIX}cmds
• ${PREFIX}tiny ${PREFIX}circle ${PREFIX}gothic ${PREFIX}reverse
• ${PREFIX}video URL ${PREFIX}yt URL ${PREFIX}audio URL
💖 *REACTIONS*
• ${reacts.length}+ positive/love/happy/support emojis`;

function toggle(k, v, settings) {
  if (!["on", "off"].includes(v)) return `Use: ${PREFIX}${k} on/off`;
  settings[k] = v === "on";
  return `✅ ${k}: ${settings[k] ? "ON" : "OFF"}`;
}

function tiny(s) {
  const a = "ᴀʙᴄᴅᴇꜰɢʜɪᴊᴋʟᴍɴᴏᴘǫʀꜱᴛᴜᴠᴡxʏᴢ";
  return [...s].map(c => a[c.toLowerCase().charCodeAt(0) - 97] || c).join("");
}
function circle(s) {
  const a = "ⓐⓑⓒⓓⓔⓕⓖⓗⓘⓙⓚⓛⓜⓝⓞⓟⓠⓡⓢⓣⓤⓥⓦⓧⓨⓩ";
  return [...s].map(c => a[c.toLowerCase().charCodeAt(0) - 97] || c).join("");
}
function gothic(s) {
  const a = "𝔞𝔟𝔠𝔡𝔢𝔣𝔤𝔥𝔦𝔧𝔨𝔩𝔪𝔫𝔬𝔭𝔮𝔯𝔰𝔱𝔲𝔳𝔴𝔵𝔶𝔷";
  return [...s].map(c => a[c.toLowerCase().charCodeAt(0) - 97] || c).join("");
}

function ytdlp(url, mode, out) {
  return new Promise((resolve, reject) => {
    let bin;
    try { bin = require.resolve("yt-dlp-exec/bin/yt-dlp"); }
    catch { return reject(new Error("yt-dlp-exec is not installed")); }
    let ffmpegPath = "";
    try { ffmpegPath = require("@ffmpeg-installer/ffmpeg").path; } catch {}
    const ff = ffmpegPath ? ["--ffmpeg-location", ffmpegPath] : [];
    const args = mode === "audio"
      ? ["-x", "--audio-format", "mp3", "--no-playlist", ...ff, "-o", out, url]
      : ["-f", "mp4/best", "--merge-output-format", "mp4", "--no-playlist", ...ff, "-o", out, url];
    execFile(bin, args, { timeout: 120000, maxBuffer: 2 * 1024 * 1024 }, e => e ? reject(e) : resolve(out));
  });
}

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const c of stream) chunks.push(c);
  return Buffer.concat(chunks);
}

async function getQuotedMedia(msg) {
  const ctx = contextInfo(msg);
  const quoted = ctx.quotedMessage;
  if (!quoted) return null;
  if (quoted.imageMessage) {
    return { type: "image", message: quoted.imageMessage };
  }
  if (quoted.videoMessage) {
    return { type: "video", message: quoted.videoMessage };
  }
  return null;
}

async function handle({ sock, msg, user, save, groupMeta }) {
  const from = msg.key.remoteJid;
  const sender = msg.key.participant || from;
  const raw = text(msg);
  const p = parse(raw);
  if (!p) {
    // Mention reply is intentionally conservative: only reply when explicitly enabled.
    if (user.settings.mentionReply && contextInfo(msg).mentionedJid?.includes(sock.user?.id)) {
      try { await sock.sendMessage(from, { text: user.replyText }, { quoted: msg }); } catch {}
      return true;
    }
    return false;
  }

  const { command, args } = p;
  const send = t => sock.sendMessage(from, { text: t }, { quoted: msg });
  const arg = args.join(" ");

  if (user.customCommands?.[command]) {
    await send(user.customCommands[command]);
    return true;
  }

  if (["menu", "help"].includes(command)) { await send(menu()); return true; }
  if (command === "ping") { await send("🏓 PONG! • SAMAR-MD REMASTERED"); return true; }
  if (command === "ping2") { await send("🏓 PONG 2 • connection active"); return true; }
  if (command === "alive") { await send(`🟢 SAMAR-MD ALIVE\n👑 The-RUDE-x Cyber Team\n⏱️ ${Math.floor(process.uptime())}s`); return true; }
  if (command === "uptime") { await send(`⏱️ ${Math.floor(process.uptime())} seconds`); return true; }
  if (command === "id") { await send(`🆔 Chat: ${from}\n👤 Sender: ${sender}`); return true; }
  if (command === "owner") { await send(`👑 SAMAR-MD OWNER\n${process.env.OWNER_NAME || "The-RUDE-x Cyber Team"}`); return true; }
  if (command === "info") { await send(`🤖 SAMAR-MD REMASTERED\n⚡ ${process.env.TEAM_NAME || "The-RUDE-x Cyber Team"}\n🟢 Multi-session\n📦 Stable session store`); return true; }
  if (command === "settings") { await send("⚙️ " + JSON.stringify(user.settings, null, 2)); return true; }

  if (["emojis", "reacts"].includes(command)) {
    await send(`💖 *SAMAR-MD POSITIVE REACTION PACK* (${reacts.length}+)\n\n${reacts.join(" ")}`);
    return true;
  }
  if (["emoji", "randomreact"].includes(command)) {
    await send(reacts[Math.floor(Math.random() * reacts.length)]);
    return true;
  }

  const toggleMap = {
    autoread: "autoread",
    autoreact: "autoreact",
    statusview: "statusview",
    autotyping: "autotyping",
    autorecording: "autorecording",
    alwaysonline: "alwaysonline",
    autobio: "autoBio",
    antilink: "antilink",
    deletelinks: "deleteLinks",
    welcome: "welcome",
    goodbye: "goodbye",
    antidelete: "antiDelete",
    antiviewonce: "antiViewOnce",
    anticall: "antiCall",
    antibadword: "antiBadWord",
    pblocker: "pmBlocker",
    mentionreply: "mentionReply",
    autoreply: "autoReply",
    autostatusreply: "autoStatusReply",
    ownerreact: "ownerReact",
    adminaction: "adminAction",
    autosticker: "autoSticker",
    antibot: "antiBot"
  };

  if (toggleMap[command]) {
    const key = toggleMap[command];
    const out = toggle(key, args[0]?.toLowerCase(), user.settings);
    await send(out); await save(); return true;
  }
  if (command === "pblocker") {
    const out = toggle("pmBlocker", args[0]?.toLowerCase(), user.settings);
    await send(out); await save(); return true;
  }

  if (command === "statuslike") {
    const v = args[0]?.toLowerCase();
    if (!["on", "off"].includes(v)) { await send(`Use: ${PREFIX}statuslike on/off`); return true; }
    user.settings.statusview = v === "on";
    user.settings.autoreact = v === "on";
    await save();
    await send(`💚 STATUS LIKE ${v.toUpperCase()}\n👀 Seen: ${user.settings.statusview}\n❤️ Reaction: ${user.settings.autoreact}`);
    return true;
  }

  if (command === "setdelay") {
    const n = Number(args[0]);
    if (!Number.isFinite(n)) { await send(`Use: ${PREFIX}setdelay 0-60`); return true; }
    user.settings.statusDelayMs = Math.max(0, Math.min(60, n)) * 1000;
    await save(); await send(`⏱️ Status delay: ${Math.max(0, Math.min(60, n))}s`); return true;
  }

  if (command === "setreact") {
    const value = arg.trim();
    user.settings.fixedreact = (!value || ["random", "off"].includes(value.toLowerCase())) ? null : value;
    await save();
    await send(user.settings.fixedreact ? `📌 Fixed reaction: ${user.settings.fixedreact}` : `🔀 Reaction: RANDOM (${reacts.length}+ emojis)`);
    return true;
  }

  if (command === "setreply") {
    if (!owner(sender)) { await send("❌ Owner only"); return true; }
    if (!arg) { await send(`Use: ${PREFIX}setreply your reply text`); return true; }
    user.replyText = arg.slice(0, 1000);
    await save(); await send("✅ Auto-reply text saved."); return true;
  }

  if (command === "setstatusmsg") {
    if (!owner(sender)) { await send("❌ Owner only"); return true; }
    if (!arg) { await send(`Use: ${PREFIX}setstatusmsg your status reply`); return true; }
    user.statusReplyText = arg.slice(0, 1000);
    await save(); await send("✅ Status reply text saved."); return true;
  }

  if (["tagall", "hidetag"].includes(command)) {
    if (!from.endsWith("@g.us")) { await send("❌ Group only"); return true; }
    const m = await groupMeta(from);
    const ids = m.participants.map(x => x.id);
    const body = command === "tagall" ? `📢 ${ids.map(x => "@" + num(x)).join(" ")}` : (arg || "📢");
    await sock.sendMessage(from, { text: body, mentions: ids }, { quoted: msg });
    return true;
  }

  if (command === "admins") {
    if (!from.endsWith("@g.us")) { await send("❌ Group only"); return true; }
    const m = await groupMeta(from);
    const ids = m.participants.filter(x => x.admin).map(x => x.id);
    await sock.sendMessage(from, { text: "👮 ADMINS\n" + ids.map(x => "@" + num(x)).join("\n"), mentions: ids }, { quoted: msg });
    return true;
  }

  if (command === "ginfo") {
    if (!from.endsWith("@g.us")) { await send("❌ Group only"); return true; }
    const m = await groupMeta(from);
    await send(`👥 ${m.subject}\n👤 Members: ${m.participants.length}\n🆔 ${from}`);
    return true;
  }

  if (command === "tiny") { await send(tiny(arg) || `Use: ${PREFIX}tiny text`); return true; }
  if (command === "circle") { await send(circle(arg) || `Use: ${PREFIX}circle text`); return true; }
  if (command === "gothic") { await send(gothic(arg) || `Use: ${PREFIX}gothic text`); return true; }
  if (command === "reverse") { await send([...arg].reverse().join("") || `Use: ${PREFIX}reverse text`); return true; }

  if (command === "sticker") {
    const media = await getQuotedMedia(msg);
    if (!media) { await send(`Reply to an image/video with ${PREFIX}sticker`); return true; }
    try {
      const stream = await downloadContentFromMessage(media.message, media.type);
      const buffer = await streamToBuffer(stream);
      const { Sticker, StickerTypes } = require("wa-sticker-formatter");
      const sticker = new Sticker(buffer, {
        pack: process.env.STICKER_NAME || "SAMAR-MD",
        author: process.env.STICKER_AUTHOR || "The-RUDE-x",
        type: StickerTypes.FULL
      });
      await sock.sendMessage(from, { sticker: await sticker.toBuffer() }, { quoted: msg });
    } catch (e) {
      await send("❌ Sticker conversion failed. Make sure wa-sticker-formatter is installed.");
    }
    return true;
  }

  if (command === "addcmd") {
    if (!owner(sender)) { await send("❌ Owner only"); return true; }
    const n = (args.shift() || "").toLowerCase().replace(/[^a-z0-9_]/g, "");
    if (!n || !args.length) { await send(`Use: ${PREFIX}addcmd name reply`); return true; }
    user.customCommands[n] = args.join(" ");
    await save(); await send(`✅ ${PREFIX}${n} added`); return true;
  }

  if (command === "delcmd") {
    if (!owner(sender)) { await send("❌ Owner only"); return true; }
    const n = (args[0] || "").toLowerCase();
    if (!n) { await send(`Use: ${PREFIX}delcmd name`); return true; }
    delete user.customCommands[n];
    await save(); await send(`✅ ${PREFIX}${n} deleted`); return true;
  }

  if (command === "cmds") {
    await send("🧰 Custom commands:\n" + (Object.keys(user.customCommands).map(x => PREFIX + x).join("\n") || "None"));
    return true;
  }

  if (["video", "yt", "audio"].includes(command)) {
    if (!/^https?:\/\//i.test(arg)) { await send(`Use: ${PREFIX}${command} <url>`); return true; }
    const dir = path.join(process.cwd(), "data", "downloads");
    fs.mkdirSync(dir, { recursive: true });
    const audio = command === "audio";
    const out = path.join(dir, cryptoSafeName() + "." + (audio ? "mp3" : "mp4"));
    try {
      await send("⏳ Downloading…");
      await ytdlp(arg, audio ? "audio" : "video", out);
      const max = Number(process.env.MAX_MEDIA_MB || 45) * 1048576;
      if (!fs.existsSync(out) || fs.statSync(out).size > max) throw new Error("large");
      if (audio) {
        await sock.sendMessage(from, { audio: fs.readFileSync(out), mimetype: "audio/mpeg" }, { quoted: msg });
      } else {
        await sock.sendMessage(from, { video: fs.readFileSync(out), mimetype: "video/mp4", caption: "🎬 SAMAR-MD" }, { quoted: msg });
      }
    } catch {
      await send("❌ Download failed or source is unavailable/too large.");
    } finally {
      try { fs.unlinkSync(out); } catch {}
    }
    return true;
  }

  return false;
}

function cryptoSafeName() {
  return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
}

module.exports = { handle, text, getText: text, unwrap, randomReactions, reacts, parse };
