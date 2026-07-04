// CoWatch — логика страницы комнаты
const { resolveSource, createPlayer } = window.CW_PLAYERS;
const { ClockSync, SyncEngine } = window.CW_SYNC;

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
  socket.emit("room:join", { roomId, name: myName }, (res) => {
    if (res?.error) {
      document.body.innerHTML =
        `<main class="landing"><div class="landing-card"><div class="logo">CoWatch</div>
         <p class="tagline">${res.error}</p>
         <a href="/"><button class="btn-primary">На главную</button></a></div></main>`;
      return;
    }
    selfId = res.selfId;
    clock.measure();
    renderMembers(res.members);
    res.messages.forEach(renderMessage);
    if (res.state.source) mountSource(res.state.source);
    sync.state = res.state;
    setInterval(() => clock.measure(), 30000);
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
  toast(`Источник: ${resolved.kind === "youtube" ? "YouTube" : resolved.kind.toUpperCase()}`);

  const isYouTube = resolved.kind === "youtube";
  $("controls").style.display = isYouTube ? "none" : ""; // у YT свой UI внутри iframe

  player.on("ready", () => {
    // догоняем комнату
    if (sync.state) sync.applyState({ ...sync.state, version: sync.state.version + 0.1 });
    updateDuration();
    updatePlayIcon();
    showControls();
  });
  player.on("buffering", (b) => {
    sync.setBuffering(b);
    if (!isYouTube) badge("me-buf", b ? "⏳ Буферизация…" : null);
  });
  player.on("timeupdate", updateTimeline);
  player.on("error", (msg) => { toast(msg, 5000); $("source-card").style.display = ""; });
  player.on("autoplay-blocked", () => { $("tap-to-play").style.display = "flex"; });

  // действия пользователя ВНУТРИ iframe YouTube транслируем в комнату
  player.on("user-play", () => sync.userPlay());
  player.on("user-pause", () => sync.userPause());
  player.on("user-seek", (t) => sync.userSeek(t));
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
  const r = $("timeline").getBoundingClientRect();
  const frac = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  sync.userSeek(frac * player.getDuration());
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
  $("members").innerHTML = members
    .map(
      (m) => `<div class="avatar ${m.isOwner ? "owner" : ""}"
        title="${esc(m.name)}${m.isOwner ? " · владелец" : ""}"
        style="background:hsl(${m.hue} 60% 45%)">${esc(m.name[0].toUpperCase())}</div>`,
    )
    .join("");
}
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
  const el = document.createElement("div");
  el.className = "msg";
  el.innerHTML = `
    <div class="avatar" style="background:hsl(${m.hue} 60% 45%)">${esc(m.author[0].toUpperCase())}</div>
    <div class="body">
      <div class="meta"><b>${esc(m.author)}</b>${new Date(m.at).toLocaleTimeString("ru", { hour: "2-digit", minute: "2-digit" })}</div>
      <div class="text">${esc(m.text)}</div>
    </div>`;
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

$("copy-link").addEventListener("click", async () => {
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
