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
const io = new Server(http, { cors: { origin: true } });

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

function createRoom() {
  const id = roomId();
  rooms.set(id, {
    id,
    state: {
      source: null,          // { kind:'direct'|'hls'|'youtube', url }
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
  });
  return id;
}

function publicMembers(room) {
  return [...room.members.entries()].map(([sid, m]) => ({
    id: sid, name: m.name, hue: m.hue, isOwner: m.isOwner,
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

// ---------- WebSocket ----------
io.on("connection", (socket) => {
  let joined = null; // { roomId }

  socket.on("room:join", (p, ack) => {
    const { roomId: rid, name } = p || {};
    const room = rooms.get(rid);
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
        };
        s.mediaTime = 0; s.playing = false; s.rate = 1;
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

  // Чат
  socket.on("chat:send", (p) => {
    const text = p?.text;
    const room = joined && rooms.get(joined.roomId);
    const member = room?.members.get(socket.id);
    if (!room || !member) return;
    const clean = String(text || "").slice(0, 500).trim();
    if (!clean) return;
    const msg = {
      id: randomBytes(4).toString("hex"),
      author: member.name,
      hue: member.hue,
      text: clean,
      at: Date.now(),
    };
    room.messages.push(msg);
    if (room.messages.length > 100) room.messages.shift();
    io.to(joined.roomId).emit("chat:message", msg);
  });

  socket.on("chat:typing", (state) => {
    const room = joined && rooms.get(joined.roomId);
    const member = room?.members.get(socket.id);
    if (!member) return;
    socket.to(joined.roomId).emit("chat:typing", { name: member.name, state: !!state });
  });

  // Милые события — просто ретранслируем
  socket.on("couple:event", (p) => {
    const type = p?.type;
    const room = joined && rooms.get(joined.roomId);
    const member = room?.members.get(socket.id);
    if (!member || !["hug", "kiss"].includes(type)) return;
    io.to(joined.roomId).emit("couple:event", { type, from: member.name });
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

process.on("uncaughtException", (e) => console.error("[uncaught]", e));
process.on("unhandledRejection", (e) => console.error("[unhandled]", e));

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`CoWatch → http://localhost:${PORT}`));
