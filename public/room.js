// CoWatch — логика страницы комнаты
const { resolveSource, createPlayer } = window.CW_PLAYERS;
const { ClockSync, SyncEngine } = window.CW_SYNC;

const CW_VERSION = () => document.getElementById("ver")?.textContent || "v?";
const roomId = location.pathname.split("/").pop();
const myName = localStorage.getItem("cw:name") || prompt("Ваше имя:")?.slice(0, 24) || "Гость";
localStorage.setItem("cw:name", myName);

const $ = (id) => document.getElementById(id);
const socket = io();
const clock = new ClockSync(socket);
const sync = new SyncEngine(socket, clock);

let player = null;
let currentSourceUrl = null;
let selfId = null;

/* ---------------- Подключение / переподключение ---------------- */
function join() {
  // любая корректная ссылка комнаты работает всегда, даже после рестарта сервера
  socket.emit("room:join", { roomId, name: myName, avatar: localStorage.getItem("cw:avatar") || null, createIfMissing: true }, (res) => {
    if (res?.error) {
      document.body.innerHTML =
        `<main class="landing"><div class="landing-card"><div class="logo">CoWatch</div>
         <p class="tagline">${res.error}</p>
         <a href="/"><button class="btn-primary">На главную</button></a></div></main>`;
      return;
    }
    selfId = res.selfId;
    clock.start(); // непрерывная синхронизация часов
    renderMembers(res.members);
    $("chat-log").innerHTML = ""; // rejoin: снапшот заново, без дублей
    res.messages.forEach(renderMessage);
    if (res.state.source) mountSource(res.state.source);
    sync.state = res.state;
    sendPairSync(); // делимся статистикой и моментами с партнёром
    updateResumeButton();
  });
}
socket.on("connect", join);
socket.on("disconnect", () => setSyncDot("bad", "переподключение…"));

/* ---------------- Источник ---------------- */
$("source-go").addEventListener("click", submitSource);
$("source-input").addEventListener("keydown", (e) => e.key === "Enter" && submitSource());
$("btn-src").addEventListener("click", () => {
  $("source-card").style.display = "";
  $("source-input").focus();
});

function submitSource() {
  const url = $("source-input").value.trim();
  if (!url) return;
  const src = resolveSource(url);
  socket.emit("sync:action", { type: "source", value: { kind: src.kind, url } });
}

socket.on("sync:state", (s) => {
  if (s.source && s.source.url !== currentSourceUrl) mountSource(s.source);
});

function mountSource(source) {
  currentSourceUrl = source.url;
  player?.destroy();
  $("player-host").innerHTML = "";
  $("player-host").style.display = "block";
  $("source-card").style.display = "none";

  const resolved = resolveSource(source.url);
  player = createPlayer($("player-host"), resolved);
  sync.attach(player);
  const srcName = { youtube: "YouTube", rutube: "RuTube", hls: "HLS", direct: "видео" }[resolved.kind] || resolved.kind;
  toast(source.title ? `▶ ${source.title}` : `Источник: ${srcName}`);
  document.title = source.title ? `${source.title} — CoWatch` : "CoWatch — комната";

  const isEmbed = resolved.kind === "youtube" || resolved.kind === "rutube";
  $("controls").style.display = isEmbed ? "none" : ""; // у embed-плееров свой UI

  player.on("ready", () => {
    // догоняем комнату
    if (sync.state) sync.applyState({ ...sync.state, version: sync.state.version + 0.1 });
    updateDuration();
    updatePlayIcon();
    showControls();
  });
  player.on("buffering", (b) => {
    sync.setBuffering(b);
    if (!isEmbed) badge("me-buf", b ? "⏳ Буферизация…" : null);
  });
  player.on("timeupdate", updateTimeline);
  player.on("error", (msg) => { toast(msg, 5000); $("source-card").style.display = ""; });
  player.on("autoplay-blocked", () => { $("tap-to-play").style.display = "flex"; });

  // действия пользователя ВНУТРИ iframe YouTube транслируем в комнату
  player.on("degraded", () =>
    badge("degraded", "⚠️ RuTube не отвечает — возможен ручной режим"));
  player.on("user-play", () => sync.userPlay());
  player.on("user-pause", () => sync.userPause());
  player.on("user-seek", (t) => sync.userSeek(t));
  bindEnded();
  $("ended-overlay").style.display = "none"; // новое видео — старый финал не нужен
  document.body.classList.add("has-video");
  $("float-change").style.display = "";
  pushHistory(source, 0);
}

/* ---------------- Контролы (HTML5/HLS) ---------------- */
$("btn-play").addEventListener("click", togglePlay);

const isTouch = matchMedia("(pointer: coarse)").matches;
let hideTimer = null;
function showControls(ms = 3000) {
  $("controls").classList.add("visible");
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    if (player && !player.isPaused()) $("controls").classList.remove("visible");
  }, ms); // на паузе контролы не прячем
}
$("big-play").addEventListener("click", () => { sync.userPlay(); showControls(); });
$("stage").addEventListener("click", (e) => {
  if (e.target !== $("player-host") && e.target.tagName !== "VIDEO") return;
  if (isTouch) {
    // первый тап — показать контролы, тап при видимых — play/pause
    $("controls").classList.contains("visible") ? togglePlay() : void 0;
    showControls();
  } else {
    togglePlay();
  }
});
function togglePlay() {
  if (!player || player.kind === "youtube") return;
  player.isPaused() ? sync.userPlay() : sync.userPause();
}

$("timeline").addEventListener("click", (e) => {
  if (!player) return;
  const dur = player.getDuration();
  if (!isFinite(dur) || dur <= 0) return; // live-поток / метаданные ещё не загружены
  const r = $("timeline").getBoundingClientRect();
  const frac = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  sync.userSeek(frac * dur);
});

const RATES = [1, 1.25, 1.5, 2, 0.75];
$("btn-rate").addEventListener("click", () => {
  const cur = sync.state?.rate ?? 1;
  const next = RATES[(RATES.indexOf(cur) + 1) % RATES.length] ?? 1;
  sync.userRate(next);
});

$("btn-mute").addEventListener("click", () => player?.setMuted(!player.muted));
$("btn-fs").addEventListener("click", toggleFullscreen);
function toggleFullscreen() {
  if (document.fullscreenElement) return document.exitFullscreen();
  const stage = $("stage");
  if (stage.requestFullscreen) return stage.requestFullscreen();
  // iPhone: Fullscreen API нет, но само <video> умеет нативный полноэкран
  player?.video?.webkitEnterFullscreen?.();
}

/* горячие клавиши */
document.addEventListener("keydown", (e) => {
  if (e.target.tagName === "INPUT") return;
  if (!player) return;
  const t = player.getTime();
  switch (e.key) {
    case " ": e.preventDefault(); togglePlay(); break;
    case "ArrowLeft": sync.userSeek(Math.max(0, t - 5)); break;
    case "ArrowRight": sync.userSeek(t + 5); break;
    case "f": case "F": case "а": case "А": toggleFullscreen(); break;
    case "m": case "M": case "ь": case "Ь": player.setMuted(!player.muted); break;
  }
});

/* таймлайн и время */
function fmt(t) {
  if (!isFinite(t)) return "∞";
  t = Math.max(0, Math.floor(t));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  const mm = h ? String(m).padStart(2, "0") : m;
  return (h ? h + ":" : "") + mm + ":" + String(s).padStart(2, "0");
}
function updateTimeline(t) {
  const d = player?.getDuration() || 0;
  if (d) {
    $("played").style.width = (t / d) * 100 + "%";
    $("buffered").style.width = (player.getBuffered() / d) * 100 + "%";
  }
  $("t-cur").textContent = fmt(t);
  updatePlayIcon();
}
function updateDuration() { $("t-dur").textContent = fmt(player?.getDuration() || 0); }
function updatePlayIcon() {
  const paused = player?.isPaused() ?? true;
  $("ic-play").style.display = paused ? "" : "none";
  $("ic-pause").style.display = paused ? "none" : "";
  $("btn-rate").textContent = (sync.state?.rate ?? 1) + "×";
  $("big-play").style.display =
    paused && player && player.kind !== "youtube" ? "" : "none";
}
setInterval(updatePlayIcon, 500); // пауза может прийти и с сервера

/* ---------------- Индикатор синхронизации ---------------- */
function setSyncDot(q, label) {
  $("sync-dot").dataset.q = q;
  $("sync-label").textContent = label;
}
sync.onDrift = (drift) => {
  if (drift === null) {
    if (socket.connected) setSyncDot("", sync.state?.playing ? "…" : "пауза");
    return;
  }
  const ms = Math.round(Math.abs(drift) * 1000);
  if (ms < 300) setSyncDot("good", `синхронно · ${ms} мс`);
  else if (ms < 1000) setSyncDot("mid", `догоняем · ${ms} мс`);
  else setSyncDot("bad", `рассинхрон · ${(ms / 1000).toFixed(1)} с`);
};

socket.on("sync:peer-buffering", ({ userId, state }) => {
  const m = lastMembers.find((x) => x.id === userId);
  badge("peer-buf", state ? `⏳ У ${m?.name || "партнёра"} буферизация…` : null);
});

/* ---------------- Участники ---------------- */
let lastMembers = [];
function renderMembers(members) {
  lastMembers = members;
  const heart = `<span class="pair-heart">💜</span>`;
  $("members").innerHTML = members
    .map(
      (m) => `<div class="avatar ${m.isOwner ? "owner" : ""}" data-mid="${m.id}"
        title="${esc(m.name)}${m.isOwner ? " · владелец" : ""}${m.id === selfId ? " · тап — сменить аватар" : ""}"
        style="background:hsl(${m.hue} 60% 45%)">${m.avatar ? m.avatar : esc(m.name[0].toUpperCase())}${m.status ? `<span class="st">${m.status}</span>` : ""}</div>`,
    )
    .join(members.length === 2 ? heart : "");
}
$("members").addEventListener("click", (e) => {
  const av = e.target.closest(".avatar");
  if (!av || av.dataset.mid !== selfId) return;
  togglePanel("avatar-picker");
});
socket.on("presence:update", (members) => {
  const prev = new Set(lastMembers.map((m) => m.id));
  const cur = new Set(members.map((m) => m.id));
  members.forEach((m) => { if (!prev.has(m.id) && m.id !== selfId && prev.size) systemMsg(`${m.name} в комнате`); });
  lastMembers.forEach((m) => { if (!cur.has(m.id)) systemMsg(`${m.name} вышел·а`); });
  renderMembers(members);
});

/* ---------------- Чат ---------------- */
const chatText = $("chat-text");
chatText.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && chatText.value.trim()) {
    socket.emit("chat:send", { text: chatText.value });
    chatText.value = "";
    socket.emit("chat:typing", false);
  }
});
let typingTimer = null;
chatText.addEventListener("input", () => {
  socket.emit("chat:typing", true);
  clearTimeout(typingTimer);
  typingTimer = setTimeout(() => socket.emit("chat:typing", false), 2500);
});
socket.on("chat:message", renderMessage);
socket.on("chat:typing", ({ name, state }) => {
  $("typing").textContent = state ? `${name} печатает…` : "";
});

function renderMessage(m) {
  // в полноэкранном режиме чата не видно — показываем сообщение поверх видео
  if (document.fullscreenElement && m.author !== myName) {
    const fs = document.createElement("div");
    fs.className = "fs-msg";
    fs.innerHTML = `<b>${esc(m.author)}</b>${m.type === "photo" ? "📷 фото" : esc(m.text)}`;
    $("stage").appendChild(fs);
    setTimeout(() => fs.remove(), 4200);
  }
  if (m.text) maybeLoveExplosion(m.text);
  const av = m.avatar || lastMembers.find((x) => x.name === m.author)?.avatar;
  const body = m.type === "photo"
    ? (m.data ? `<img class="photo" src="${m.data}" alt="фото" />`
              : `<div class="photo-gone">📷 фото уже недоступно</div>`)
    : `<div class="text">${esc(m.text)}</div>`;
  const el = document.createElement("div");
  el.className = "msg";
  el.innerHTML = `
    <div class="avatar" style="background:hsl(${m.hue} 60% 45%)">${av ? av : esc(m.author[0].toUpperCase())}</div>
    <div class="body">
      <div class="meta"><b>${esc(m.author)}</b>${new Date(m.at).toLocaleTimeString("ru", { hour: "2-digit", minute: "2-digit" })}</div>
      ${body}
    </div>`;
  el.querySelector(".photo")?.addEventListener("click", () => openLightbox(m.data));
  appendToLog(el);
}
function systemMsg(text) {
  const el = document.createElement("div");
  el.className = "msg system";
  el.innerHTML = `<div class="text">${esc(text)}</div>`;
  appendToLog(el);
}
function appendToLog(el) {
  const log = $("chat-log");
  const stick = log.scrollHeight - log.scrollTop - log.clientHeight < 60;
  log.appendChild(el);
  if (stick) log.scrollTop = log.scrollHeight;
}

/* ---------------- Милые функции ---------------- */
document.querySelectorAll("[data-love]").forEach((b) =>
  b.addEventListener("click", () => socket.emit("couple:event", { type: b.dataset.love })),
);
socket.on("couple:event", ({ type, from }) => {
  if (type === "knock") {
    systemMsg(`${from} стучится 👋`);
    if (from !== myName) {
      const w = document.createElement("div");
      w.className = "knock-wave";
      w.innerHTML = "<span>👋</span>";
      $("stage").appendChild(w);
      setTimeout(() => w.remove(), 1500);
      buzz([90, 60, 90, 60, 90]);
    }
    return;
  }
  if (type === "superhug") {
    systemMsg(`${from} → СУПЕРОБНИМАШКА 🤗💥`);
    for (let i = 0; i < 34; i++) {
      setTimeout(() => {
        const h = document.createElement("span");
        h.textContent = ["🤍", "💜", "💗", "✨"][i % 4];
        h.style.left = 3 + Math.random() * 94 + "%";
        h.style.fontSize = 18 + Math.random() * 26 + "px";
        $("hearts").appendChild(h);
        setTimeout(() => h.remove(), 2700);
      }, i * 55);
    }
    buzz([60, 40, 60, 40, 120]);
    return;
  }
  const emoji = type === "hug" ? "🤗" : "💋";
  systemMsg(`${from} → ${emoji}`);
  for (let i = 0; i < 10; i++) {
    setTimeout(() => {
      const s = document.createElement("span");
      s.textContent = type === "hug" ? "🤍" : "💜";
      s.style.left = 10 + Math.random() * 80 + "%";
      s.style.fontSize = 20 + Math.random() * 18 + "px";
      $("hearts").appendChild(s);
      setTimeout(() => s.remove(), 2700);
    }, i * 90);
  }
});

/* ---------------- Мелочи ---------------- */
$("tap-to-play").addEventListener("click", async () => {
  $("tap-to-play").style.display = "none";
  if (!player) return;
  await player.play();                 // теперь есть жест — iOS разрешит
  player.seek(sync.expected() + 0.1);  // догоняем комнату одним seek'ом
});

/* панели не накладываются: открытие одной закрывает остальные */
const PANELS = ["diag", "stats-panel", "settings-panel", "avatar-picker"];
function togglePanel(id) {
  const willShow = $(id).style.display === "none";
  PANELS.forEach((p) => ($(p).style.display = "none"));
  if (willShow) $(id).style.display = "";
  return willShow;
}

/* ---------------- Диагностика (тап по индикатору синка) ---------------- */
const VIDEO_ERR = { 1: "прервано", 2: "сеть/CORS", 3: "декодирование", 4: "файл недоступен или формат не поддерживается" };
$("sync-dot").addEventListener("click", () => togglePanel("diag"));
$("diag-resync").addEventListener("click", () => {
  if (!player || !sync.state) return;
  player.seek(sync.expected() + 0.1);
  if (sync.state.playing) player.play(); else player.pause();
  toast("Пересинхронизировано");
});
setInterval(() => {
  if ($("diag").style.display === "none") return;
  const v = player?.video; // есть только у HTML5-плеера
  const err = v?.error ? `${v.error.code} (${VIDEO_ERR[v.error.code] || "?"})` : "нет";
  const lines = [
    `версия      ${CW_VERSION()}`,
    `запуск      ${matchMedia("(display-mode: standalone)").matches || navigator.standalone ? "приложение" : "браузер"} · отступ шапки ${getComputedStyle(document.querySelector(".topbar")).paddingTop}`,
    `экран       ${innerWidth}/${document.documentElement.scrollWidth}px · зум ${(window.visualViewport?.scale ?? 1).toFixed(2)}`,
    `соединение  ${socket.connected ? "✓ подключено" : "✗ разорвано"}`,
    `часы        offset ${Math.round(clock.offset)}мс, rtt ${Math.round(clock.rtt)}мс`,
    `источник    ${sync.state?.source ? sync.state.source.kind + " " + sync.state.source.url.slice(0, 60) : "не выбран"}`,
    `комната     ${sync.state ? (sync.state.playing ? "▶" : "⏸") + " " + (sync.state.mediaTime | 0) + "с, rate " + sync.state.rate + ", v" + sync.state.version : "—"}`,
    `плеер       ${player ? player.kind + (player.isPaused() ? " ⏸ " : " ▶ ") + player.getTime().toFixed(1) + "/" + (player.getDuration() | 0) + "с" : "не создан"}`,
    v ? `видео       readyState ${v.readyState}/4, network ${v.networkState}, ошибка: ${err}` : `видео       (YouTube-iframe)`,
    `дрейф       ${sync.state?.playing && player ? Math.round((player.getTime() - sync.expected()) * 1000) + "мс" : "—"}`,
  ];
  $("diag-body").textContent = lines.join("\n");
}, 500);

$("copy-link").addEventListener("click", async () => {
  if (navigator.share) {
    try {
      await navigator.share({ title: "CoWatch — смотрим вместе", url: location.href });
      return;
    } catch { /* отменили — падаем в копирование */ }
  }
  try {
    await navigator.clipboard.writeText(location.href);
    $("room-code").textContent = "Скопировано ✓";
  } catch {
    // старые браузеры / запрет clipboard — показываем ссылку для ручного копирования
    prompt("Скопируйте ссылку:", location.href);
    $("room-code").textContent = "Пригласить";
    return;
  }
  setTimeout(() => ($("room-code").textContent = "Пригласить"), 1600);
});

const badges = {};
function badge(key, text) {
  badges[key]?.remove(); delete badges[key];
  if (!text) return;
  const el = document.createElement("div");
  el.className = "badge";
  el.textContent = text;
  $("badges").appendChild(el);
  badges[key] = el;
}
function toast(text, ms = 2500) {
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = text;
  $("toasts").appendChild(el);
  setTimeout(() => el.remove(), ms);
}
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]),
  );

/* ================= v8: поиск RuTube ================= */
$("search-go").addEventListener("click", doSearch);
$("search-input").addEventListener("keydown", (e) => e.key === "Enter" && doSearch());

function looksLikeUrl(q) {
  return /^https?:\/\//i.test(q) || /^www\./i.test(q) ||
    /(rutube\.ru|youtu\.be|youtube\.com)/i.test(q) ||
    /\.(mp4|webm|m3u8)(\?|$)/i.test(q);
}

async function doSearch() {
  const q = $("search-input").value.trim();
  if (!q) return;
  // вставили ссылку? включаем её сразу, никакого поиска
  if (looksLikeUrl(q)) {
    const url = /^https?:/i.test(q) ? q : "https://" + q;
    const src = resolveSource(url);
    socket.emit("sync:action", { type: "source", value: { kind: src.kind, url } });
    $("search-input").value = "";
    return;
  }
  $("search-results").innerHTML = Array.from({ length: 4 }, () =>
    `<div class="skel"><div class="sk-img"></div><div class="sk-line"></div></div>`).join("");
  try {
    const r = await fetch("/api/rutube/search?q=" + encodeURIComponent(q));
    if (!r.ok) throw 0;
    const { results } = await r.json();
    if (!results.length) {
      $("search-results").innerHTML = `<div class="search-note">Ничего не нашлось — попробуйте иначе</div>`;
      return;
    }
    $("search-results").innerHTML = "";
    results.forEach((v) => {
      const b = document.createElement("button");
      b.className = "result-card";
      b.innerHTML = `<img loading="lazy" src="${esc(v.thumb)}" alt="">
        <div class="rc-title">${esc(v.title)}${v.duration ? ` · ${fmt(v.duration)}` : ""}</div>`;
      b.addEventListener("click", () => {
        socket.emit("sync:action", {
          type: "source",
          value: { kind: "rutube", url: v.url, title: v.title },
        });
      });
      $("search-results").appendChild(b);
    });
  } catch {
    $("search-results").innerHTML =
      `<div class="search-note">Поиск RuTube сейчас недоступен — вставьте ссылку на видео ниже</div>`;
  }
}

/* ================= v8: реакции поверх видео ================= */
document.querySelectorAll("[data-react]").forEach((b) =>
  b.addEventListener("click", () =>
    socket.emit("couple:reaction", { emoji: b.dataset.react })),
);
const hearts = { mine: 0, theirs: 0 };
socket.on("couple:reaction", ({ emoji, from }) => {
  if (settings.fxReact) {
    const s = document.createElement("span");
    s.className = "fly-react";
    s.textContent = emoji;
    s.style.left = 12 + Math.random() * 76 + "%";
    $("stage").appendChild(s);
    setTimeout(() => s.remove(), 2300);
  }
  buzz(25);

  // сердечки от обоих в течение 3 секунд = совпадение 💞
  if (emoji === "❤️") {
    const now = Date.now();
    if (from === myName) hearts.mine = now; else hearts.theirs = now;
    if (now - hearts.mine < 3000 && now - hearts.theirs < 3000) {
      hearts.mine = hearts.theirs = 0;
      heartMatch();
    }
  }
});
function heartMatch() {
  const wrap = document.createElement("div");
  wrap.className = "heart-burst";
  wrap.innerHTML = `<span class="hb-big">💞</span>`;
  $("stage").appendChild(wrap);
  for (let i = 0; i < 16; i++) {
    setTimeout(() => {
      const h = document.createElement("span");
      h.textContent = ["💜", "💗", "✨"][i % 3];
      h.style.left = 5 + Math.random() * 90 + "%";
      h.style.fontSize = 18 + Math.random() * 22 + "px";
      $("hearts").appendChild(h);
      setTimeout(() => h.remove(), 2700);
    }, i * 70);
  }
  buzz([40, 60, 40]);
  setTimeout(() => wrap.remove(), 1700);
}

/* ================= v8: статистика пары и любимые моменты =================
   Данные живут в localStorage обоих устройств и сливаются при каждой встрече
   в комнате — сервер их не хранит и рестарты бесплатного тарифа не страшны. */
const PAIR_KEY = "cw:pair:" + roomId;
function loadPair() {
  try { return JSON.parse(localStorage.getItem(PAIR_KEY)) || {}; } catch { return {}; }
}
function savePair(p) { localStorage.setItem(PAIR_KEY, JSON.stringify(p)); }
let pair = Object.assign({ seconds: 0, films: [], days: [], moments: [] }, loadPair());

function mergePair(other) {
  if (!other || typeof other !== "object") return;
  pair.seconds = Math.max(pair.seconds, Number(other.seconds) || 0);
  pair.films = [...new Set([...pair.films, ...(other.films || [])])].slice(-200);
  pair.days = [...new Set([...pair.days, ...(other.days || [])])].sort().slice(-400);
  const ids = new Set(pair.moments.map((m) => m.id));
  (other.moments || []).forEach((m) => {
    if (m && m.id && !ids.has(m.id)) pair.moments.push(m);
  });
  pair.moments = pair.moments.slice(-100);
  savePair(pair);
}
function sendPairSync() {
  socket.emit("pair:sync", { seconds: pair.seconds, films: pair.films, days: pair.days, moments: pair.moments });
}
socket.on("pair:sync", (p) => { mergePair(p); renderStats(); });

// счёт времени вместе: оба в комнате и фильм играет
setInterval(() => {
  if (!socket.connected || lastMembers.length < 2 || !sync.state?.playing) return;
  pair.seconds += 5;
  const today = new Date().toISOString().slice(0, 10);
  if (pair.todayDate !== today) { pair.todayDate = today; pair.todaySec = 0; }
  pair.todaySec = (pair.todaySec || 0) + 5;
  if (!pair.days.includes(today)) pair.days.push(today);
  const url = sync.state?.source?.url;
  if (url && !pair.films.includes(url)) pair.films.push(url);
  savePair(pair);
}, 5000);

function streak() {
  const set = new Set(pair.days);
  let n = 0;
  for (let d = new Date(); ; d.setDate(d.getDate() - 1)) {
    if (set.has(d.toISOString().slice(0, 10))) n++;
    else if (n > 0 || !set.has(new Date().toISOString().slice(0, 10))) break;
  }
  return n;
}

/* панель статистики */
$("stats-btn").addEventListener("click", () => {
  if (togglePanel("stats-panel")) renderStats();
});
$("stats-close").addEventListener("click", () => ($("stats-panel").style.display = "none"));

function renderStats() {
  if ($("stats-panel").style.display === "none") return void 0;
  const h = Math.floor(pair.seconds / 3600), m = Math.floor((pair.seconds % 3600) / 60);
  $("stats-body").innerHTML = `
    <div class="stat-cell"><b>${h}ч ${m}м</b><span>вместе у экрана</span></div>
    <div class="stat-cell"><b>${pair.films.length}</b><span>видео посмотрели</span></div>
    <div class="stat-cell"><b>${streak()}</b><span>дней подряд</span></div>
    <div class="stat-cell"><b>${pair.days.length}</b><span>вечеров всего</span></div>`;
  const list = $("moments-list");
  list.innerHTML = "";
  [...pair.moments].reverse().forEach((mo) => {
    const b = document.createElement("button");
    b.className = "moment-row";
    b.innerHTML = `<span class="m-time">${fmt(mo.time)}</span>
      <span class="m-title">${esc(mo.title || mo.url)}</span>`;
    b.addEventListener("click", () => {
      $("stats-panel").style.display = "none";
      if (sync.state?.source?.url !== mo.url)
        socket.emit("sync:action", { type: "source", value: { kind: mo.kind || "direct", url: mo.url } });
      setTimeout(() => sync.userSeek(mo.time), sync.state?.source?.url === mo.url ? 0 : 2000);
    });
    list.appendChild(b);
  });
}

/* пин момента */
$("btn-pin").addEventListener("click", () => {
  const url = sync.state?.source?.url;
  if (!url || !player) return;
  const mo = {
    id: Math.random().toString(36).slice(2, 10),
    url,
    kind: sync.state.source.kind,
    time: Math.floor(player.getTime()),
    title: sync.state.source.title || url.split("/").pop(),
    at: Date.now(),
  };
  pair.moments.push(mo);
  savePair(pair);
  sendPairSync();
  toast(`📌 Момент ${fmt(mo.time)} сохранён`);
  drawPins();
});

/* точки моментов на таймлайне текущего видео */
function drawPins() {
  document.querySelectorAll(".pin-dot").forEach((d) => d.remove());
  const url = sync.state?.source?.url;
  const dur = player?.getDuration();
  if (!url || !isFinite(dur) || !dur) return;
  pair.moments.filter((m) => m.url === url).forEach((m) => {
    const d = document.createElement("div");
    d.className = "pin-dot";
    d.style.left = (m.time / dur) * 100 + "%";
    $("timeline").querySelector(".track").appendChild(d);
  });
}
setInterval(drawPins, 4000);

/* ================= v8: продолжить с того же места ================= */
setInterval(() => {
  const st = sync.state;
  if (!st?.source || !st.playing || !player) return;
  localStorage.setItem("cw:resume:" + roomId, JSON.stringify({
    url: st.source.url, kind: st.source.kind, title: st.source.title || "",
    time: Math.floor(player.getTime()),
    at: Date.now(),
  }));
}, 10000);

function updateResumeButton() {
  let r; try { r = JSON.parse(localStorage.getItem("cw:resume:" + roomId)); } catch {}
  const btn = $("resume-btn");
  if (!r || sync.state?.source || r.time < 30) { btn.style.display = "none"; return; }
  btn.style.display = "";
  btn.textContent = `▶ Продолжить${r.title ? " «" + r.title.slice(0, 40) + "»" : ""} с ${fmt(r.time)}`;
  btn.onclick = () => {
    socket.emit("sync:action", { type: "source", value: { kind: r.kind, url: r.url, title: r.title } });
    setTimeout(() => sync.userSeek(r.time), 2500);
  };
}

/* ================= v10: экран окончания видео ================= */
function bindEnded() {
  if (!player) return;
  player.on("ended", () => {
    $("ended-overlay").style.display = "";
    $("big-play").style.display = "none";
  });
}
$("ended-replay").addEventListener("click", () => {
  $("ended-overlay").style.display = "none";
  sync.userSeek(0);
  sync.userPlay();
});
$("ended-new").addEventListener("click", () => {
  $("ended-overlay").style.display = "none";
  openSourceCard();
});
$("float-change").addEventListener("click", openSourceCard);
function openSourceCard() {
  renderRecent();
  $("source-card").style.display = "";
  $("search-input").focus();
}

/* ================= v10: экран не гаснет во время просмотра ================= */
let wakeLock = null;
setInterval(async () => {
  const playing = !!sync.state?.playing && !!player && !player.isPaused();
  try {
    if (playing && !wakeLock && "wakeLock" in navigator) {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => (wakeLock = null));
    } else if (!playing && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch { wakeLock = null; } // не поддерживается / нет разрешения — не страшно
}, 3000);

/* ================= v10: возврат во вкладку = мгновенный ресинк =================
   iOS замораживает таймеры в фоне: после возврата позиция уезжает на всё
   время отсутствия. Ловим момент возврата и догоняем комнату одним seek'ом. */
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  clock.start(); // свежие пинги часов
  setTimeout(() => {
    if (!player || !sync.state) return;
    const drift = Math.abs(player.getTime() - sync.expected());
    if (drift > 1) {
      player.seek(sync.expected() + 0.1);
      if (sync.state.playing && player.isPaused()) player.play();
    }
  }, 900);
});

/* ================= v10: двойной тап по краям = ±10 секунд ================= */
let lastTap = { at: 0, x: 0 };
$("stage").addEventListener("pointerup", (e) => {
  if (!isTouch || !player) return;
  if (e.target !== $("player-host") && e.target.tagName !== "VIDEO") return;
  const now = performance.now();
  const w = $("stage").getBoundingClientRect().width;
  const frac = e.clientX / w;
  if (now - lastTap.at < 350 && Math.abs(e.clientX - lastTap.x) < 60) {
    if (frac < 0.3) { sync.userSeek(Math.max(0, player.getTime() - 10)); toast("−10 сек"); }
    else if (frac > 0.7) { sync.userSeek(player.getTime() + 10); toast("+10 сек"); }
    lastTap = { at: 0, x: 0 };
    return;
  }
  lastTap = { at: now, x: e.clientX };
});

/* ================= v11: мой статус (☕ чай / 🍿 попкорн / …) ================= */
const STATUS_CYCLE = [null, "☕", "🍿", "🚻", "😴"];
let statusIdx = 0;
$("status-btn").addEventListener("click", () => {
  statusIdx = (statusIdx + 1) % STATUS_CYCLE.length;
  const emoji = STATUS_CYCLE[statusIdx];
  $("status-btn").textContent = emoji || "☕";
  $("status-btn").style.opacity = emoji ? "1" : "";
  socket.emit("couple:status", { emoji });
  toast(emoji ? `Статус: ${emoji}` : "Статус снят");
});

/* ================= v12: пикер аватара ================= */
const AVATARS = ["🐱","🐶","🦊","🐻","🐼","🐸","🦁","🐯","🐰","🦄","🐙","🦋","🌸","🍓","🌙","⭐"];
(function buildAvatarPicker() {
  const grid = $("av-grid");
  AVATARS.forEach((a) => {
    const b = document.createElement("button");
    b.textContent = a;
    if (localStorage.getItem("cw:avatar") === a) b.classList.add("me");
    b.addEventListener("click", () => {
      localStorage.setItem("cw:avatar", a);
      grid.querySelectorAll("button").forEach((x) => x.classList.remove("me"));
      b.classList.add("me");
      socket.emit("room:avatar", { emoji: a });
      $("avatar-picker").style.display = "none";
      toast(`Теперь ты ${a}`);
    });
    grid.appendChild(b);
  });
})();

/* ================= v12: тук-тук ================= */
$("knock-btn").addEventListener("click", () =>
  socket.emit("couple:event", { type: "knock" }),
);

/* ================= v12: обнимашка с удержанием =================
   короткое нажатие — обычная 🤗, удержание 1.5с — суперобнимашка */
(function hugHold() {
  const btn = $("hug-btn");
  let downAt = 0, chargeTimer = null;
  const start = (e) => {
    e.preventDefault();
    downAt = performance.now();
    chargeTimer = setTimeout(() => btn.classList.add("charging"), 300);
  };
  const end = () => {
    if (!downAt) return;
    clearTimeout(chargeTimer);
    btn.classList.remove("charging");
    const held = performance.now() - downAt;
    downAt = 0;
    socket.emit("couple:event", { type: held >= 1500 ? "superhug" : "hug" });
  };
  btn.addEventListener("pointerdown", start);
  btn.addEventListener("pointerup", end);
  btn.addEventListener("pointerleave", () => { clearTimeout(chargeTimer); btn.classList.remove("charging"); downAt = 0; });
})();

/* ================= v12: билетик вечера 🎟 ================= */
$("ticket-btn").addEventListener("click", makeTicket);
async function makeTicket() {
  toast("Печатаем билетик…");
  const W = 900, H = 1200;
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  const x = c.getContext("2d");

  // фон с мягкими свечениями
  x.fillStyle = "#111114";
  x.fillRect(0, 0, W, H);
  const glow = (cx, cy, r, col) => {
    const g = x.createRadialGradient(cx, cy, 0, cx, cy, r);
    g.addColorStop(0, col); g.addColorStop(1, "transparent");
    x.fillStyle = g; x.fillRect(0, 0, W, H);
  };
  glow(W * 0.8, H * 0.15, 500, "rgba(88,101,242,.28)");
  glow(W * 0.15, H * 0.8, 520, "rgba(108,92,231,.24)");

  // корпус билета со скруглением и перфорацией по бокам
  const pad = 60, ty = 130, th = H - 260;
  x.fillStyle = "rgba(26,26,30,.92)";
  x.strokeStyle = "rgba(255,255,255,.14)";
  x.lineWidth = 2;
  x.beginPath();
  x.roundRect(pad, ty, W - pad * 2, th, 34);
  x.fill(); x.stroke();
  // выемки как у отрывного билета
  const notchY = ty + th * 0.68;
  x.globalCompositeOperation = "destination-out";
  for (const nx of [pad, W - pad]) {
    x.beginPath(); x.arc(nx, notchY, 26, 0, Math.PI * 2); x.fill();
  }
  x.globalCompositeOperation = "source-over";
  // пунктир отрыва
  x.setLineDash([12, 12]);
  x.strokeStyle = "rgba(255,255,255,.22)";
  x.beginPath(); x.moveTo(pad + 34, notchY); x.lineTo(W - pad - 34, notchY); x.stroke();
  x.setLineDash([]);

  // логотип
  try {
    const img = await new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i); i.onerror = rej;
      i.src = "/logo.png";
    });
    const lw = 360, lh = lw * (img.height / img.width);
    x.drawImage(img, (W - lw) / 2, ty + 50, lw, lh);
  } catch {}

  const center = (txt, y, font, col = "#fff") => {
    x.font = font; x.fillStyle = col; x.textAlign = "center";
    x.fillText(txt, W / 2, y);
  };
  const names = lastMembers.map((m) => m.name).slice(0, 2);
  const date = new Date().toLocaleDateString("ru", { day: "numeric", month: "long", year: "numeric" });
  const title = (sync.state?.source?.title || "Наш вечер").slice(0, 34);
  const ts = pair.todaySec || 0;
  const dur = ts >= 3600
    ? `${Math.floor(ts / 3600)} ч ${Math.floor((ts % 3600) / 60)} мин`
    : `${Math.max(1, Math.floor(ts / 60))} мин`;

  center("БИЛЕТ НА ВЕЧЕР", ty + 420, "600 26px system-ui", "rgba(255,255,255,.55)");
  center(names.join(" 💜 ") || myName, ty + 480, "700 44px system-ui");
  center(date, ty + 530, "400 24px system-ui", "rgba(255,255,255,.6)");

  x.font = "700 38px system-ui";
  const fit = x.measureText(title).width > W - 200 ? title.slice(0, 26) + "…" : title;
  center("🎬 " + fit, ty + 630, "700 38px system-ui");
  center(`вместе у экрана: ${dur}`, ty + 690, "400 26px system-ui", "rgba(255,255,255,.7)");

  center("МЕСТО: ДИВАН · РЯД: ОБНИМАШКИ", notchY + 70, "600 22px system-ui", "rgba(255,255,255,.5)");
  center(`сеанс №${pair.days.length} · дней подряд: ${streak()}`, notchY + 115, "400 22px system-ui", "rgba(255,255,255,.45)");
  center("cowatch · смотрим вместе", notchY + 175, "400 20px system-ui", "rgba(139,132,246,.9)");

  // отдаём: нативный share на телефонах, иначе скачивание
  c.toBlob(async (blob) => {
    if (!blob) return toast("Не удалось создать билетик");
    const file = new File([blob], "cowatch-ticket.png", { type: "image/png" });
    if (navigator.canShare?.({ files: [file] })) {
      try { await navigator.share({ files: [file], title: "Наш вечер в CoWatch" }); return; }
      catch { /* отменили — скачиваем */ }
    }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "cowatch-ticket.png";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }, "image/png");
}

/* ================= v12: защита от случайного выхода ================= */
window.addEventListener("beforeunload", (e) => {
  if (sync.state?.playing && lastMembers.length >= 2) {
    e.preventDefault();
    e.returnValue = ""; // Android/десктоп покажут «Точно выйти?»; iOS такое не умеет
  }
});

/* ================= v14: настройки ================= */
const THEMES = {
  violet: ["#5865F2", "#6C5CE7"],
  pink:   ["#EC4899", "#F472B6"],
  mint:   ["#10B981", "#34D399"],
  amber:  ["#F59E0B", "#F97316"],
  sky:    ["#0EA5E9", "#38BDF8"],
};
const SET_DEF = { theme: "violet", chatSize: "m", bright: 100, anim: true, fxReact: true, vibro: true };
let settings = SET_DEF;
try { settings = { ...SET_DEF, ...JSON.parse(localStorage.getItem("cw:settings") || "{}") }; } catch {}

function buzz(pattern) {
  if (!settings.vibro) return;
  try { navigator.vibrate?.(pattern); } catch {}
}

function applySettings() {
  const [a, b] = THEMES[settings.theme] || THEMES.violet;
  const root = document.documentElement.style;
  root.setProperty("--accent", a);
  root.setProperty("--accent2", b);
  root.setProperty("--grad", `linear-gradient(135deg, ${a}, ${b})`);
  root.setProperty("--vid-bright", settings.bright / 100);
  document.body.dataset.chatsize = settings.chatSize;
  document.body.classList.toggle("no-anim", !settings.anim);
  // отрисовка контролов панели
  document.querySelectorAll("#theme-dots button").forEach((d) =>
    d.classList.toggle("on", d.dataset.t === settings.theme));
  document.querySelectorAll("#chatsize-seg button").forEach((d) =>
    d.classList.toggle("on", d.dataset.v === settings.chatSize));
  $("set-bright").value = settings.bright;
  $("tgl-anim").classList.toggle("on", settings.anim);
  $("tgl-fx").classList.toggle("on", settings.fxReact);
  $("tgl-vibro").classList.toggle("on", settings.vibro);
}
function saveSettings() {
  localStorage.setItem("cw:settings", JSON.stringify(settings));
  applySettings();
}

(function buildSettings() {
  Object.entries(THEMES).forEach(([name, [a, b]]) => {
    const d = document.createElement("button");
    d.dataset.t = name;
    d.style.background = `linear-gradient(135deg, ${a}, ${b})`;
    d.addEventListener("click", () => { settings.theme = name; saveSettings(); });
    $("theme-dots").appendChild(d);
  });
  document.querySelectorAll("#chatsize-seg button").forEach((d) =>
    d.addEventListener("click", () => { settings.chatSize = d.dataset.v; saveSettings(); }));
  $("set-bright").addEventListener("input", () => {
    settings.bright = Number($("set-bright").value); saveSettings();
  });
  const tgl = (id, key) => $(id).addEventListener("click", () => {
    settings[key] = !settings[key]; saveSettings();
  });
  tgl("tgl-anim", "anim"); tgl("tgl-fx", "fxReact"); tgl("tgl-vibro", "vibro");
  applySettings();
})();

$("settings-btn").addEventListener("click", () => togglePanel("settings-panel"));
$("settings-close").addEventListener("click", () => ($("settings-panel").style.display = "none"));

/* ================= v14: пасхалки 🤫 ================= */
// признание в чате не остаётся без ответа вселенной
const LOVE_RE = /(я\s+(тебя|вас)\s+люблю|люблю\s+тебя|love\s+you|люблю\s+тебя,?\s*\S*)/i;
function maybeLoveExplosion(text) {
  if (!LOVE_RE.test(text)) return;
  for (let i = 0; i < 26; i++) {
    setTimeout(() => {
      const h = document.createElement("span");
      h.textContent = ["💜", "💗", "🤍", "💞"][i % 4];
      h.style.left = 3 + Math.random() * 94 + "%";
      h.style.fontSize = 20 + Math.random() * 24 + "px";
      $("hearts").appendChild(h);
      setTimeout(() => h.remove(), 2700);
    }, i * 70);
  }
  buzz([50, 80, 50]);
}

// пять быстрых тапов по логотипу
let logoTaps = [];
let logoNav = null;
document.querySelector(".brand").addEventListener("click", (e) => {
  e.preventDefault(); // навигацией управляем сами: 1 тап — на главную, 5 — сюрприз
  clearTimeout(logoNav);
  const now = performance.now();
  logoTaps = logoTaps.filter((t) => now - t < 2500);
  logoTaps.push(now);
  if (logoTaps.length === 1) {
    // одиночный тап: если за полсекунды не пришёл второй — уходим на главную
    logoNav = setTimeout(() => { if (logoTaps.length === 1) location.href = "/"; }, 500);
    return;
  }
  if (logoTaps.length < 5) return;
  logoTaps = [];
  const rain = document.createElement("div");
  rain.className = "stars-rain";
  rain.style.cssText = "position:absolute;inset:0;pointer-events:none;overflow:hidden;z-index:9";
  for (let i = 0; i < 22; i++) {
    const st = document.createElement("span");
    st.textContent = ["✨", "⭐", "💫"][i % 3];
    st.style.left = Math.random() * 96 + "%";
    st.style.animationDelay = Math.random() * 0.8 + "s";
    rain.appendChild(st);
  }
  $("stage").appendChild(rain);
  setTimeout(() => rain.remove(), 3600);
  toast("Сделано с 💜 специально для вас двоих");
  buzz([30, 30, 30, 30, 90]);
});

/* ================= v21: история видео с возвратом ================= */
const HIST_KEY = "cw:history:" + roomId;
function loadHistory() {
  try { return JSON.parse(localStorage.getItem(HIST_KEY)) || []; } catch { return []; }
}
function pushHistory(source, time) {
  if (!source?.url) return;
  let h = loadHistory().filter((x) => x.url !== source.url);
  h.unshift({ url: source.url, kind: source.kind, title: source.title || "", time: Math.floor(time), at: Date.now() });
  localStorage.setItem(HIST_KEY, JSON.stringify(h.slice(0, 8)));
}
// позиция текущего видео обновляется в истории каждые 10 секунд
setInterval(() => {
  const st = sync.state;
  if (st?.source && st.playing && player) pushHistory(st.source, player.getTime());
}, 10000);

function renderRecent() {
  const list = $("recent-list");
  list.innerHTML = "";
  const cur = sync.state?.source?.url;
  loadHistory().filter((h) => h.url !== cur).slice(0, 5).forEach((h) => {
    const b = document.createElement("button");
    b.className = "recent-row";
    b.innerHTML = `<span class="r-time">↩ ${fmt(h.time)}</span>
      <span class="r-title">${esc(h.title || h.url.split("/").filter(Boolean).pop())}</span>`;
    b.addEventListener("click", () => {
      $("source-card").style.display = "none";
      socket.emit("sync:action", { type: "source", value: { kind: h.kind, url: h.url, title: h.title } });
      if (h.time > 20) setTimeout(() => sync.userSeek(h.time), 2500);
    });
    list.appendChild(b);
  });
}

/* ================= v21: фото в чате ================= */
$("photo-btn").addEventListener("click", () => $("photo-file").click());
$("photo-file").addEventListener("change", async () => {
  const file = $("photo-file").files[0];
  $("photo-file").value = "";
  if (!file) return;
  toast("Отправляем фото…");
  try {
    const data = await compressImage(file);
    if (data.length > 450_000) return toast("Фото слишком большое даже после сжатия");
    socket.emit("chat:photo", { data });
  } catch { toast("Не получилось обработать фото"); }
});

function compressImage(file) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => {
      const MAX = 1280;
      const k = Math.min(1, MAX / Math.max(img.width, img.height));
      const c = document.createElement("canvas");
      c.width = Math.round(img.width * k);
      c.height = Math.round(img.height * k);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(img.src);
      res(c.toDataURL("image/jpeg", 0.72));
    };
    img.onerror = rej;
    img.src = URL.createObjectURL(file);
  });
}

$("lightbox").addEventListener("click", () => ($("lightbox").style.display = "none"));
function openLightbox(src) {
  $("lightbox-img").src = src;
  $("lightbox").style.display = "";
}
