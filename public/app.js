const $ = s => document.querySelector(s);

async function json(url, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set("Cache-Control", "no-cache");
  const r = await fetch(url + (url.includes("?") ? "&" : "?") + "_=" + Date.now(), {
    ...options,
    headers,
    cache: "no-store"
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.message || "Request failed");
  return data;
}

async function loadChannel() {
  try {
    const data = await json("/api/channel");
    for (const id of ["channelTop","channelHero","channelCard"]) {
      const el = $("#" + id);
      if (el && data.channel) el.href = data.channel;
    }
  } catch {}
}

async function health() {
  try {
    const h = await json("/api/health");
    $("#healthStatus").textContent = h.ok ? "ONLINE" : "OFFLINE";
    $("#sessions").textContent = h.sessions ?? "0";
    $("#connected").textContent = h.connected ?? "0";
    $("#uptime").textContent = (h.uptime ?? "0") + "s";
  } catch {
    $("#healthStatus").textContent = "OFFLINE";
  }
}

$("#pairBtn").addEventListener("click", async () => {
  const phone = $("#phone").value.trim().replace(/\D/g, "");
  const out = $("#pairResult");

  if (!/^\d{10,15}$/.test(phone)) {
    out.textContent = "❌ Enter international digits only, e.g. 923001234567";
    return;
  }

  const btn = $("#pairBtn");
  btn.disabled = true;
  out.textContent = "⏳ Starting secure pairing…";

  try {
    const start = await json("/api/pair", {
      method: "POST",
      headers: {"Content-Type":"application/json"},
      body: JSON.stringify({phone})
    });

    if (start.connected) {
      out.textContent = "✅ This number is already connected.";
      return;
    }

    let lastCode = "";
    for (let i = 0; i < 36; i++) {
      await new Promise(r => setTimeout(r, 1000));
      const result = await json("/api/pair/" + encodeURIComponent(phone));

      if (result.connected) {
        out.textContent = "✅ Connected! Your WhatsApp session is saved.";
        break;
      }

      if (result.code) {
        const code = String(result.code);
        if (code !== lastCode) {
          lastCode = code;
          out.textContent = "🔐 Pairing code: " + code +
            " — WhatsApp → Linked devices → Link with phone number instead";
        }
        break;
      }

      if (i === 35) {
        out.textContent = "⌛ Pairing code is taking longer than usual. Click Get Code again to retry.";
      }
    }
  } catch (e) {
    out.textContent = "❌ " + (e.message || "Pairing request failed.");
  } finally {
    btn.disabled = false;
  }
});

$("#year").textContent = new Date().getFullYear();
loadChannel();
health();
setInterval(health, 10000);
