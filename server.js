// CoWatch — сервер комнат и синхронизации
import express from "express";
import { createServer } from "node:http";
import { Server } from "socket.io";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const http = createServer(app);
const io = new Server(http, { cors: { origin: true }, maxHttpBufferSize: 1.5e6 });

app.use(express.json());
app.use(express.static(path.join(__dirname, "public"), {
  setHeaders(res, filePath) {
    // код всегда свежий (ревалидация по ETag), тяжёлые медиа — кэшируются
    if (/\.(html|js|css)$/.test(filePath)) res.setHeader("Cache-Control", "no-cache");
    else res.setHeader("Cache-Control", "public, max-age=86400");
  },
}));

// ---------- Комнаты (в памяти; для масштаба заменяется на Redis) ----------
const ROOM_TTL_MS = 10 * 60 * 1000; // комната живёт 10 мин после опустения
const rooms = new Map();

const roomId = () => randomBytes(6).toString("base64url").slice(0, 8);

function createRoomWithId(id) {
  const room = {
    id,
    state: {
      source: null,          // { kind:'direct'|'hls'|'youtube'|'rutube', url }
      mediaTime: 0,
      playing: false,
      rate: 1,
      updatedAt: Date.now(),
      version: 0,
    },
    members: new Map(),      // socketId -> { name, hue, isOwner }
    messages: [],            // последние 100
    ownerName: null,
    emptyTimer: null,
  };
  rooms.set(id, room);
  return room;
}

function createRoom() {
  const id = roomId();
  createRoomWithId(id);
  return id;
}

const AVATARS = ["🐱","🐶","🦊","🐻","🐼","🐸","🦁","🐯","🐰","🦄","🐙","🦋","🌸","🍓","🌙","⭐"];
const cleanAvatar = (a) => (AVATARS.includes(a) ? a : null);

function publicMembers(room) {
  return [...room.members.entries()].map(([sid, m]) => ({
    id: sid, name: m.name, hue: m.hue, isOwner: m.isOwner,
    status: m.status || null, avatar: m.avatar || null,
  }));
}

// ---------- REST ----------
app.post("/api/rooms", (_req, res) => res.json({ id: createRoom() }));

app.get("/api/rooms/:id/meta", (req, res) => {
  const room = rooms.get(req.params.id);
  if (!room) return res.status(404).json({ error: "not_found" });
  res.json({ id: room.id, members: room.members.size });
});

app.get("/r/:id", (_req, res) =>
  res.sendFile(path.join(__dirname, "public", "room.html")),
);

// ---------- Поиск RuTube (прокси: их API не отдаёт CORS браузеру) ----------
const searchCache = new Map(); // query -> { at, data }
app.get("/api/rutube/search", async (req, res) => {
  const q = String(req.query.q || "").slice(0, 80).trim();
  if (!q) return res.json({ results: [] });
  const cached = searchCache.get(q.toLowerCase());
  if (cached && Date.now() - cached.at < 5 * 60 * 1000) return res.json(cached.data);
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 6000);
    const r = await fetch(
      "https://rutube.ru/api/search/video/?format=json&query=" + encodeURIComponent(q),
      { signal: ctl.signal, headers: { "User-Agent": "Mozilla/5.0 (cowatch)" } },
    );
    clearTimeout(timer);
    if (!r.ok) throw new Error("rutube " + r.status);
    const j = await r.json();
    const data = {
      results: (j.results || []).slice(0, 12).map((v) => ({
        id: v.id,
        title: String(v.title || "").slice(0, 120),
        thumb: v.thumbnail_url || "",
        duration: v.duration || 0,
        url: v.video_url || `https://rutube.ru/video/${v.id}/`,
      })),
    };
    searchCache.set(q.toLowerCase(), { at: Date.now(), data });
    if (searchCache.size > 200) searchCache.delete(searchCache.keys().next().value);
    res.json(data);
  } catch {
    // гео-блок / таймаут / смена их API — честно сообщаем клиенту
    res.status(502).json({ error: "search_unavailable" });
  }
});

// ---------- WebSocket ----------
io.on("connection", (socket) => {
  let joined = null; // { roomId }

  socket.on("room:join", (p, ack) => {
    const { roomId: rid, name, createIfMissing } = p || {};
    let room = rooms.get(rid);
    // постоянная «наша комната»: сервер бесплатного тарифа перезапускается,
    // но ссылка пары должна жить вечно — воссоздаём комнату с тем же id
    if (!room && createIfMissing && /^[\w-]{6,16}$/.test(String(rid || ""))) {
      room = createRoomWithId(String(rid));
    }
    if (!room) return ack?.({ error: "Комната не найдена или закрыта" });

    if (room.emptyTimer) { clearTimeout(room.emptyTimer); room.emptyTimer = null; }

    const cleanName = String(name || "Гость").slice(0, 24).trim() || "Гость";
    const isOwner = room.members.size === 0 && !room.ownerName
      ? true
      : room.ownerName === cleanName;
    if (isOwner) room.ownerName = cleanName;

    room.members.set(socket.id, {
      name: cleanName,
      hue: Math.floor(Math.random() * 360),
      isOwner,
      avatar: cleanAvatar(p?.avatar),
    });
    socket.join(rid);
    joined = { roomId: rid };

    ack?.({
      state: room.state,
      members: publicMembers(room),
      messages: room.messages.slice(-50),
      selfId: socket.id,
    });
    io.to(rid).emit("presence:update", publicMembers(room));
  });

  // Точная синхронизация часов
  socket.on("sync:ping", (p) =>
    socket.emit("sync:pong", { t0: p?.t0, serverTime: Date.now() }),
  );

  // Управление воспроизведением — сервер авторитетен
  socket.on("sync:action", (a) => {
    const room = joined && rooms.get(joined.roomId);
    if (!room || !a || typeof a !== "object") return;
    const s = room.state;
    // время: доверяем клиенту, но при мусоре считаем сами по авторитетному состоянию
    const elapsed = s.playing ? ((Date.now() - s.updatedAt) / 1000) * s.rate : 0;
    const t = Number.isFinite(Number(a.time))
      ? clampTime(a.time)
      : clampTime(s.mediaTime + elapsed);

    switch (a.type) {
      case "source": {
        if (!a.value?.url) return;
        s.source = {
          kind: String(a.value.kind || "direct"),
          url: String(a.value.url).slice(0, 2000),
          title: String(a.value.title || "").slice(0, 120),
        };
        s.mediaTime = 0; s.playing = false; s.rate = 1;
        // название YouTube подтягиваем сами через oEmbed (фоново)
        if (s.source.kind === "youtube" && !s.source.title)
          enrichYoutubeTitle(room, s.source.url);
        break;
      }
      case "play":
        s.mediaTime = t; s.playing = true; break;
      case "pause":
        s.mediaTime = t; s.playing = false; break;
      case "seek":
        s.mediaTime = t; break;
      case "rate": {
        const r = Number(a.value);
        if (!(r >= 0.25 && r <= 2)) return;
        s.mediaTime = t; s.rate = r; break;
      }
      default: return;
    }
    s.updatedAt = Date.now();
    s.version++;
    io.to(joined.roomId).emit("sync:state", s);
  });

  socket.on("sync:buffering", (state) => {
    if (!joined) return;
    socket.to(joined.roomId).emit("sync:peer-buffering", {
      userId: socket.id, state: !!state,
    });
  });

  // Чат (не чаще 10 сообщений за 10 секунд)
  let chatWindow = [];
  socket.on("chat:send", (p) => {
    const text = p?.text;
    const room = joined && rooms.get(joined.roomId);
    const member = room?.members.get(socket.id);
    if (!room || !member) return;
    const now = Date.now();
    chatWindow = chatWindow.filter((t) => now - t < 10_000);
    if (chatWindow.length >= 10) return;
    chatWindow.push(now);
    // ответ на сообщение: сохраняем снимок цитаты (оригинал может уйти из истории)
    let reply = null;
    const rid = typeof p?.replyTo === "string" ? p.replyTo.slice(0, 16) : null;
    if (rid) {
      const orig = room.messages.find((m) => m.id === rid);
      if (orig) reply = {
        id: orig.id,
        author: orig.author,
        text: orig.type === "photo" ? "📷 фото" : String(orig.text || "").slice(0, 80),
      };
    }
    const clean = String(text || "").slice(0, 500).trim();
    if (!clean) return;
    const msg = {
      id: randomBytes(4).toString("hex"),
      author: member.name,
      hue: member.hue,
      avatar: member.avatar || null,
      text: clean,
      reply,
      at: Date.now(),
    };
    room.messages.push(msg);
    if (room.messages.length > 100) room.messages.shift();
    io.to(joined.roomId).emit("chat:message", msg);
  });

  // Фото в чате: сжатый JPEG как dataURL, не чаще 1 раза в 8 секунд.
  // Храним в истории комнаты не больше 10 последних фото — старым чистим данные
  let photoAt = 0;
  socket.on("chat:photo", (p) => {
    const room = joined && rooms.get(joined.roomId);
    const member = room?.members.get(socket.id);
    if (!room || !member) return;
    const data = p?.data;
    if (typeof data !== "string" || !data.startsWith("data:image/jpeg;base64,")) return;
    if (data.length > 450_000) return;
    const now = Date.now();
    if (now - photoAt < 8000) return;
    photoAt = now;
    const msg = {
      id: randomBytes(4).toString("hex"),
      author: member.name,
      hue: member.hue,
      avatar: member.avatar || null,
      type: "photo",
      data,
      at: now,
    };
    room.messages.push(msg);
    if (room.messages.length > 100) room.messages.shift();
    const photos = room.messages.filter((m) => m.type === "photo" && m.data);
    while (photos.length > 10) { photos.shift().data = null; } // текстовая пометка останется
    io.to(joined.roomId).emit("chat:message", msg);
  });

  socket.on("chat:typing", (state) => {
    const room = joined && rooms.get(joined.roomId);
    const member = room?.members.get(socket.id);
    if (!member) return;
    socket.to(joined.roomId).emit("chat:typing", { name: member.name, state: !!state });
  });

  // Милые события — ретранслируем; тук-тук и суперобнимашка не чаще раза в 4с
  let loudAt = 0;
  socket.on("couple:event", (p) => {
    const type = p?.type;
    const room = joined && rooms.get(joined.roomId);
    const member = room?.members.get(socket.id);
    if (!member || !["hug", "kiss", "knock", "superhug"].includes(type)) return;
    if (type === "knock" || type === "superhug") {
      const now = Date.now();
      if (now - loudAt < 4000) return;
      loudAt = now;
    }
    io.to(joined.roomId).emit("couple:event", { type, from: member.name });
  });

  // Реакции-эмодзи поверх видео: whitelist + не чаще 10 за 5 секунд
  const REACTIONS = ["❤️", "😂", "😮", "🔥", "🥺", "👍", "😭", "🤯"];
  let reactWindow = [];
  socket.on("couple:reaction", (p) => {
    const emoji = p?.emoji;
    const room = joined && rooms.get(joined.roomId);
    if (!room || !REACTIONS.includes(emoji)) return;
    const now = Date.now();
    reactWindow = reactWindow.filter((t) => now - t < 5000);
    if (reactWindow.length >= 10) return;
    reactWindow.push(now);
    const member = room.members.get(socket.id);
    io.to(joined.roomId).emit("couple:reaction", { emoji, from: member?.name || "" });
  });

  // Смена аватара-эмодзи
  socket.on("room:avatar", (p) => {
    const room = joined && rooms.get(joined.roomId);
    const member = room?.members.get(socket.id);
    if (!member) return;
    member.avatar = cleanAvatar(p?.emoji);
    io.to(joined.roomId).emit("presence:update", publicMembers(room));
  });

  // Статусы: «ушёл за чаем» и т.п. — бейдж у аватара
  const STATUSES = ["☕", "🍿", "🚻", "😴"];
  socket.on("couple:status", (p) => {
    const room = joined && rooms.get(joined.roomId);
    const member = room?.members.get(socket.id);
    if (!member) return;
    const emoji = p?.emoji;
    member.status = STATUSES.includes(emoji) ? emoji : null;
    io.to(joined.roomId).emit("presence:update", publicMembers(room));
  });

  // Статистика пары и любимые моменты живут на устройствах (localStorage) —
  // сервер лишь пересылает их партнёру для слияния, ничего не храня
  socket.on("pair:sync", (p) => {
    if (!joined || !p || typeof p !== "object") return;
    const s = JSON.stringify(p);
    if (s.length > 50_000) return; // защита от мусора
    socket.to(joined.roomId).emit("pair:sync", p);
  });

  socket.on("disconnect", () => {
    const room = joined && rooms.get(joined.roomId);
    if (!room) return;
    room.members.delete(socket.id);
    io.to(joined.roomId).emit("presence:update", publicMembers(room));
    if (room.members.size === 0) {
      room.emptyTimer = setTimeout(() => rooms.delete(room.id), ROOM_TTL_MS);
    }
  });
});

const clampTime = (t) => Math.max(0, Math.min(Number(t) || 0, 60 * 60 * 24));

async function enrichYoutubeTitle(room, url) {
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 4000);
    const r = await fetch(
      "https://www.youtube.com/oembed?format=json&url=" + encodeURIComponent(url),
      { signal: ctl.signal },
    );
    clearTimeout(timer);
    if (!r.ok) return;
    const j = await r.json();
    const s = room.state;
    // комната могла сменить видео, пока мы ходили за названием
    if (s.source?.url !== url || s.source.title || !j.title) return;
    s.source.title = String(j.title).slice(0, 120);
    s.version++;
    io.to(room.id).emit("sync:state", s);
  } catch { /* название — не повод для ошибок */ }
}

// лёгкий health-check: главная страница «будит» спящий сервер и ждёт его
app.get("/health", (_req, res) => res.json({ ok: true }));

process.on("uncaughtException", (e) => console.error("[uncaught]", e));
process.on("unhandledRejection", (e) => console.error("[unhandled]", e));

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`CoWatch → http://localhost:${PORT}`));
