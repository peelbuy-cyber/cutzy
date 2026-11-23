/* Cutzy — all cutout work happens ON-DEVICE via @imgly/background-removal.
   No API keys, no uploads, no servers. First run downloads the AI model once (~40 MB),
   then everything works offline. */
import { removeBackground, preload } from "https://cdn.jsdelivr.net/npm/@imgly/background-removal@1/+esm";

const $ = (id) => document.getElementById(id);
const els = {
  dropzone: $("dropzone"), fileInput: $("fileInput"), cameraBtn: $("cameraBtn"), cameraInput: $("cameraInput"),
  progressCard: $("progressCard"), procBar: $("procBar"), procPct: $("procPct"),
  resultCard: $("resultCard"), imgBefore: $("imgBefore"), imgAfter: $("imgAfter"),
  afterLayer: $("afterLayer"), compareRange: $("compareRange"), compareWrap: document.querySelector(".compare-wrap"),
  compareGrip: $("compareGrip"),
  bgChips: [...document.querySelectorAll(".bg-chip")], bgColor: $("bgColor"), colorSwatch: $("colorSwatch"),
  shadowBtn: $("shadowBtn"),
  downloadBtn: $("downloadBtn"), shareBtn: $("shareBtn"), refineBtn: $("refineBtn"), newBtn: $("newBtn"),
  modelNote: $("modelNote"), procNote: document.querySelector("#progressCard .proc-note"),
  refineCard: $("refineCard"), refineCanvas: $("refineCanvas"),
  modelStatus: $("modelStatus"),
  eraseMode: $("eraseMode"), keepMode: $("keepMode"),
  brushSize: $("brushSize"), brushSizeVal: $("brushSizeVal"),
  undoStroke: $("undoStroke"), refineDone: $("refineDone"), refineCancel: $("refineCancel"),
  compareStage: document.querySelector(".compare-wrap"), bgRow: document.querySelector(".bg-row"), actionsRow: document.querySelector(".actions"),
};

const state = { origURL: null, origBitmap: null, resultURL: null, resultBlob: null, bg: "checker", color: "#6d28d9", w: 0, h: 0, shadow: false };

/* ---------- no install: Cutzy is a plain website, not an app ----------
   Earlier versions registered a service worker — which also made the browser
   offer to install it — and cached the page, so returning visitors kept
   getting old versions. Remove any service worker left by those versions so
   the site always loads fresh from the web. */
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.getRegistrations().then((rs) => rs.forEach((r) => r.unregister())).catch(() => {});
}

/* ---------- speed: small quantized model + WebGPU when available ----------
   The default was isnet_fp16 (~80 MB, WASM CPU) — minutes on phones.
   isnet_quint8 is ~40 MB and int8 inference is faster; device 'gpu' uses
   WebGPU where the browser has a REAL GPU (Chrome/Edge desktop + Android,
   Safari 26+), falling back to CPU otherwise. The adapter is actually
   requested — 'gpu' merely existing in the browser is not proof — and a
   SwiftShader software adapter counts as no GPU (it is slower than CPU).
   The model is preloaded in the background on page load so the first
   cutout doesn't wait for the download. */
const bgConfig = {
  model: "isnet_quint8",
  device: "cpu", // switched to 'gpu' only after a real WebGPU adapter is confirmed
};
const warmModel = async () => {
  if ("gpu" in navigator) {
    try {
      const adapter = await navigator.gpu.requestAdapter();
      const dev = String(adapter?.info?.device || "").toLowerCase();
      if (adapter && !dev.includes("swiftshader")) bgConfig.device = "gpu";
    } catch { /* stays on CPU */ }
  }
  preload(bgConfig).then(() => {
    if (els.modelStatus) els.modelStatus.textContent = "AI ready — cutouts run in seconds.";
  }).catch(() => { /* first upload downloads it instead */ });
};
if ("requestIdleCallback" in window) requestIdleCallback(warmModel, { timeout: 3000 });
else setTimeout(warmModel, 1500);

/* ---------- input: tap / camera / drag-drop / paste ---------- */
els.dropzone.addEventListener("click", (e) => { if (!e.target.closest("#cameraBtn")) els.fileInput.click(); });
els.dropzone.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") els.fileInput.click(); });
els.fileInput.addEventListener("change", (e) => e.target.files[0] && handleFile(e.target.files[0]));
els.cameraBtn.addEventListener("click", (e) => { e.stopPropagation(); els.cameraInput.click(); });
els.cameraInput.addEventListener("change", (e) => e.target.files[0] && handleFile(e.target.files[0]));
["dragover", "dragenter"].forEach((ev) => els.dropzone.addEventListener(ev, (e) => { e.preventDefault(); els.dropzone.style.borderColor = "#7c3aed"; }));
["dragleave", "drop"].forEach((ev) => els.dropzone.addEventListener(ev, (e) => { e.preventDefault(); els.dropzone.style.borderColor = ""; }));
els.dropzone.addEventListener("drop", (e) => { const f = e.dataTransfer.files[0]; if (f) handleFile(f); });
window.addEventListener("paste", (e) => { const f = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith("image/"))?.getAsFile(); if (f) handleFile(f); });

/* Decode any image file to something drawImage accepts. createImageBitmap
   is fast but REJECTS SVGs with no intrinsic size (the sample files had
   only a viewBox) — fall back to an <img> element, which renders them fine. */
async function decodeImage(file) {
  try {
    return await createImageBitmap(file);
  } catch {
    const url = URL.createObjectURL(file);
    try {
      return await new Promise((resolve, reject) => {
        const im = new Image();
        im.onload = () => resolve(im);
        im.onerror = () => reject(new Error("img decode failed"));
        im.src = url;
      });
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}

/* ---------- main pipeline ---------- */
async function handleFile(file) {
  if (!file.type.startsWith("image/")) { alert("Please choose an image file."); return; }
  resetUI();
  els.procBar.classList.remove("working");
  els.procNote.textContent = "First run downloads the AI model once (~40 MB). After that, cutouts run on your device and your photos never leave this phone.";
  els.dropzone.classList.add("hidden");
  els.progressCard.classList.remove("hidden");
  setProgress(2, "Loading image…");

  // The progress UI must never sit dead at 2%: start the clock NOW, before
  // any slow step (photo decode, model session, inference). If nothing
  // reports download progress within 2s, switch to the visibly-alive
  // inference state with a live seconds counter — and after 2 minutes say
  // plainly that this device is slow at this step, instead of hanging silently.
  const t0 = performance.now();
  let seen = 0;
  let inferTimer = null;
  let inferFallback = null;
  let slowNoteShown = false;
  const stopInferTimer = () => { if (inferTimer) { clearInterval(inferTimer); inferTimer = null; } if (inferFallback) { clearTimeout(inferFallback); inferFallback = null; } };
  const startInferencePhase = () => {
    if (inferTimer) return;
    els.procBar.classList.add("working");
    els.procPct.parentElement.firstChild.textContent = "Removing background… ";
    els.procNote.textContent = "Model downloaded — now cutting out. Big photos can take a minute or two; keep this tab open.";
    // No live progress comes back during the cutout itself, so animate the
    // bar 1%→99% on a slowing curve (fast at first, easing near 99%) and
    // show the percentage, not seconds. It only hits 100% when the real
    // result lands.
    const inferStart = performance.now();
    const startPct = Math.max(seen, 2);
    inferTimer = setInterval(() => {
      const el = (performance.now() - inferStart) / 1000;
      const pct = Math.min(99, startPct + (99 - startPct) * (1 - Math.exp(-el / 8)));
      els.procBar.style.width = pct + "%";
      els.procPct.textContent = Math.floor(pct) + "%";
      const s = Math.floor((performance.now() - t0) / 1000);
      if (s > 120 && !slowNoteShown) { slowNoteShown = true; els.procNote.textContent = "Still working — this device is slow at this step. Keep waiting, or try a smaller photo."; }
    }, 100);
  };
  inferFallback = setTimeout(() => { if (seen === 0) startInferencePhase(); }, 2000);

  // Downscale huge photos so phones stay fast (max 1024px side — the model
  // works at 1024 internally, so bigger inputs only cost time, not quality)
  let w = 0, h = 0, workBlob = null;
  try {
    const bitmap = await decodeImage(file);
    const iw = bitmap.naturalWidth || bitmap.width, ih = bitmap.naturalHeight || bitmap.height;
    const scale = Math.min(1, 1024 / Math.max(iw, ih));
    w = Math.round(iw * scale); h = Math.round(ih * scale);
    const c = document.createElement("canvas"); c.width = w; c.height = h;
    c.getContext("2d").drawImage(bitmap, 0, 0, w, h);
    workBlob = await new Promise((r) => c.toBlob(r, "image/png"));
    Object.assign(state, { origBitmap: bitmap, w, h });
    state.origURL = URL.createObjectURL(file);
    els.imgBefore.src = state.origURL;
  } catch {
    stopInferTimer();
    alert("That photo couldn't be read — try another photo.");
    els.progressCard.classList.add("hidden");
    els.dropzone.classList.remove("hidden");
    return;
  }
  try {
    const out = await removeBackground(workBlob, {
      ...bgConfig,
      progress: (_key, current, total) => {
        if (total > 0 && !inferTimer) {
          seen = Math.max(seen, (current / total) * 100);
          if (seen >= 100) startInferencePhase();
          else setProgress(Math.min(seen, 99), "Downloading AI model…");
        }
      },
    });
    stopInferTimer();
    state.resultBlob = out;
    state.resultURL = URL.createObjectURL(out);
    els.imgAfter.src = state.resultURL;
    els.imgAfter.onload = syncCompare;
    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    els.modelNote.textContent = `Processed 100% on this device · ${w}×${h}px · ${secs}s · nothing was uploaded.`;
  } catch (err) {
    stopInferTimer();
    console.error(err);
    alert("Cutzy failed — check your connection on first run (the AI model downloads once), then try again.");
    els.progressCard.classList.add("hidden");
    els.dropzone.classList.remove("hidden");
    return;
  }
  els.progressCard.classList.add("hidden");
  els.resultCard.classList.remove("hidden");
  syncCompare();
}

function setProgress(pct, label) {
  els.procBar.style.width = Math.min(100, pct) + "%";
  els.procPct.textContent = Math.round(Math.min(100, pct)) + "%";
  if (label) els.procPct.parentElement.firstChild.textContent = label + " ";
}
function resetUI() {
  ["origURL", "resultURL"].forEach((k) => state[k] && URL.revokeObjectURL(state[k]));
  Object.assign(state, { origURL: null, resultURL: null, resultBlob: null, shadow: false });
  els.imgAfter.style.filter = "";
  els.shadowBtn.classList.remove("active");
  els.shadowBtn.setAttribute("aria-pressed", "false");
  els.resultCard.classList.add("hidden");
}

/* ---------- before / after slider ---------- */
function syncCompare() {
  els.afterLayer.style.width = els.compareRange.value + "%";
  els.compareGrip.style.left = els.compareRange.value + "%";
  els.imgAfter.style.width = els.compareWrap.clientWidth + "px"; // keep layers aligned
  els.imgAfter.style.maxWidth = "none";
}
els.compareRange.addEventListener("input", syncCompare);
window.addEventListener("resize", () => !els.resultCard.classList.contains("hidden") && syncCompare());

/* ---------- background picker ---------- */
els.bgChips.forEach((chip) => chip.addEventListener("click", () => {
  els.bgChips.forEach((c) => c.classList.remove("active"));
  chip.classList.add("active");
  state.bg = chip.dataset.bg || "color";
  paintPreviewBg();
}));
els.bgColor.addEventListener("input", (e) => { state.color = e.target.value; els.colorSwatch.style.background = state.color; paintPreviewBg(); });

/* ---------- shadow effect (preview + download) ---------- */
els.shadowBtn.addEventListener("click", () => {
  state.shadow = !state.shadow;
  els.imgAfter.style.filter = state.shadow ? "drop-shadow(0 14px 18px rgba(0,0,0,.35))" : "";
  els.shadowBtn.classList.toggle("active", state.shadow);
  els.shadowBtn.setAttribute("aria-pressed", String(state.shadow));
});

function paintPreviewBg() {
  // Preview: checkerboard shows transparency; other modes tint the preview layer.
  const layer = els.afterLayer;
  layer.style.background = "";
  if (state.bg === "white") layer.style.background = "#fff";
  else if (state.bg === "black") layer.style.background = "#000";
  else if (state.bg === "color") layer.style.background = state.color;
  else if (state.bg === "blur" && state.origBitmap) {
    const c = document.createElement("canvas"); c.width = 32; c.height = 32;
    const x = c.getContext("2d"); x.filter = "blur(2px)";
    x.drawImage(state.origBitmap, 0, 0, 32, 32);
    layer.style.background = `center/cover url(${c.toDataURL()})`;
  }
}

/* ---------- export: composite result over chosen background ---------- */
async function compositeCanvas(scaleTo = null) {
  const W = scaleTo || state.w, H = scaleTo ? Math.round((state.h / state.w) * scaleTo) : state.h;
  const c = document.createElement("canvas"); c.width = W; c.height = H;
  const x = c.getContext("2d");
  if (state.bg === "white" || (state.bg === "checker")) { if (state.bg === "white") { x.fillStyle = "#fff"; x.fillRect(0, 0, W, H); } }
  else if (state.bg === "black") { x.fillStyle = "#000"; x.fillRect(0, 0, W, H); }
  else if (state.bg === "color") { x.fillStyle = state.color; x.fillRect(0, 0, W, H); }
  else if (state.bg === "blur" && state.origBitmap) {
    x.filter = "blur(30px) brightness(0.9)"; x.drawImage(state.origBitmap, -W * 0.1, -H * 0.1, W * 1.2, H * 1.2); x.filter = "none";
  }
  const img = await createImageBitmap(state.resultBlob);
  if (state.shadow) {
    x.save();
    x.shadowColor = "rgba(0,0,0,.35)"; x.shadowBlur = Math.round(W * 0.02); x.shadowOffsetY = Math.round(H * 0.012);
    x.drawImage(img, 0, 0, W, H);
    x.restore();
  } else {
    x.drawImage(img, 0, 0, W, H);
  }
  return c;
}

els.downloadBtn.onclick = async () => {
  const blob = await new Promise((r) => compositeCanvas().then((c) => c.toBlob(r, "image/png")));
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = "cutzy.png"; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
};

/* ---------- viral loop: before/after share card ---------- */
els.shareBtn.onclick = async () => {
  const W = 1080, H = 1350;
  const c = document.createElement("canvas"); c.width = W; c.height = H;
  const x = c.getContext("2d");
  const g = x.createLinearGradient(0, 0, W, H); g.addColorStop(0, "#1b1440"); g.addColorStop(1, "#0f0d1a");
  x.fillStyle = g; x.fillRect(0, 0, W, H);
  x.fillStyle = "#fff"; x.font = "800 64px system-ui"; x.textAlign = "center";
  x.fillText("✂ Cutzy", W / 2, 110);
  x.fillStyle = "#a89fd1"; x.font = "400 34px system-ui";
  x.fillText("free background remover · no watermark", W / 2, 165);

  const drawContain = async (blob, dx, dy, dw, dh, white) => {
    const img = await createImageBitmap(blob);
    if (white) { x.fillStyle = "#fff"; x.fillRect(dx, dy, dw, dh); }
    const s = Math.min(dw / img.width, dh / img.height);
    const iw = img.width * s, ih = img.height * s;
    x.drawImage(img, dx + (dw - iw) / 2, dy + (dh - ih) / 2, iw, ih);
  };
  const workBlob = await new Promise((r) => { const cc = document.createElement("canvas"); cc.width = state.w; cc.height = state.h; cc.getContext("2d").drawImage(state.origBitmap, 0, 0, state.w, state.h); cc.toBlob(r, "image/png"); });
  x.fillStyle = "#fff"; x.font = "700 40px system-ui"; x.textAlign = "left";
  x.fillText("BEFORE", 60, 250); x.fillText("AFTER", 60, 800);
  await drawContain(workBlob, 60, 275, W - 120, 480, false);
  await drawContain(state.resultBlob, 60, 825, W - 120, 380, true);

  const blob = await new Promise((r) => c.toBlob(r, "image/png"));
  const file = new File([blob], "cutzy-card.png", { type: "image/png" });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: "Cutzy before/after" }); return; } catch { /* dismissed */ }
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = "cutzy-card.png"; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
};

els.newBtn.onclick = () => { resetUI(); els.dropzone.classList.remove("hidden"); };
/* ---------- manual refine: edge touch-up brush ----------
   The AI model is weakest on hair, fur and glass — exactly the weak spots
   BGone's own author admits. Erase cuts pixels out; Restore paints the
   original photo back in. Soft-edged brush, full undo, all on-device. */
const refine = {
  canvas: null, ctx: null, orig: null, stamp: null,
  undo: [], mode: "erase", size: 32, painting: false, last: null,
};

els.refineBtn.onclick = enterRefine;
els.eraseMode.onclick = () => setRefineMode("erase");
els.keepMode.onclick = () => setRefineMode("keep");
els.brushSize.addEventListener("input", (e) => {
  refine.size = +e.target.value;
  els.brushSizeVal.textContent = refine.size + "px";
  buildStamp();
});
els.undoStroke.onclick = () => { if (refine.undo.length > 1) { refine.undo.pop(); refine.ctx.putImageData(refine.undo[refine.undo.length - 1], 0, 0); redrawRefine(); } };
els.refineCancel.onclick = exitRefine;
els.refineDone.onclick = applyRefine;

function setRefineMode(m) {
  refine.mode = m;
  els.eraseMode.classList.toggle("active", m === "erase");
  els.keepMode.classList.toggle("active", m === "keep");
}

/* Soft round brush stamp, rebuilt whenever the size changes */
function buildStamp() {
  const d = Math.max(4, refine.size * 2);
  const c = document.createElement("canvas"); c.width = c.height = d;
  const x = c.getContext("2d");
  const g = x.createRadialGradient(d / 2, d / 2, 0, d / 2, d / 2, d / 2);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.7, "rgba(255,255,255,0.9)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  x.fillStyle = g; x.fillRect(0, 0, d, d);
  refine.stamp = c;
}

function pushUndo() {
  try {
    refine.undo.push(refine.ctx.getImageData(0, 0, refine.canvas.width, refine.canvas.height));
    if (refine.undo.length > 25) refine.undo.shift();
  } catch { /* canvas too big for snapshot — undo stays limited */ }
}

async function enterRefine() {
  if (!state.resultBlob) return;
  // working copy at the processed resolution
  const img = await createImageBitmap(state.resultBlob);
  const c = document.createElement("canvas"); c.width = state.w; c.height = state.h;
  const ctx = c.getContext("2d"); ctx.drawImage(img, 0, 0);
  // downscaled original photo: the source Restore paints back in
  const o = document.createElement("canvas"); o.width = state.w; o.height = state.h;
  o.getContext("2d").drawImage(state.origBitmap, 0, 0, state.w, state.h);
  Object.assign(refine, { canvas: c, ctx, orig: o, undo: [], painting: false, last: null });
  buildStamp(); pushUndo();
  els.refineCanvas.width = state.w; els.refineCanvas.height = state.h;
  redrawRefine();
  setRefineMode("erase");
  els.refineCard.classList.remove("hidden");
  els.compareStage.classList.add("hidden");
  els.bgRow.classList.add("hidden");
  els.actionsRow.classList.add("hidden");
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function exitRefine() {
  els.refineCard.classList.add("hidden");
  els.compareStage.classList.remove("hidden");
  els.bgRow.classList.remove("hidden");
  els.actionsRow.classList.remove("hidden");
  refine.painting = false;
}

function redrawRefine() {
  const x = els.refineCanvas.getContext("2d");
  x.clearRect(0, 0, els.refineCanvas.width, els.refineCanvas.height);
  x.drawImage(refine.canvas, 0, 0);
}

function refinePoint(e) {
  const r = els.refineCanvas.getBoundingClientRect();
  return {
    x: (e.clientX - r.left) / r.width * refine.canvas.width,
    y: (e.clientY - r.top) / r.height * refine.canvas.height,
  };
}

function dab(px, py) {
  const r = refine.size, d = r * 2;
  if (refine.mode === "erase") {
    refine.ctx.save();
    refine.ctx.globalCompositeOperation = "destination-out";
    refine.ctx.drawImage(refine.stamp, px - r, py - r, d, d);
    refine.ctx.restore();
  } else {
    // restore: original photo pixels, masked by the soft brush
    const t = document.createElement("canvas"); t.width = t.height = d;
    const tx = t.getContext("2d");
    tx.drawImage(refine.orig, px - r, py - r, d, d, 0, 0, d, d);
    tx.globalCompositeOperation = "destination-in";
    tx.drawImage(refine.stamp, 0, 0, d, d);
    refine.ctx.drawImage(t, px - r, py - r, d, d);
  }
  redrawRefine();
}

els.refineCanvas.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  refine.painting = true;
  pushUndo();
  const p = refinePoint(e);
  refine.last = p;
  dab(p.x, p.y);
  try { els.refineCanvas.setPointerCapture(e.pointerId); } catch { /* older browsers */ }
});
els.refineCanvas.addEventListener("pointermove", (e) => {
  if (!refine.painting) return;
  const p = refinePoint(e);
  // interpolate between last and current so fast strokes stay solid
  const dx = p.x - refine.last.x, dy = p.y - refine.last.y;
  const dist = Math.hypot(dx, dy), step = Math.max(1, refine.size / 3);
  for (let s = step; s < dist; s += step) dab(refine.last.x + dx * s / dist, refine.last.y + dy * s / dist);
  dab(p.x, p.y);
  refine.last = p;
});
["pointerup", "pointercancel", "pointerleave"].forEach((ev) =>
  els.refineCanvas.addEventListener(ev, () => { refine.painting = false; refine.last = null; })
);

async function applyRefine() {
  const blob = await new Promise((r) => refine.canvas.toBlob(r, "image/png"));
  if (blob) {
    state.resultURL && URL.revokeObjectURL(state.resultURL);
    state.resultBlob = blob;
    state.resultURL = URL.createObjectURL(blob);
    els.imgAfter.src = state.resultURL;
    els.imgAfter.onload = syncCompare;
    syncCompare();
  }
  exitRefine();
}

/* Landing-page samples: fetch a sample image and run the cutout on it. */
window.cutzySample = async (url) => {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error("sample fetch failed");
    const blob = await res.blob();
    handleFile(new File([blob], "sample.svg", { type: blob.type || "image/svg+xml" }));
    document.getElementById("tool")?.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch {
    alert("Couldn't load that sample — try uploading your own photo.");
  }
};
