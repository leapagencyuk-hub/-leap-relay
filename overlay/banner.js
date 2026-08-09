/* Leap Reactive Banners — overlay engine.
   Zero dependencies. Receives GiftEvents over a WebSocket and animates tiles /
   the featured-gift flip. Runs a self-contained demo when there's no server,
   so the banner can be previewed and tested without going LIVE. */

(function () {
  "use strict";

  // ---- context -------------------------------------------------------------
  const params = new URLSearchParams(location.search);
  const bannerId =
    params.get("id") || location.pathname.split("/").filter(Boolean).pop() || "demo";
  const isFileProtocol = location.protocol === "file:";
  const demoRequested = params.has("demo") || isFileProtocol;

  const DEFAULT_CONFIG = {
    bannerId: "demo",
    name: "Default Leap Banner",
    brand: "LEAP",
    featuredReaction: "flip",
    accent: "#ffcf3f",
    slots: [
      { id: "s1", giftId: 5655, giftName: "Rose", image: "🌹", points: 1, featured: false },
      { id: "s2", giftId: 7934, giftName: "GG", image: "🎮", points: 10, featured: false },
      { id: "s3", giftId: 6448, giftName: "Coral Reef", image: "🪸", points: 150, featured: false },
      { id: "s4", giftId: 6260, giftName: "Arcade Game", image: "🕹️", points: 500, featured: false },
      { id: "s5", giftId: 5269, giftName: "Galaxy", image: "🌌", points: 1000, featured: true },
      { id: "s6", giftId: 6088, giftName: "Pink Drift", image: "🏎️", points: 3600, featured: true },
    ],
  };

  // ---- element refs --------------------------------------------------------
  const el = {
    banner: document.getElementById("banner"),
    tiles: document.getElementById("tiles"),
    brandName: document.getElementById("brandName"),
    celeAvatar: document.getElementById("celeAvatar"),
    celeUser: document.getElementById("celeUser"),
    celeGift: document.getElementById("celeGift"),
    celeName: document.getElementById("celeName"),
    celePoints: document.getElementById("celePoints"),
    confetti: document.getElementById("confetti"),
    hint: document.getElementById("hint"),
  };

  let config = DEFAULT_CONFIG;
  let slotByGiftId = new Map();
  let slotByName = new Map();
  const nf = new Intl.NumberFormat("en-US");

  // ---- rendering -----------------------------------------------------------
  function renderIcon(image) {
    if (typeof image === "string" && /^(https?:\/\/|data:|\/)/.test(image)) {
      return `<img src="${image}" alt="" onerror="this.replaceWith(document.createTextNode('🎁'))" />`;
    }
    return image || "🎁";
  }

  function applyTheme() {
    const root = document.documentElement;
    const apply = (vars) => {
      if (vars) for (const k in vars) root.style.setProperty(k, vars[k]);
    };
    apply(config.themeVars); // colour template (accent, tiles, celebration)
    apply(config.reactionVars); // reaction glow colour (gold/silver/…)
  }

  function buildBanner() {
    applyTheme();
    if (el.brandName) el.brandName.textContent = config.brand || "LEAP";
    el.tiles.innerHTML = "";
    slotByGiftId = new Map();
    slotByName = new Map();

    config.slots.forEach((slot, i) => {
      slotByGiftId.set(slot.giftId, i);
      if (slot.giftName) slotByName.set(slot.giftName.toLowerCase(), i);

      const tile = document.createElement("div");
      tile.className = "tile" + (slot.featured ? " is-featured" : "");
      tile.dataset.slot = String(i);
      tile.innerHTML = `
        <div class="tile-icon">${renderIcon(slot.image)}</div>
        <div class="tile-points">${nf.format(slot.points)} ${slot.points === 1 ? "PT" : "PTS"}</div>
        <div class="shine"></div>
        <div class="tile-glow"></div>
        <div class="sparkles">${sparkleDots(6)}</div>`;
      el.tiles.appendChild(tile);
    });
  }

  function sparkleDots(n) {
    let out = "";
    for (let i = 0; i < n; i++) {
      const dx = (Math.random() * 60 - 30).toFixed(0) + "px";
      const dy = (Math.random() * -30 - 6).toFixed(0) + "px";
      const left = (10 + Math.random() * 70).toFixed(0) + "%";
      const top = (15 + Math.random() * 60).toFixed(0) + "%";
      const delay = (Math.random() * 250).toFixed(0) + "ms";
      out += `<i style="left:${left};top:${top};--dx:${dx};--dy:${dy};animation-delay:${delay}"></i>`;
    }
    return out;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => (
      { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
    ));
  }

  // ---- normal reaction -----------------------------------------------------
  function reactTile(slotIndex) {
    const tile = el.tiles.children[slotIndex];
    if (!tile) return;
    // reset so a rapid re-send re-triggers the animation cleanly
    tile.classList.remove("react");
    // refresh sparkle scatter for variety
    const sp = tile.querySelector(".sparkles");
    if (sp) sp.innerHTML = sparkleDots(6);
    void tile.offsetWidth; // force reflow
    tile.classList.add("react");
    tile.addEventListener(
      "animationend",
      () => tile.classList.remove("react"),
      { once: true }
    );
  }

  // ---- featured celebration ------------------------------------------------
  let featuredBusy = false;
  const featuredQueue = [];
  const HOLD_MS = 2600;

  function fireFeatured(evt) {
    if (config.featuredReaction === "disabled") {
      // fall back to a strong tile reaction
      const idx = slotByGiftId.get(evt.giftId);
      if (idx != null) reactTile(idx);
      return;
    }
    if (featuredBusy) {
      featuredQueue.push(evt);
      return;
    }
    featuredBusy = true;

    // fill the celebration face
    el.celeUser.textContent = "@" + (evt.senderName || "someone");
    el.celeName.textContent = (evt.giftName || "").toUpperCase();
    el.celePoints.textContent = "+" + nf.format(evt.points) + " POINTS";
    el.celeGift.innerHTML = renderIcon(evt.giftImage);
    el.celeAvatar.innerHTML = evt.senderAvatar
      ? renderIcon(evt.senderAvatar)
      : "<span>🎁</span>";
    el.confetti.innerHTML = confettiPieces(26);

    if (config.featuredReaction === "glow") {
      el.banner.classList.add("glow");
      setTimeout(() => {
        el.banner.classList.remove("glow");
        endFeatured();
      }, 1700);
      return;
    }

    // flip (default) or celebration (skip transition feel — still flips here)
    el.banner.classList.add("flip");
    setTimeout(() => {
      el.banner.classList.remove("flip");
      endFeatured();
    }, HOLD_MS);
  }

  function endFeatured() {
    // wait for the flip-back transition to finish before allowing the next one
    setTimeout(() => {
      featuredBusy = false;
      const next = featuredQueue.shift();
      if (next) fireFeatured(next);
    }, 680);
  }

  const CONFETTI_COLORS = ["#2f7bff", "#9fc4ff", "#ffffff", "#fe2c55", "#044bad"];
  function confettiPieces(n) {
    let out = "";
    for (let i = 0; i < n; i++) {
      const cx = (Math.random() * 900 - 450).toFixed(0) + "px";
      const cy = (Math.random() * 160 - 80).toFixed(0) + "px";
      const cr = (Math.random() * 720 - 360).toFixed(0) + "deg";
      const color = CONFETTI_COLORS[i % CONFETTI_COLORS.length];
      const delay = (Math.random() * 220).toFixed(0) + "ms";
      out += `<i style="background:${color};--cx:${cx};--cy:${cy};--cr:${cr};animation-delay:${delay}"></i>`;
    }
    return out;
  }

  // ---- event entry point ---------------------------------------------------
  function handleGift(evt) {
    let idx = slotByGiftId.get(evt.giftId);
    if (idx == null && evt.giftName) idx = slotByName.get(evt.giftName.toLowerCase());
    // resolve featured either from the event flag or the slot config
    const isFeatured =
      evt.isFeatured || (idx != null && config.slots[idx].featured);
    if (isFeatured) {
      fireFeatured(evt);
    } else if (idx != null) {
      reactTile(idx);
    }
    // gifts not on the banner are simply ignored
  }

  // ---- transport: WebSocket ------------------------------------------------
  let ws = null;
  let reconnectDelay = 500;

  function connect() {
    if (isFileProtocol) return; // no server when opened as a local file
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const url = `${proto}://${location.host}/ws/${bannerId}`;
    try {
      ws = new WebSocket(url);
    } catch {
      return scheduleReconnect();
    }
    ws.onopen = () => {
      reconnectDelay = 500;
    };
    ws.onmessage = (m) => {
      let data;
      try {
        data = JSON.parse(m.data);
      } catch {
        return;
      }
      if (data.type === "hello" || data.type === "config:update") {
        if (data.config) {
          config = data.config;
          buildBanner();
        }
      } else if (data.type === "gift") {
        handleGift(data);
      }
    };
    ws.onclose = scheduleReconnect;
    ws.onerror = () => ws && ws.close();
  }

  function scheduleReconnect() {
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 1.7, 8000);
  }

  // try to pull config over HTTP first (served by the local/cloud server)
  async function loadConfig() {
    if (isFileProtocol) return;
    try {
      const r = await fetch(`/api/banners/${bannerId}/config`, { cache: "no-store" });
      if (r.ok) config = await r.json();
    } catch {
      /* keep default */
    }
  }

  // ---- demo / test harness -------------------------------------------------
  function makeTestEvent(slotIndex) {
    const slot = config.slots[slotIndex];
    const names = ["Gifter1123", "SlowFan", "Perry123", "JamieTTV", "LeapViewer"];
    return {
      type: "gift",
      giftId: slot.giftId,
      giftName: slot.giftName,
      giftImage: slot.image,
      coinValue: 0,
      quantity: 1,
      isFeatured: slot.featured,
      senderId: "demo",
      senderName: names[Math.floor(Math.random() * names.length)],
      senderAvatar: "/sample-avatar.svg",
      points: slot.points,
      timestamp: Date.now(),
    };
  }

  function startDemo() {
    el.hint.hidden = false;
    // keyboard: 1..6 react a tile, F fires the first featured slot
    window.addEventListener("keydown", (e) => {
      if (e.key >= "1" && e.key <= "9") {
        const i = Number(e.key) - 1;
        if (i < config.slots.length) handleGift(makeTestEvent(i));
      } else if (e.key.toLowerCase() === "f") {
        const fi = config.slots.findIndex((s) => s.featured);
        if (fi >= 0) handleGift(makeTestEvent(fi));
      }
    });

    // auto-play loop so the preview is alive on its own
    let n = 0;
    setInterval(() => {
      n++;
      if (n % 5 === 0) {
        const fi = config.slots.findIndex((s) => s.featured);
        if (fi >= 0) return handleGift(makeTestEvent(fi));
      }
      const normals = config.slots
        .map((s, i) => (s.featured ? -1 : i))
        .filter((i) => i >= 0);
      const pick = normals[Math.floor(Math.random() * normals.length)];
      handleGift(makeTestEvent(pick));
    }, 2600);
  }

  // ---- boot ----------------------------------------------------------------
  (async function boot() {
    await loadConfig();
    buildBanner();
    connect();
    if (demoRequested) startDemo();
  })();

  // expose a tiny API for the desktop preview (postMessage / console)
  window.LeapBanner = {
    trigger: handleGift,
    setConfig: (c) => {
      config = c;
      buildBanner();
    },
    testSlot: (i) => handleGift(makeTestEvent(i)),
    testFeatured: () => {
      const fi = config.slots.findIndex((s) => s.featured);
      if (fi >= 0) handleGift(makeTestEvent(fi));
    },
  };
})();
