// CoWatch — движок синхронизации.
// Сервер авторитетен: клиент хранит последний sync:state и каждые 500 мс
// сравнивает позицию плеера с ожидаемой. Малый дрейф лечится изменением
// скорости на ±5% (незаметно), большой — перемоткой.

class ClockSync {
  constructor(socket) {
    this.socket = socket;
    this.offset = 0; // serverTime - clientTime
    this.rtt = 0;
    socket.on("sync:pong", ({ t0, serverTime }) => {
      const t1 = Date.now();
      const rtt = t1 - t0;
      this.samples.push({ rtt, offset: serverTime - (t0 + rtt / 2) });
      if (this.samples.length >= 5) this.finish();
    });
  }
  measure() {
    this.samples = [];
    let sent = 0;
    const tick = () => {
      this.socket.emit("sync:ping", { t0: Date.now() });
      if (++sent < 5) setTimeout(tick, 120);
    };
    tick();
  }
  finish() {
    const sorted = [...this.samples].sort((a, b) => a.rtt - b.rtt);
    const medianRtt = sorted[Math.floor(sorted.length / 2)].rtt;
    const good = sorted.filter((s) => s.rtt <= medianRtt * 2);
    const offsets = good.map((s) => s.offset).sort((a, b) => a - b);
    this.offset = offsets[Math.floor(offsets.length / 2)];
    this.rtt = medianRtt;
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
    const target = this.expected();
    if (Math.abs(p.getTime() - target) > 0.5) {
      p.seek(target + 0.1);
      this.seekCooldown = performance.now() + 1500;
    }
    if (!prev || prev.rate !== s.rate) p.setRate(s.rate);
    if (s.playing && p.isPaused()) p.play();
    if (!s.playing && !p.isPaused()) p.pause();
  }

  tick() {
    const p = this.player, s = this.state;
    if (!p || !s || !s.playing || this.buffering) { this.onDrift(null); return; }
    if (performance.now() < this.seekCooldown) return;

    const drift = p.getTime() - this.expected(); // >0 = спешим, <0 = отстаём
    const abs = Math.abs(drift);
    this.onDrift(drift);

    if (abs < 0.15) {
      if (this.nudging) { p.setRate(s.rate); this.nudging = false; }
    } else if (abs < 1.0) {
      // незаметная коррекция скоростью ±5%
      p.setRate(s.rate * (drift > 0 ? 0.95 : 1.05));
      this.nudging = true;
    } else {
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
