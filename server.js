// MMN OTT MART relay — talks to the IPTV provider on behalf of the app.
// Plain Node.js, no dependencies. Deploy on Railway: it auto-detects this file.
import http from "node:http";

const PORT = process.env.PORT || 3000;
const UA = "VLC/3.0.20 LibVLC/3.0.20";

// 24/7 live page configuration. Override any of these with Railway environment variables.
const LIVE_SERVER = process.env.LIVE_SERVER || "http://myott.to:80";
const LIVE_USER = process.env.LIVE_USER || "8506419545";
const LIVE_PASS = process.env.LIVE_PASS || "9852600110";
const LIVE_CHANNEL = process.env.LIVE_CHANNEL || "IND: TG: Maa HD";
const LIVE_TITLE = process.env.LIVE_TITLE || "Maa HD Live";
const VIEWER_TTL_MS = 45_000;
const viewers = new Map();

const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, PUT, OPTIONS",
  "access-control-allow-headers": "content-type",
};

function sendJson(res, value, status = 200) {
  const body = JSON.stringify(value);
  res.writeHead(status, { ...cors, "content-type": "application/json", "cache-control": "no-store" });
  res.end(body);
}

function activeViewerCount() {
  const cutoff = Date.now() - VIEWER_TTL_MS;
  for (const [id, seenAt] of viewers) {
    if (seenAt < cutoff) viewers.delete(id);
  }
  return viewers.size;
}

function handleViewerHeartbeat(res, requestUrl) {
  const id = String(requestUrl.searchParams.get("id") || "").slice(0, 100);
  if (id) viewers.set(id, Date.now());
  return sendJson(res, { count: activeViewerCount() });
}

function resolveUrl(base, value) {
  try { return new URL(value, base).toString(); } catch { return value; }
}

function proxyUrl(url) {
  return `/api/public/stream?url=${encodeURIComponent(url)}`;
}

function isAllowedTarget(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    const host = url.hostname.toLowerCase();
    return host !== "localhost" && host !== "0.0.0.0" && host !== "127.0.0.1" && host !== "::1";
  } catch { return false; }
}

const normalizeServer = (value) => String(value || "").trim().replace(/\/+$/, "");

async function xtreamGet(server, username, password, params = {}) {
  const url = new URL(`${server}/player_api.php`);
  url.searchParams.set("username", username);
  url.searchParams.set("password", password);
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
  const response = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json, */*" } });
  const text = await response.text();
  if (!response.ok || !text.trim()) {
    console.error("xtream upstream", response.status, params.action ?? "login", text.slice(0, 200));
    if (response.status === 401 || response.status === 403 || response.status === 512 || !text.trim())
      throw new Error("The provider refused this login. Check the server URL, username and password.");
    throw new Error(`The provider is not responding correctly (code ${response.status}).`);
  }
  try { return JSON.parse(text); } catch {
    console.error("xtream invalid json", response.status, text.slice(0, 200));
    throw new Error("The provider returned invalid data.");
  }
}

async function handleXtreamPost(req, res, body) {
  try {
    const mode = body.mode === "m3u" ? "m3u" : "xtream";
    if (mode === "m3u") {
      if (!body.m3u) return sendJson(res, { error: "Playlist URL is required." }, 400);
      const response = await fetch(body.m3u, { cache: "no-store" });
      if (!response.ok) return sendJson(res, { error: "Could not fetch that playlist URL." }, 400);
      const channels = []; const categories = new Set();
      let pending;
      for (const line of (await response.text()).split(/\r?\n/)) {
        if (line.startsWith("#EXTINF")) {
          pending = { name: line.match(/,(.*)$/)?.[1]?.trim() || `Channel ${channels.length + 1}`, logo: line.match(/tvg-logo="([^"]*)"/)?.[1], category: line.match(/group-title="([^"]*)"/)?.[1] || "General" };
        } else if (line.trim() && !line.startsWith("#") && pending) {
          categories.add(pending.category);
          channels.push({ id: String(channels.length + 1), ...pending, stream: proxyUrl(line.trim()), direct: line.trim(), type: "live" });
          pending = undefined;
        }
      }
      return sendJson(res, { user: "Playlist", categories: [...categories], channels, movies: [], series: [], session: { mode: "m3u" } });
    }

    const server = normalizeServer(body.server); const username = body.username ?? ""; const password = body.password ?? "";
    if (!server || !username || !password) return sendJson(res, { error: "Server, username and password are required." }, 400);
    const auth = await xtreamGet(server, username, password);
    const userInfo = auth.user_info;
    if (userInfo?.auth !== 1) return sendJson(res, { error: "Invalid credentials or inactive subscription." }, 401);
    const actions = ["get_live_categories", "get_live_streams", "get_vod_categories", "get_vod_streams", "get_series_categories", "get_series"];
    const [liveCats = [], liveStreams = [], vodCats = [], vodStreams = [], seriesCats = [], seriesStreams = []] =
      await Promise.all(actions.map((action) => xtreamGet(server, username, password, { action })));
    const catName = (list, id) => String(list.find((item) => String(item.category_id) === String(id))?.category_name ?? "General");
    const liveUrl = (id) => `${server}/live/${encodeURIComponent(username)}/${encodeURIComponent(password)}/${id}.m3u8`;
    const movieUrl = (id, ext) => `${server}/movie/${encodeURIComponent(username)}/${encodeURIComponent(password)}/${id}.${String(ext || "mp4")}`;
    const channels = liveStreams.map((item) => ({ id: String(item.stream_id), name: String(item.name ?? "Untitled"), logo: String(item.stream_icon ?? ""), category: catName(liveCats, item.category_id), type: "live", stream: proxyUrl(liveUrl(item.stream_id)), direct: liveUrl(item.stream_id) }));
    const movies = vodStreams.map((item) => ({ id: String(item.stream_id), name: String(item.name ?? "Untitled"), logo: String(item.stream_icon ?? ""), category: catName(vodCats, item.category_id), type: "movie", stream: proxyUrl(movieUrl(item.stream_id, item.container_extension)), direct: movieUrl(item.stream_id, item.container_extension) }));
    const series = seriesStreams.map((item) => ({ id: String(item.series_id), name: String(item.name ?? "Untitled"), logo: String(item.cover ?? ""), category: catName(seriesCats, item.category_id), type: "series", stream: "" }));
    return sendJson(res, { user: String(userInfo?.username ?? username), categories: liveCats.map((item) => String(item.category_name)), channels, movies, series, session: { mode: "xtream", server, username, password } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to connect.";
    return sendJson(res, { error: message }, message.includes("refused this login") ? 401 : 502);
  }
}

async function handleXtreamPut(res, body) {
  try {
    const server = normalizeServer(body.server); const username = body.username ?? ""; const password = body.password ?? "";
    if (!server || !username || !password || !body.action || !body.id) return sendJson(res, { error: "Missing parameters." }, 400);
    const params = body.action === "epg" ? { action: "get_short_epg", stream_id: body.id } : { action: "get_series_info", series_id: body.id };
    return sendJson(res, await xtreamGet(server, username, password, params));
  } catch (error) {
    console.error("[xtream] detail request failed", error);
    return sendJson(res, { error: error instanceof Error ? error.message : "Request failed.", epg_listings: [], episodes: {} });
  }
}

async function streamUpstream(req, res, target) {
  let upstream; let finalUrl = target;
  try {
    const headers = { "User-Agent": UA, Accept: "*/*" };
    if (req.headers.range) headers.Range = req.headers.range;
    // Follow redirects manually: IPTV providers often redirect to IP:port hosts that automatic following rejects.
    for (let hop = 0; hop < 5; hop++) {
      const result = await fetch(finalUrl, { headers, redirect: "manual" });
      const location = result.headers.get("location");
      if (result.status >= 300 && result.status < 400 && location) {
        const next = resolveUrl(finalUrl, location);
        if (!isAllowedTarget(next)) { res.writeHead(400, cors); return res.end("Invalid redirect"); }
        finalUrl = next;
        continue;
      }
      upstream = result;
      break;
    }
  } catch (error) {
    if (error?.name === "AbortError") return;
    console.error("[stream] fetch failed", finalUrl, error);
    res.writeHead(502, cors); return res.end("Stream provider is unavailable");
  }
  if (!upstream) { res.writeHead(502, cors); return res.end("Too many redirects"); }

  if (!upstream.ok && upstream.status !== 206) {
    // 509/429 = provider connection limit (often a previous channel still open). Report as temporary.
    const limited = upstream.status === 509 || upstream.status === 429;
    console.warn("[stream] upstream status", upstream.status, finalUrl);
    res.writeHead(limited ? 503 : upstream.status >= 500 ? 502 : upstream.status, { ...cors, "retry-after": "3", "cache-control": "no-store" });
    return res.end(limited ? "Provider connection limit reached" : "Upstream error");
  }

  const contentType = upstream.headers.get("content-type") ?? "";
  const isPlaylist = new URL(finalUrl).pathname.toLowerCase().endsWith(".m3u8") || new URL(target).pathname.toLowerCase().endsWith(".m3u8") || contentType.includes("mpegurl");

  if (isPlaylist) {
    const base = finalUrl;
    const playlist = (await upstream.text()).split(/\r?\n/).map((line) => {
      if (!line.trim()) return line;
      if (line.startsWith("#")) return line.replace(/URI="([^"]+)"/g, (_match, uri) => `URI="${proxyUrl(resolveUrl(base, uri))}"`);
      return proxyUrl(resolveUrl(base, line.trim()));
    }).join("\n");
    res.writeHead(200, { ...cors, "content-type": "application/vnd.apple.mpegurl", "cache-control": "no-store" });
    return res.end(playlist);
  }

  const headers = { ...cors };
  for (const name of ["content-type", "content-length", "content-range", "accept-ranges"]) {
    const value = upstream.headers.get(name);
    if (value) headers[name] = value;
  }
  if (!headers["accept-ranges"]) headers["accept-ranges"] = "bytes";
  res.writeHead(upstream.status, headers);
  for await (const chunk of upstream.body) {
    if (!res.write(chunk)) await new Promise((resolve) => res.once("drain", resolve));
  }
  res.end();
}

async function handleStream(req, res, requestUrl) {
  const target = requestUrl.searchParams.get("url");
  if (!target || !isAllowedTarget(target)) {
    res.writeHead(400, cors); return res.end("Invalid stream URL");
  }
  return streamUpstream(req, res, target);
}

// Serves the live channel without exposing the provider URL or credentials to viewers.
async function handleLiveStream(req, res) {
  try {
    const channel = await resolveLiveChannel();
    return streamUpstream(req, res, `${LIVE_SERVER}/live/${encodeURIComponent(LIVE_USER)}/${encodeURIComponent(LIVE_PASS)}/${channel.streamId}.ts`);
  } catch (error) {
    console.error("[live] stream failed", error);
    if (!res.headersSent) {
      res.writeHead(502, { ...cors, "content-type": "text/plain", "cache-control": "no-store" });
      res.end("Live channel is temporarily unavailable. Please try again in a moment.");
    }
  }
}

// --- 24/7 live channel page ---
let liveCache = { at: 0, streamId: null, name: null };

async function resolveLiveChannel() {
  if (liveCache.streamId && Date.now() - liveCache.at < 10 * 60 * 1000) return liveCache;
  const streams = await xtreamGet(LIVE_SERVER, LIVE_USER, LIVE_PASS, { action: "get_live_streams" });
  const wanted = LIVE_CHANNEL.toLowerCase();
  const match = streams.find((s) => String(s.name || "").toLowerCase().includes(wanted));
  if (!match) throw new Error("Channel not found");
  liveCache = { at: Date.now(), streamId: String(match.stream_id), name: String(match.name) };
  return liveCache;
}

function livePage(streamUrl, title) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title} — Live</title>
<style>
  * { margin: 0; box-sizing: border-box; }
  html, body { width: 100%; height: 100%; overflow: hidden; }
  body { background: #000; color: #f5f5f7; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
  header { position: fixed; z-index: 2; inset: 0 0 auto; display: grid; grid-template-columns: auto auto minmax(0, 1fr) auto; align-items: center; gap: 10px; padding: max(14px, env(safe-area-inset-top)) max(18px, env(safe-area-inset-right)) 38px max(18px, env(safe-area-inset-left)); background: linear-gradient(to bottom, rgba(0,0,0,.78), transparent); pointer-events: none; }
  .dot { width: 10px; height: 10px; border-radius: 50%; background: #e11d48; box-shadow: 0 0 10px #e11d48; animation: pulse 1.6s infinite; }
  @keyframes pulse { 50% { opacity: .4; } }
  .live-tag { font-size: 12px; font-weight: 700; letter-spacing: .14em; color: #e11d48; }
  h1 { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: clamp(14px, 2vw, 20px); font-weight: 650; }
  .viewers { display: inline-flex; align-items: center; gap: 7px; min-width: 72px; justify-content: flex-end; font-size: 13px; font-weight: 650; color: rgba(255,255,255,.92); }
  .viewers svg { width: 18px; height: 18px; flex: none; }
  main, .stage { width: 100%; height: 100%; }
  .stage { position: relative; background: #000; overflow: hidden; }
  video { width: 100%; height: 100%; object-fit: contain; display: block; }
  @media (max-width: 480px) {
    header { gap: 8px; padding-bottom: 30px; }
    .live-tag { font-size: 11px; }
    .viewers { min-width: 58px; font-size: 12px; }
  }
  @media (prefers-reduced-motion: reduce) { .dot { animation: none; } }
</style>
</head>
<body>
<header><span class="dot"></span><span class="live-tag">LIVE</span><h1>${title}</h1><span class="viewers" aria-label="People watching"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg><span id="viewer-count">1</span></span></header>
<main><div class="stage"><video id="v" controls autoplay muted playsinline></video></div></main>
<script src="https://cdn.jsdelivr.net/npm/mpegts.js@1/dist/mpegts.js"></script>
<script>
  document.addEventListener("contextmenu", function (event) { event.preventDefault(); });
  document.addEventListener("selectstart", function (event) { event.preventDefault(); });
  document.addEventListener("copy", function (event) { event.preventDefault(); });
  document.addEventListener("keydown", function (event) {
    var key = (event.key || "").toLowerCase();
    if (key === "f12" || ((event.ctrlKey || event.metaKey) && event.shiftKey && ["i", "j", "c"].includes(key)) || ((event.ctrlKey || event.metaKey) && ["u", "s"].includes(key))) {
      event.preventDefault();
    }
  });
  function closePage() { document.documentElement.innerHTML = ""; document.body && (document.body.style.background = "#000"); try { window.location.replace("about:blank"); } catch (e) {} }
  setInterval(function () {
    var wide = (window.outerWidth - window.innerWidth > 160) || (window.outerHeight - window.innerHeight > 160);
    var start = Date.now();
    (function () { debugger; })();
    if (wide || Date.now() - start > 120) closePage();
  }, 800);
  var src = ${JSON.stringify(streamUrl)};
  var video = document.getElementById("v");
  var viewerCount = document.getElementById("viewer-count");
  var viewerId = sessionStorage.getItem("live-viewer-id") || (Date.now().toString(36) + Math.random().toString(36).slice(2));
  sessionStorage.setItem("live-viewer-id", viewerId);
  function heartbeat() {
    fetch("/api/public/viewers?id=" + encodeURIComponent(viewerId), { method: "POST", cache: "no-store" })
      .then(function (response) { return response.json(); })
      .then(function (data) { viewerCount.textContent = String(data.count || 1); })
      .catch(function () {});
  }
  heartbeat();
  setInterval(heartbeat, 15000);
  var player = null;
  var lastTime = 0;
  var stuckCount = 0;
  var startedAt = 0;
  var retryTimer = null;
  var retryDelay = 8000;
  var booting = false;
  function scheduleReconnect() {
    if (retryTimer) return;
    retryTimer = setTimeout(function () {
      retryTimer = null;
      boot();
    }, retryDelay);
    retryDelay = Math.min(retryDelay * 2, 30000);
  }
  function boot() {
    if (booting) return;
    booting = true;
    startedAt = Date.now();
    lastTime = 0;
    stuckCount = 0;
    if (player) { try { player.destroy(); } catch (e) {} player = null; }
    var mpegtsFeatures = window.mpegts && typeof mpegts.getFeatureList === "function" ? mpegts.getFeatureList() : null;
    if (window.mpegts && mpegtsFeatures && mpegtsFeatures.mseLivePlayback) {
      player = mpegts.createPlayer(
        { type: "mpegts", isLive: true, url: src },
        {
          enableStashBuffer: true,
          stashInitialSize: 1024 * 1024,
          liveBufferLatencyChasing: false,
          autoCleanupSourceBuffer: true,
          autoCleanupMaxBackwardDuration: 120,
          autoCleanupMinBackwardDuration: 60,
          fixAudioTimestampGap: true,
          lazyLoad: false
        }
      );
      player.attachMediaElement(video);
      player.load();
      player.play().catch(function () {});
      booting = false;
      player.on(mpegts.Events.ERROR, function () {
        scheduleReconnect();
      });
    } else {
      video.src = src;
      video.play().catch(function () {});
      booting = false;
    }
  }
  // Resume accidental pauses without rebuilding a healthy buffered stream.
  video.addEventListener("pause", function () {
    if (!video.ended) setTimeout(function () { video.play().catch(function () {}); }, 1000);
  });
  video.addEventListener("playing", function () {
    retryDelay = 8000;
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
  });
  // Allow a generous startup/buffering window. Reconnect only after a real 30s freeze.
  setInterval(function () {
    if (video.paused) { video.play().catch(function () {}); return; }
    if (Date.now() - startedAt < 45000) return;
    if (video.currentTime === lastTime) {
      stuckCount++;
      if (stuckCount >= 6) { stuckCount = 0; scheduleReconnect(); }
    } else {
      stuckCount = 0;
      lastTime = video.currentTime;
    }
  }, 5000);
  boot();
  document.addEventListener("click", function () { video.muted = false; }, { once: true });
</script>
</body>
</html>`;
}

async function handleLive(_req, res) {
  try {
    const channel = await resolveLiveChannel();
    const html = livePage("/live/stream", LIVE_TITLE);
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(html);
  } catch (error) {
    console.error("[live] failed", error);
    res.writeHead(502, { "content-type": "text/plain" });
    res.end("Live channel is temporarily unavailable. Please try again in a moment.");
  }
}

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (req.method === "OPTIONS") { res.writeHead(204, cors); return res.end(); }
  if ((requestUrl.pathname === "/" || requestUrl.pathname === "/live") && req.method === "GET") return handleLive(req, res);
  if (requestUrl.pathname === "/api/public/viewers" && req.method === "POST") return handleViewerHeartbeat(res, requestUrl);
  if (requestUrl.pathname === "/health") {
    res.writeHead(200, { ...cors, "content-type": "text/plain" }); return res.end("MMN relay is running");
  }
  if (requestUrl.pathname === "/live/stream" && req.method === "GET") return handleLiveStream(req, res);
  if (requestUrl.pathname === "/api/public/stream" && req.method === "GET") return handleStream(req, res, requestUrl);
  if (requestUrl.pathname === "/api/public/xtream" && (req.method === "POST" || req.method === "PUT")) {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    let body = {};
    try { body = JSON.parse(raw || "{}"); } catch { res.writeHead(400, cors); return res.end("Invalid JSON"); }
    return req.method === "POST" ? handleXtreamPost(req, res, body) : handleXtreamPut(res, body);
  }
  res.writeHead(404, cors); res.end("Not found");
});

server.listen(PORT, () => console.log(`MMN relay listening on port ${PORT}`));
