// CoWatch — адаптеры источников.
// Единый интерфейс: play, pause, seek, setRate, getTime, getDuration,
// getBuffered, setMuted, isReady, on(event, cb), destroy.
// События: 'ready' | 'buffering' | 'canplay' | 'timeupdate' | 'user-play' | 'user-pause' | 'user-seek'

(() => {
/* ---------- Определение типа источника ---------- */
function resolveSource(url) {
  url = url.trim();
  const yt = url.match(
    /(?:youtube\.com\/(?:watch\?.*v=|shorts\/|embed\/)|youtu\.be\/)([\w-]{11})/,
  );
  if (yt) return { kind: "youtube", url, videoId: yt[1] };
  const rt = url.match(/rutube\.ru\/(?:video|play\/embed|shorts)\/([0-9a-f]{32})/i);
  if (rt) return { kind: "rutube", url, videoId: rt[1] };
  if (/\.m3u8(\?|$)/i.test(url)) return { kind: "hls", url };
  return { kind: "direct", url };
}

/* ---------- HTML5 / HLS ---------- */
class Html5Player {
  constructor(host, source) {
    this.kind = source.kind;
    this.handlers = {};
    this.video = document.createElement("video");
    this.video.playsInline = true;
    this.video.preload = "auto";
    host.appendChild(this.video);

    if (source.kind === "hls" && window.Hls?.isSupported()) {
      this.hls = new Hls({ lowLatencyMode: false });
      this.hls.loadSource(source.url);
      this.hls.attachMedia(this.video);
    } else {
      this.video.src = source.url; // прямые ссылки + нативный HLS в Safari
    }

    const v = this.video;
    v.addEventListener("loadedmetadata", () => this.emit("ready"));
    v.addEventListener("waiting", () => this.emit("buffering", true));
    v.addEventListener("canplay", () => this.emit("buffering", false));
    v.addEventListener("timeupdate", () => this.emit("timeupdate", v.currentTime));
    v.addEventListener("ended", () => this.emit("ended"));
    v.addEventListener("error", () =>
      this.emit("error", "Не удалось загрузить видео. Проверьте ссылку — возможно, сервер-источник запрещает доступ (CORS) или файл недоступен."),
    );
    // Свои контролы => клики по видео обрабатывает room.js, петель нет.
  }
  emit(ev, ...a) { (this.handlers[ev] || []).forEach((f) => f(...a)); }
  on(ev, f) { (this.handlers[ev] ||= []).push(f); }

  async play() {
    try { await this.video.play(); }
    catch { this.emit("autoplay-blocked"); } // iOS/Safari: нужен жест пользователя
  }
  pause() { this.video.pause(); }
  seek(t) { this.video.currentTime = t; }
  setRate(r) { this.video.playbackRate = r; }
  getTime() { return this.video.currentTime; }
  getDuration() { return this.video.duration || 0; }
  getBuffered() {
    const b = this.video.buffered;
    return b.length ? b.end(b.length - 1) : 0;
  }
  setMuted(m) { this.video.muted = m; }
  get muted() { return this.video.muted; }
  isPaused() { return this.video.paused; }
  destroy() { this.hls?.destroy(); this.video.remove(); }
}

/* ---------- YouTube (IFrame API) ---------- */
let ytApiPromise = null;
function loadYouTubeApi() {
  if (window.YT?.Player) return Promise.resolve();
  if (ytApiPromise) return ytApiPromise;
  ytApiPromise = new Promise((res) => {
    window.onYouTubeIframeAPIReady = res;
    const s = document.createElement("script");
    s.src = "https://www.youtube.com/iframe_api";
    document.head.appendChild(s);
  });
  return ytApiPromise;
}

class YouTubePlayer {
  constructor(host, source) {
    this.kind = "youtube";
    this.handlers = {};
    this.suppressUntil = 0;   // окно, когда onStateChange — это мы сами, а не юзер
    this.lastPoll = null;     // { t, at } для детекта пользовательской перемотки
    this.ready = false;
    this.destroyed = false;

    const div = document.createElement("div");
    div.id = "yt-host";
    host.appendChild(div);

    loadYouTubeApi().then(() => {
      if (this.destroyed) return; // источник уже сменили, не создаём мертвеца
      this.yt = new YT.Player("yt-host", {
        videoId: source.videoId,
        playerVars: { rel: 0, playsinline: 1, modestbranding: 1 },
        events: {
          onReady: () => { this.ready = true; this.emit("ready"); this.startPolling(); },
          onStateChange: (e) => this.onState(e.data),
          onError: () => this.emit("error", "YouTube не смог воспроизвести это видео (возможно, встраивание запрещено автором)."),
        },
      });
    });
  }
  emit(ev, ...a) { (this.handlers[ev] || []).forEach((f) => f(...a)); }
  on(ev, f) { (this.handlers[ev] ||= []).push(f); }
  suppress(ms = 900) { this.suppressUntil = performance.now() + ms; }
  get suppressed() { return performance.now() < this.suppressUntil; }

  onState(s) {
    const S = YT.PlayerState;
    if (s === S.ENDED) return this.emit("ended");
    if (s === S.BUFFERING) return this.emit("buffering", true);
    if (s === S.PLAYING) {
      this.emit("buffering", false);
      if (!this.suppressed) this.emit("user-play", this.getTime());
    }
    if (s === S.PAUSED && !this.suppressed) this.emit("user-pause", this.getTime());
  }

  // детект пользовательской перемотки внутри iframe YouTube
  startPolling() {
    this.pollTimer = setInterval(() => {
      if (!this.ready) return;
      const t = this.getTime();
      const now = performance.now();
      if (this.lastPoll) {
        const elapsed = (now - this.lastPoll.at) / 1000;
        const expected = this.lastPoll.t + (this.isPaused() ? 0 : elapsed * this.getRate());
        if (Math.abs(t - expected) > 2.5 && !this.suppressed) {
          this.emit("user-seek", t);
        }
      }
      this.lastPoll = { t, at: now };
      this.emit("timeupdate", t);
    }, 500);
  }

  async play() { this.suppress(); this.yt?.playVideo(); }
  pause() { this.suppress(); this.yt?.pauseVideo(); }
  seek(t) { this.suppress(); this.lastPoll = null; this.yt?.seekTo(t, true); }
  setRate(r) { this.suppress(); this.yt?.setPlaybackRate(r); }
  getRate() { return this.yt?.getPlaybackRate?.() || 1; }
  getTime() { return this.yt?.getCurrentTime?.() || 0; }
  getDuration() { return this.yt?.getDuration?.() || 0; }
  getBuffered() { return (this.yt?.getVideoLoadedFraction?.() || 0) * this.getDuration(); }
  setMuted(m) { m ? this.yt?.mute() : this.yt?.unMute(); }
  isPaused() { return this.yt?.getPlayerState?.() !== YT?.PlayerState?.PLAYING; }
  destroy() {
    this.destroyed = true;
    clearInterval(this.pollTimer);
    this.yt?.destroy();
    document.getElementById("yt-host")?.remove();
  }
}

/* ---------- RuTube (embed + postMessage) ----------
   Официальный протокол плеера RuTube: команды и события ходят через
   postMessage JSON-строками. Время приходит событиями player:currentTime
   примерно раз в секунду — между ними экстраполируем сами. */
class RuTubePlayer {
  constructor(host, source) {
    this.kind = "rutube";
    this.handlers = {};
    this.destroyed = false;
    this.ready = false;
    this.suppressUntil = 0;
    this._playing = false;
    this._dur = 0;
    this._last = { t: 0, at: performance.now() }; // последняя точка времени
    this.lastPoll = null;

    this.iframe = document.createElement("iframe");
    this.iframe.src = `https://rutube.ru/play/embed/${source.videoId}/`;
    this.iframe.allow = "autoplay; fullscreen";
    this.iframe.setAttribute("allowfullscreen", "");
    host.appendChild(this.iframe);

    this._onMsg = (e) => {
      if (!String(e.origin).includes("rutube.ru")) return;
      let m; try { m = typeof e.data === "string" ? JSON.parse(e.data) : e.data; } catch { return; }
      if (!m || typeof m.type !== "string") return;
      const d = m.data || {};
      switch (m.type) {
        case "player:ready":
          this.ready = true; this.emit("ready"); break;
        case "player:durationChange":
          if (Number.isFinite(d.duration)) this._dur = d.duration; break;
        case "player:currentTime":
          if (Number.isFinite(d.time)) this._setTime(d.time); break;
        case "player:changeState": {
          const st = d.state;
          if (st === "playing") {
            this._playing = true; this.emit("buffering", false);
            if (!this.suppressed) this.emit("user-play", this.getTime());
          } else if (st === "paused" || st === "stopped") {
            this._playing = false;
            if (!this.suppressed && st === "paused") this.emit("user-pause", this.getTime());
            // «stopped» у самого конца ролика считаем окончанием
            if (st === "stopped" && this._dur && this.getTime() > this._dur - 3)
              this.emit("ended");
          } else if (st === "buffering") this.emit("buffering", true);
          break;
        }
        case "player:error":
          this.emit("error", "RuTube не смог воспроизвести это видео (возможно, оно недоступно или встраивание запрещено)."); break;
      }
    };
    window.addEventListener("message", this._onMsg);

    // страховка: если за 8с плеер не отчитался о готовности — режим деградации
    this._readyGuard = setTimeout(() => {
      if (!this.ready && !this.destroyed) {
        this.ready = true;
        this.emit("ready");
        this.emit("degraded"); // room.js покажет бейдж ручного режима
      }
    }, 8000);

    // детект пользовательской перемотки внутри iframe (как у YouTube)
    this._poll = setInterval(() => {
      const t = this.getTime(), now = performance.now();
      if (this.lastPoll) {
        const elapsed = (now - this.lastPoll.at) / 1000;
        const expected = this.lastPoll.t + (this._playing ? elapsed : 0);
        if (Math.abs(t - expected) > 2.5 && !this.suppressed) this.emit("user-seek", t);
      }
      this.lastPoll = { t, at: now };
      this.emit("timeupdate", t);
    }, 500);
  }
  emit(ev, ...a) { (this.handlers[ev] || []).forEach((f) => f(...a)); }
  on(ev, f) { (this.handlers[ev] ||= []).push(f); }
  suppress(ms = 1200) { this.suppressUntil = performance.now() + ms; }
  get suppressed() { return performance.now() < this.suppressUntil; }
  _setTime(t) { this._last = { t, at: performance.now() }; }
  _cmd(type, data = {}) {
    this.iframe?.contentWindow?.postMessage(JSON.stringify({ type, data }), "*");
  }

  async play() { this.suppress(); this._cmd("player:play"); }
  pause() { this.suppress(); this._cmd("player:pause"); }
  seek(t) {
    this.suppress(); this.lastPoll = null; this._setTime(t);
    this._cmd("player:setCurrentTime", { time: Math.max(0, t) });
  }
  setRate() {} // управление скоростью у RuTube недоступно — синк это учитывает
  getTime() {
    const dt = (performance.now() - this._last.at) / 1000;
    return this._last.t + (this._playing ? dt : 0);
  }
  getDuration() { return this._dur; }
  getBuffered() { return 0; }
  setMuted(m) { this._cmd(m ? "player:mute" : "player:unMute"); }
  isPaused() { return !this._playing; }
  destroy() {
    this.destroyed = true;
    clearInterval(this._poll);
    clearTimeout(this._readyGuard);
    window.removeEventListener("message", this._onMsg);
    this.iframe?.remove();
  }
}

function createPlayer(host, source) {
  if (source.kind === "youtube") return new YouTubePlayer(host, source);
  if (source.kind === "rutube") return new RuTubePlayer(host, source);
  return new Html5Player(host, source);
}

window.CW_PLAYERS = { resolveSource, createPlayer };
})();
