// CoWatch — движок синхронизации.
// Сервер авторитетен: клиент хранит последний sync:state и каждые 500 мс
// сравнивает позицию плеера с ожидаемой. Малый дрейф лечится изменением
// скорости на ±5% (незаметно), большой — перемоткой.

(() => {
class ClockSync {
  constructor(socket) {
    this.socket = socket;
    this.samples = []; // скользящее окно последних замеров
    this.offset = 0;   // serverTime - clientTime
    this.rtt = 0;
    this.ready = false;
    socket.on("sync:pong", ({ t0, serverTime }) => {
      const t1 = Date.now();
      const rtt = t1 - t0;
      if (!Number.isFinite(rtt) || rtt < 0) return;
      this.samples.push({ rtt, offset: serverTime - (t0 + rtt / 2) });
      if (this.samples.length > 40) this.samples.shift();
      this.recompute();
    });
  }
  // Непрерывная синхронизация: плотная пачка на старте, дальше пинг каждые 2.5с.
  // На мобильном интернете большинство пингов испорчены очередями за видео-
  // пакетами (rtt взлетает до секунд), поэтому offset берём из замера с
  // МИНИМАЛЬНЫМ rtt в окне — он ближе всех к истине. Один чистый пинг из
  // тридцати даёт точные часы; окно скользит, чтобы смена сети не оставляла
  // устаревших замеров навсегда.
  start() {
    this.stop();
    const ping = () => this.socket.emit("sync:ping", { t0: Date.now() });
    [0, 200, 450, 750, 1100].forEach((d) => setTimeout(ping, d));
    this.timer = setInterval(ping, 2500);
  }
  stop() { clearInterval(this.timer); }
  measure() { this.start(); } // совместимость со старым интерфейсом
  recompute() {
    const recent = this.samples.slice(-30);
    const best = recent.reduce((a, b) => (b.rtt < a.rtt ? b : a));
    // шум меньше 25мс игнорируем — иначе дрейф-коррекция дёргается за часами
    if (!this.ready || Math.abs(best.offset - this.offset) > 25) this.offset = best.offset;
    this.rtt = best.rtt;
    this.ready = true;
  }
  now() { return Date.now() + this.offset; }
}

class SyncEngine {
  constructor(socket, clock) {
    this.socket = socket;
    this.clock = clock;
    this.player = null;
    this.state = null;        // авторитетное состояние с сервера
    this.nudging = false;
    this.buffering = false;
    this.seekCooldown = 0;    // не дрейф-корректируем сразу после seek
    this.onDrift = () => {};  // колбэк для индикатора (driftSec | null)

    socket.on("sync:state", (s) => this.applyState(s));
    this.loop = setInterval(() => this.tick(), 500);
  }

  attach(player) { this.player = player; }

  expected() {
    const s = this.state;
    if (!s) return 0;
    const dt = s.playing ? (this.clock.now() - s.updatedAt) / 1000 : 0;
    return s.mediaTime + dt * s.rate;
  }

  applyState(s) {
    if (this.state && s.version <= this.state.version) return; // out-of-order
    const prev = this.state;
    this.state = s;
    const p = this.player;
    if (!p) return;

    // смена источника обрабатывает room.js; здесь — время/скорость/пауза
    if (!p.isLive) {
      const target = this.expected();
      if (Math.abs(p.getTime() - target) > 0.5) {
        p.seek(target + 0.1);
        this.seekCooldown = performance.now() + 1500;
      }
    }
    if (!prev || prev.rate !== s.rate) p.setRate(s.rate);
    if (s.playing && p.isPaused()) p.play();
    if (!s.playing && !p.isPaused()) p.pause();
  }

  tick() {
    const p = this.player, s = this.state;
    if (p?.isLive) { this.onDrift(null); return; } // live: у каждого своя задержка CDN
    if (!p || !s || !s.playing || this.buffering) { this.onDrift(null); return; }
    if (performance.now() < this.seekCooldown) return;

    const drift = p.getTime() - this.expected(); // >0 = спешим, <0 = отстаём
    const abs = Math.abs(drift);
    this.onDrift(drift);

    // дробные скорости вроде 1.05 умеют только наши плееры (HTML5/HLS);
    // YouTube и RuTube — коррекция только перемоткой
    const canNudge = p.kind === "direct" || p.kind === "hls";
    // при плохой сети (rtt > 600мс) пороги расширяются: стабильность важнее
    // идеала, которого канал всё равно не даст
    const slow = (this.clock.rtt || 0) > 600;
    let seekAt = canNudge ? 1.0 : 0.75;
    if (slow) seekAt = Math.min(2.5, (this.clock.rtt || 0) / 1000 + 0.7);
    const dead = slow ? 0.3 : 0.15;
    if (abs < dead) {
      if (this.nudging) { p.setRate(s.rate); this.nudging = false; }
    } else if (abs < seekAt && canNudge) {
      // незаметная коррекция скоростью ±5%
      p.setRate(s.rate * (drift > 0 ? 0.95 : 1.05));
      this.nudging = true;
    } else if (abs >= seekAt) {
      p.seek(this.expected() + 0.1);
      p.setRate(s.rate);
      this.nudging = false;
      this.seekCooldown = performance.now() + 1500;
    }
  }

  // ---- локальные действия пользователя: сервер первым, применяем оптимистично ----
  userPlay() {
    const t = this.player?.getTime() ?? 0;
    this.socket.emit("sync:action", { type: "play", time: t });
    this.player?.play();
  }
  userPause() {
    const t = this.player?.getTime() ?? 0;
    this.socket.emit("sync:action", { type: "pause", time: t });
    this.player?.pause();
  }
  userSeek(t) {
    this.socket.emit("sync:action", { type: "seek", time: t });
    this.player?.seek(t);
    this.seekCooldown = performance.now() + 1500;
  }
  userRate(r) {
    const t = this.player?.getTime() ?? 0;
    this.socket.emit("sync:action", { type: "rate", value: r, time: t });
    this.player?.setRate(r);
  }
  setBuffering(b) {
    this.buffering = b;
    this.socket.emit("sync:buffering", b);
  }
}

window.CW_SYNC = { ClockSync, SyncEngine };
})();
