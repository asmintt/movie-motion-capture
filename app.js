// ムービー・モーションキャプチャ
// 練習動画から先生と初心者の骨格を検出し、骨格つき動画（MP4）と骨格データ（CSV）を書き出す。
// 処理はすべてブラウザの中で行い、動画はどこにも送らない。
import { PoseLandmarker, FaceLandmarker } from './lib/vision_bundle.mjs';
import { Muxer, ArrayBufferTarget } from './lib/mp4-muxer.mjs';

const APP_VERSION = 'v1';
const MEDIAPIPE_VERSION = 'tasks-vision 0.10.14';

const $ = (id) => document.getElementById(id);

// 動画に焼き込む色（画面のテーマに関係なく固定）
const COLOR = { teacher: '#3D7BFF', beginner: '#FF7A1A', low: 'rgba(190,198,207,0.75)', other: 'rgba(255,255,255,0.85)' };
const VIS_MIN = 0.5;   // これ未満の点は「AIの自信が低い」として灰色で描く
const SPEED_LABEL = { 0.25: '1/4倍速', 0.5: '1/2倍速', 1: '等倍' };

// 骨格AIの33点のあとに、頭の2点を足して持つ
//   33 顎先：顔用AI（Face Landmarker）の顎先の点
//   34 頭頂部：顎先と額の上端から推定（AIの点ではない）
// 顔用AIが顔を見つけられないコマは、骨格AIの目と口から両方を推定し、自信を 0.4（灰色）にする
const CHIN = 33, HEAD_TOP = 34, NPTS = 35;
const HEAD_TOP_RATIO = 1.3; // 顎先→額の上端 の長さを1.3倍すると、おおよそ頭頂部に届く
const ESTIMATED_VIS = 0.4;

// CSVに書き出す点
const POINTS = {
  head_top: HEAD_TOP, chin: CHIN,
  nose: 0, left_ear: 7, right_ear: 8,
  left_shoulder: 11, right_shoulder: 12, left_elbow: 13, right_elbow: 14, left_wrist: 15, right_wrist: 16,
  left_hip: 23, right_hip: 24, left_knee: 25, right_knee: 26, left_ankle: 27, right_ankle: 28,
  left_heel: 29, right_heel: 30, left_foot_index: 31, right_foot_index: 32,
};
const BONES = [
  [11, 12], [11, 13], [13, 15], [12, 14], [14, 16],
  [11, 23], [12, 24], [23, 24],
  [23, 25], [25, 27], [24, 26], [26, 28],
  [27, 29], [29, 31], [27, 31], [28, 30], [30, 32], [28, 32],
];
// 丸を描く点。31・32 はAIの「つま先」（foot_index）で、靴の先にあたる
const JOINTS = [11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28, 31, 32];

const state = {
  file: null, name: '', url: null,
  duration: 0, vw: 0, vh: 0, outW: 0, outH: 0,
  start: 0, end: 0, speed: 0.5, model: 'full', fps: 30,
  landmarker: null, landmarkerModel: null, delegate: '', face: null,
  pickPoses: [], pickOriginal: [], teacherIdx: null, beginnerIdx: null, edited: false,
  frames: [],   // { t, A, B }  A = 最初に先生として選んだ人、B = 最初に初心者として選んだ人
  swaps: [],    // 役割を入れ替えた時刻（秒）
  videoBlob: null, csvBlob: null,
  busy: false,
};
window.__mmc = state; // 動作確認用

const video = $('video');     // 解析用（画面には出さない）
const preview = $('preview'); // 設定用のプレビュー

// ---------- 画面の状態 ----------
const STEPS = ['step-file', 'step-settings', 'step-pick', 'step-analyze', 'step-review', 'step-export'];
function setStep(id, s) { $(id).dataset.state = s; }
function lockFrom(id) {
  for (const s of STEPS.slice(STEPS.indexOf(id))) setStep(s, 'locked');
}
function message(id, text, isError = false) {
  const el = $(id);
  el.textContent = text;
  el.classList.toggle('error', isError);
}
const nextPaint = () => new Promise((r) => requestAnimationFrame(() => r()));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let wakeLock = null;
async function keepAwake(on) {
  try {
    if (on && 'wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
    if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch { /* 使えない端末では何もしない */ }
}

// ---------- 動画 ----------
function once(el, ok, ng = 'error', ms = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { clean(); reject(new Error('timeout')); }, ms);
    const onOk = () => { clean(); resolve(); };
    const onNg = () => { clean(); reject(new Error(ng)); };
    function clean() { clearTimeout(timer); el.removeEventListener(ok, onOk); el.removeEventListener(ng, onNg); }
    el.addEventListener(ok, onOk);
    el.addEventListener(ng, onNg);
  });
}

// 指定の時刻へ移動し、そのコマが描ける状態になるまで待つ
function seekTo(v, t) {
  return new Promise((resolve) => {
    let finished = false;
    const finish = () => { if (!finished) { finished = true; v.removeEventListener('seeked', onSeeked); clearTimeout(guard); resolve(); } };
    const onSeeked = () => {
      if (v.requestVideoFrameCallback) {
        v.requestVideoFrameCallback(() => finish());
        setTimeout(finish, 150);
      } else {
        finish();
      }
    };
    const guard = setTimeout(finish, 4000);
    v.addEventListener('seeked', onSeeked);
    v.currentTime = Math.max(0, Math.min(t, v.duration - 0.001));
  });
}

async function handleFile(file) {
  if (!file) return;
  stopReview();
  state.file = file;
  state.name = file.name || 'video';
  if (state.url) URL.revokeObjectURL(state.url);
  state.url = URL.createObjectURL(file);
  lockFrom('step-settings');
  message('file-info', '動画を読み込んでいます…');
  try {
    video.src = state.url;
    preview.src = state.url;
    video.load();
    await once(video, 'loadeddata');
  } catch {
    message('file-info', 'この動画は開けませんでした。別の動画を選んでください。', true);
    return;
  }
  state.duration = video.duration;
  state.vw = video.videoWidth;
  state.vh = video.videoHeight;
  // 書き出しサイズ：短い辺を最大720、長い辺を最大1280に縮める（偶数にそろえる）
  const scale = Math.min(1, 720 / Math.min(state.vw, state.vh), 1280 / Math.max(state.vw, state.vh));
  state.outW = Math.max(2, Math.round(state.vw * scale / 2) * 2);
  state.outH = Math.max(2, Math.round(state.vh * scale / 2) * 2);

  $('start').value = '0';
  $('end').value = (Math.floor(state.duration * 10) / 10).toFixed(1);
  $('start').max = $('end').max = state.duration.toFixed(1);
  const long = state.duration > 60 ? '　1分を超えています。解析する範囲を短くするのがおすすめです。' : '';
  message('file-info', `${state.name}（${state.duration.toFixed(1)}秒・${state.vw}×${state.vh}）${long}`);
  setStep('step-file', 'done');
  setStep('step-settings', 'active');
}

$('file').addEventListener('change', (e) => handleFile(e.target.files[0]));
$('start-here').addEventListener('click', () => { $('start').value = preview.currentTime.toFixed(1); invalidate(); });
$('end-here').addEventListener('click', () => { $('end').value = preview.currentTime.toFixed(1); invalidate(); });
for (const id of ['start', 'end', 'speed', 'model', 'fps']) $(id).addEventListener('change', invalidate);

// 設定を変えたら、それより後のステップはやり直し
function invalidate() {
  if (state.busy) return;
  if ($('step-pick').dataset.state !== 'locked') {
    stopReview();
    lockFrom('step-pick');
    setStep('step-settings', 'active');
  }
}

function readSettings() {
  const start = Number($('start').value);
  const end = Number($('end').value);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end > state.duration + 0.05 || end - start < 0.5) {
    throw new Error(`開始と終了は 0〜${state.duration.toFixed(1)} 秒の間で、0.5秒以上あけてください。`);
  }
  state.start = start;
  state.end = Math.min(end, state.duration);
  state.speed = Number($('speed').value);
  state.model = $('model').value;
  state.fps = Number($('fps').value);
}

// ---------- 骨格検出（MediaPipe Pose） ----------
const asset = (p) => new URL(p, location.href).href;

async function getLandmarker(model, forceCpu = false) {
  if (state.landmarker && state.landmarkerModel === model && !forceCpu) return state.landmarker;
  state.landmarker?.close();
  state.landmarker = null;
  const fileset = {
    wasmLoaderPath: asset('lib/wasm/vision_wasm_internal.js'),
    wasmBinaryPath: asset('lib/wasm/vision_wasm_internal.wasm'),
  };
  const options = (delegate) => ({
    baseOptions: { modelAssetPath: asset(`lib/models/pose_landmarker_${model}.task`), delegate },
    runningMode: 'IMAGE', // 切り出す範囲が毎回変わるので、コマごとに独立して検出する
    numPoses: 2,
    minPoseDetectionConfidence: 0.4,
    minPosePresenceConfidence: 0.4,
    minTrackingConfidence: 0.4,
  });
  let lm = null;
  if (!forceCpu) {
    try { lm = await PoseLandmarker.createFromOptions(fileset, options('GPU')); state.delegate = 'GPU'; } catch { lm = null; }
  }
  if (!lm) { lm = await PoseLandmarker.createFromOptions(fileset, options('CPU')); state.delegate = 'CPU'; }
  state.landmarker = lm;
  state.landmarkerModel = model;
  return lm;
}

// 1人分の点を [x, y, 自信] ×35 の配列にまとめる（x, y は 0〜1）。頭の2点はあとで addHead が埋める
function pack(landmarks) {
  const a = new Float32Array(NPTS * 3);
  landmarks.forEach((p, i) => { a[i * 3] = p.x; a[i * 3 + 1] = p.y; a[i * 3 + 2] = p.visibility ?? 1; });
  return a;
}

// ---------- 顔（顎先・頭頂部） ----------
async function getFaceLandmarker() {
  if (state.face) return state.face;
  const fileset = {
    wasmLoaderPath: asset('lib/wasm/vision_wasm_internal.js'),
    wasmBinaryPath: asset('lib/wasm/vision_wasm_internal.wasm'),
  };
  const options = (delegate) => ({
    baseOptions: { modelAssetPath: asset('lib/models/face_landmarker.task'), delegate },
    runningMode: 'IMAGE',
    numFaces: 1,
    minFaceDetectionConfidence: 0.3,
    minFacePresenceConfidence: 0.3,
  });
  try { state.face = await FaceLandmarker.createFromOptions(fileset, options('GPU')); } catch { state.face = null; }
  if (!state.face) state.face = await FaceLandmarker.createFromOptions(fileset, options('CPU'));
  return state.face;
}

const FACE = 256;
const faceCanvas = document.createElement('canvas');
faceCanvas.width = faceCanvas.height = FACE;

// 顔用AIが顔を見つけられないときの推定。目の真ん中 e → 口の真ん中 m を u とし、
// u とそれに直交する向き n を物差しにして、顎先は m から、頭頂部は e からの位置で表す。
// 最初は大人の顔の一般的な比率を使い、解析後にその人の「顔が見つかったコマ」から測った比率で直す
const HEAD_RATIO_DEFAULT = { ca: 0.7, cb: 0, ta: -1.65, tb: 0 };

function faceFrame(p) {
  const P = (i) => px(p, i);
  if (Math.min(P(2).v, P(5).v, P(9).v, P(10).v) < 0.3) return null;
  const e = { x: (P(2).x + P(5).x) / 2, y: (P(2).y + P(5).y) / 2 };
  const m = { x: (P(9).x + P(10).x) / 2, y: (P(9).y + P(10).y) / 2 };
  const u = { x: m.x - e.x, y: m.y - e.y };
  if (Math.hypot(u.x, u.y) < 1) return null;
  return { e, m, u, n: { x: -u.y, y: u.x } };
}

function estimateHead(p, k = HEAD_RATIO_DEFAULT) {
  const f = faceFrame(p);
  if (!f) return;
  const { e, m, u, n } = f;
  p[CHIN * 3] = (m.x + u.x * k.ca + n.x * k.cb) / state.vw;
  p[CHIN * 3 + 1] = (m.y + u.y * k.ca + n.y * k.cb) / state.vh;
  p[HEAD_TOP * 3] = (e.x + u.x * k.ta + n.x * k.tb) / state.vw;
  p[HEAD_TOP * 3 + 1] = (e.y + u.y * k.ta + n.y * k.tb) / state.vh;
  p[CHIN * 3 + 2] = p[HEAD_TOP * 3 + 2] = ESTIMATED_VIS;
}

// 同じ人の「顔が見つかったコマ」から比率を測り（中央値）、推定したコマを測った比率で直す
function calibrateHeads(role) {
  const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  const samples = { ca: [], cb: [], ta: [], tb: [] };
  for (const fr of state.frames) {
    const p = fr[role];
    if (!p || p[CHIN * 3 + 2] < 0.99) continue;
    const f = faceFrame(p);
    if (!f) continue;
    const L = f.u.x ** 2 + f.u.y ** 2;
    const c = { x: p[CHIN * 3] * state.vw - f.m.x, y: p[CHIN * 3 + 1] * state.vh - f.m.y };
    const t = { x: p[HEAD_TOP * 3] * state.vw - f.e.x, y: p[HEAD_TOP * 3 + 1] * state.vh - f.e.y };
    samples.ca.push((c.x * f.u.x + c.y * f.u.y) / L); samples.cb.push((c.x * f.n.x + c.y * f.n.y) / L);
    samples.ta.push((t.x * f.u.x + t.y * f.u.y) / L); samples.tb.push((t.x * f.n.x + t.y * f.n.y) / L);
  }
  if (samples.ca.length < 5) return null; // 顔が見つかったコマが少なすぎるときは一般的な比率のまま
  const k = { ca: median(samples.ca), cb: median(samples.cb), ta: median(samples.ta), tb: median(samples.tb) };
  for (const fr of state.frames) {
    const p = fr[role];
    if (p && Math.abs(p[CHIN * 3 + 2] - ESTIMATED_VIS) < 1e-3) estimateHead(p, k);
  }
  return samples.ca.length;
}

// 骨格の鼻・耳の位置から顔のまわりを切り出し、顔用AIで顎先と額の上端を探す
async function addHead(p) {
  const P = (i) => px(p, i);
  p[CHIN * 3 + 2] = p[HEAD_TOP * 3 + 2] = 0;
  const nose = P(0);
  if (nose.v < 0.3 || !state.face) { estimateHead(p); return p; }

  const ear = Math.hypot(P(7).x - P(8).x, P(7).y - P(8).y);
  const shoulder = Math.hypot(P(11).x - P(12).x, P(11).y - P(12).y);
  const side = Math.max(ear * 2.6, shoulder * 0.8, 40);
  const x0 = nose.x - side / 2, y0 = nose.y - side * 0.55;
  const ctx = faceCanvas.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, FACE, FACE);
  ctx.drawImage(video, x0, y0, side, side, 0, 0, FACE, FACE);
  let lm;
  try { lm = state.face.detect(faceCanvas).faceLandmarks[0]; } catch { lm = null; }
  if (!lm) { estimateHead(p); return p; }
  const toFrame = (q) => ({ x: (x0 + q.x * side) / state.vw, y: (y0 + q.y * side) / state.vh });
  const chin = toFrame(lm[152]), brow = toFrame(lm[10]); // 152 = 顎先、10 = 額の上端
  // 見つけた顔が、この人の鼻の近くでなければ使わない（隣の人の顔を拾うのを防ぐ）
  const faceNose = toFrame(lm[1]);
  if (Math.hypot((faceNose.x - p[0]) * state.vw, (faceNose.y - p[1]) * state.vh) > ear * 0.8 + 6) { estimateHead(p); return p; }
  p[CHIN * 3] = chin.x; p[CHIN * 3 + 1] = chin.y; p[CHIN * 3 + 2] = 1;
  p[HEAD_TOP * 3] = chin.x + (brow.x - chin.x) * HEAD_TOP_RATIO;
  p[HEAD_TOP * 3 + 1] = chin.y + (brow.y - chin.y) * HEAD_TOP_RATIO;
  p[HEAD_TOP * 3 + 2] = 1;
  return p;
}

async function detect(src) {
  try {
    return state.landmarker.detect(src).landmarks.map(pack);
  } catch (e) {
    if (state.delegate !== 'GPU') throw e;
    await getLandmarker(state.model, true); // GPUで失敗したらCPUでやり直す
    return state.landmarker.detect(src).landmarks.map(pack);
  }
}

// 画面全体だと、遠い人・暗い服の人を見落とすことがある。
// そこで範囲を切り出し、正方形に拡大してから検出する（座標は画面全体の 0〜1 に戻す）
const CROP = 512;
const cropCanvas = document.createElement('canvas');
cropCanvas.width = cropCanvas.height = CROP;

async function detectRegion(x0, y0, w, h) {
  const ctx = cropCanvas.getContext('2d');
  const s = CROP / Math.max(w, h);
  const ox = (CROP - w * s) / 2, oy = (CROP - h * s) / 2;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, CROP, CROP);
  ctx.drawImage(video, x0, y0, w, h, ox, oy, w * s, h * s);
  const poses = await detect(cropCanvas);
  for (const p of poses) {
    for (let i = 0; i < 33; i++) {
      p[i * 3] = (x0 + (p[i * 3] * CROP - ox) / s) / state.vw;
      p[i * 3 + 1] = (y0 + (p[i * 3 + 1] * CROP - oy) / s) / state.vh;
    }
  }
  return poses;
}

// 中心 c（0〜1）、幅 w・高さ h（ピクセル）の範囲を、画面からはみ出さないように切り出して検出
function detectAround(c, size) {
  const w = Math.min(size.w, state.vw), h = Math.min(size.h, state.vh);
  const x0 = Math.max(0, Math.min(state.vw - w, c.x * state.vw - w / 2));
  const y0 = Math.max(0, Math.min(state.vh - h, c.y * state.vh - h / 2));
  return detectRegion(x0, y0, w, h);
}

// その人の形に合わせた切り出しの大きさ（ピクセル）。
// 広すぎると隣の人が入り、見落としや取り違えが起きるので、立った人に合わせて縦長にする
// 自信の低い点も含めて範囲を決める。自信のある点だけで決めると、足首の自信が下がったときに
// 足元が範囲から外れ、さらに自信が下がる悪循環になる
function cropSize(p, last) {
  let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
  for (let i = 0; i < 33; i++) {
    x0 = Math.min(x0, p[i * 3]); x1 = Math.max(x1, p[i * 3]);
    y0 = Math.min(y0, p[i * 3 + 1]); y1 = Math.max(y1, p[i * 3 + 1]);
  }
  const bw = (x1 - x0) * state.vw, bh = (y1 - y0) * state.vh;
  const min = Math.min(state.vw, state.vh) * 0.3;
  const size = { w: Math.max(bw * 2, bh * 0.8, min), h: Math.max(bh * 1.35, bw * 1.2, min) };
  // 人の大きさは急には縮まないので、前のコマの大きさから少しずつしか小さくしない
  if (last) { size.w = Math.max(size.w, last.w * 0.97); size.h = Math.max(size.h, last.h * 0.97); }
  return size;
}

const meanVis = (p) => { let s = 0; for (let i = 0; i < 33; i++) s += p[i * 3 + 2]; return s / 33; };

// 画面全体と、横（縦長の動画なら縦）にずらした範囲で人を探し、同じ人をまとめる
async function findPeople() {
  const { vw, vh } = state;
  const found = await detectRegion(0, 0, vw, vh);
  const side = Math.min(vw, vh);
  const long = Math.max(vw, vh);
  for (let pos = 0; ; pos += side / 3) {
    const p0 = Math.min(pos, long - side);
    found.push(...(vw >= vh ? await detectRegion(p0, 0, side, side) : await detectRegion(0, p0, side, side)));
    if (p0 >= long - side) break;
  }
  const people = [];
  for (const p of found.sort((a, b) => meanVis(b) - meanVis(a))) {
    if (!people.some((q) => dist(center(q), center(p)) < 0.06)) people.push(p);
  }
  return people.sort((a, b) => center(a).x - center(b).x);
}

const px = (p, i) => ({ x: p[i * 3] * state.vw, y: p[i * 3 + 1] * state.vh, v: p[i * 3 + 2] });

function center(p) {
  let x = 0, y = 0, n = 0;
  for (const i of [11, 12, 23, 24]) if (p[i * 3 + 2] > 0.3) { x += p[i * 3]; y += p[i * 3 + 1]; n++; }
  if (!n) for (let i = 0; i < 33; i++) { x += p[i * 3]; y += p[i * 3 + 1]; n++; }
  return { x: x / n, y: y / n };
}
function bbox(p) {
  let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
  for (let i = 0; i < 33; i++) {
    if (p[i * 3 + 2] < 0.3) continue;
    x0 = Math.min(x0, p[i * 3]); x1 = Math.max(x1, p[i * 3]);
    y0 = Math.min(y0, p[i * 3 + 1]); y1 = Math.max(y1, p[i * 3 + 1]);
  }
  return { x0, y0, x1, y1 };
}
// 画面の縦横比を考えた距離（0〜1）
function dist(a, b) {
  const m = Math.max(state.vw, state.vh);
  return Math.hypot((a.x - b.x) * state.vw / m, (a.y - b.y) * state.vh / m);
}

// 前のコマの位置に一番近い人を同じ人とみなす。遠すぎる場合は「見失った」とする
const MISS = 0.18;
function nearest(poses, prev, avoid) {
  let best = null, bestD = MISS;
  for (const p of poses) {
    const c = center(p);
    if (avoid && dist(c, avoid) < 0.05) continue; // もう1人と同じ人は選ばない
    const d = dist(c, prev);
    if (d < bestD) { bestD = d; best = p; }
  }
  return best;
}

// 1人ずつ、前のコマの位置の周りを切り出して探す
const lastCrop = { A: null, B: null };
async function trackFrame(prevA, prevB) {
  lastCrop.A = cropSize(prevA, lastCrop.A);
  lastCrop.B = cropSize(prevB, lastCrop.B);
  const A = nearest(await detectAround(center(prevA), lastCrop.A), center(prevA), null);
  const B = nearest(await detectAround(center(prevB), lastCrop.B), center(prevB), A ? center(A) : null);
  return { A, B };
}

// ---------- 描画 ----------
function drawSkeleton(ctx, p, color) {
  if (!p) return;
  const W = ctx.canvas.width, H = ctx.canvas.height;
  const lw = Math.max(2, Math.round(Math.min(W, H) / 170));
  ctx.lineCap = 'round';
  ctx.lineWidth = lw;
  for (const [i, j] of BONES) {
    const vi = p[i * 3 + 2], vj = p[j * 3 + 2];
    if (vi < 0.05 || vj < 0.05) continue;
    ctx.strokeStyle = vi >= VIS_MIN && vj >= VIS_MIN ? color : COLOR.low;
    ctx.beginPath();
    ctx.moveTo(p[i * 3] * W, p[i * 3 + 1] * H);
    ctx.lineTo(p[j * 3] * W, p[j * 3 + 1] * H);
    ctx.stroke();
  }
  for (const i of JOINTS) {
    const v = p[i * 3 + 2];
    if (v < 0.05) continue;
    ctx.fillStyle = v >= VIS_MIN ? color : COLOR.low;
    ctx.beginPath();
    ctx.arc(p[i * 3] * W, p[i * 3 + 1] * H, lw * 1.25, 0, Math.PI * 2);
    ctx.fill();
  }
  // 頭：頭頂部 → 顎先 → 両肩の真ん中 の線（頭と首の傾きが分かる）と、頭頂部・鼻・顎先の丸
  const hv = p[HEAD_TOP * 3 + 2], cv = p[CHIN * 3 + 2];
  const neck = { x: (p[33] + p[36]) / 2, y: (p[34] + p[37]) / 2, v: Math.min(p[35], p[38]) }; // 11・12番（両肩）の真ん中
  ctx.lineWidth = lw;
  const segment = (a, b, va, vb) => {
    if (va < 0.05 || vb < 0.05) return;
    ctx.strokeStyle = va >= VIS_MIN && vb >= VIS_MIN ? color : COLOR.low;
    ctx.beginPath();
    ctx.moveTo(a.x * W, a.y * H);
    ctx.lineTo(b.x * W, b.y * H);
    ctx.stroke();
  };
  const top = { x: p[HEAD_TOP * 3], y: p[HEAD_TOP * 3 + 1] }, chin = { x: p[CHIN * 3], y: p[CHIN * 3 + 1] };
  segment(top, chin, hv, cv);
  segment(chin, neck, cv, neck.v);
  for (const [i, r] of [[0, 1.4], [CHIN, 1.25], [HEAD_TOP, 1.25]]) {
    const v = p[i * 3 + 2];
    if (v < 0.05) continue;
    ctx.fillStyle = v >= VIS_MIN ? color : COLOR.low;
    ctx.beginPath();
    ctx.arc(p[i * 3] * W, p[i * 3 + 1] * H, lw * r, 0, Math.PI * 2);
    ctx.fill();
  }
}

function tag(ctx, text, x, y, bg) {
  const H = ctx.canvas.height, W = ctx.canvas.width;
  const fs = Math.max(12, Math.round(Math.min(W, H) / 26));
  ctx.font = `700 ${fs}px "BIZ UDPGothic", "Hiragino Sans", sans-serif`;
  const w = ctx.measureText(text).width + fs * 0.8, h = fs * 1.5;
  const bx = Math.min(Math.max(x - w / 2, 2), W - w - 2), by = Math.max(y - h, 2);
  ctx.fillStyle = bg;
  ctx.beginPath();
  ctx.roundRect ? ctx.roundRect(bx, by, w, h, h / 3) : ctx.rect(bx, by, w, h);
  ctx.fill();
  ctx.fillStyle = '#FFFFFF';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, bx + fs * 0.4, by + h / 2);
}

function personTag(ctx, p, text, color) {
  if (!p) return;
  const b = bbox(p);
  const W = ctx.canvas.width, H = ctx.canvas.height;
  const top = p[HEAD_TOP * 3 + 2] >= 0.05 ? Math.min(b.y0, p[HEAD_TOP * 3 + 1]) : b.y0; // 頭頂部の点に札が重ならないように
  tag(ctx, text, ((b.x0 + b.x1) / 2) * W, top * H - Math.min(W, H) / 40, color);
}

function rolesOf(frame) {
  const flips = state.swaps.filter((s) => s <= frame.t + 1e-6).length;
  return flips % 2 ? { teacher: frame.B, beginner: frame.A, swapped: true } : { teacher: frame.A, beginner: frame.B, swapped: false };
}

function drawScene(ctx, frame) {
  const W = ctx.canvas.width, H = ctx.canvas.height;
  ctx.drawImage(video, 0, 0, W, H);
  if (!frame) return;
  const r = rolesOf(frame);
  drawSkeleton(ctx, r.beginner, COLOR.beginner);
  drawSkeleton(ctx, r.teacher, COLOR.teacher);
  personTag(ctx, r.teacher, '先生', COLOR.teacher);
  personTag(ctx, r.beginner, '初心者', COLOR.beginner);
  tag(ctx, `${SPEED_LABEL[state.speed] ?? `${state.speed}倍速`}　${frame.t.toFixed(1)}秒`, 0, Math.min(W, H) / 12, 'rgba(0,0,0,0.6)');
}

function frameAt(t) {
  if (!state.frames.length) return null;
  const i = Math.round((t - state.start) * state.fps);
  return state.frames[Math.max(0, Math.min(state.frames.length - 1, i))];
}

// ---------- 3. 人を選ぶ ----------
const pickCanvas = $('pick-canvas');

function pickPrompt() {
  const el = $('pick-prompt');
  el.classList.remove('error');
  if (state.pickPoses.length < 2 && state.beginnerIdx === null) {
    const who = state.teacherIdx === null ? '<span class="t">先生</span>' : '<span class="b">初心者</span>';
    el.innerHTML = `${state.pickPoses.length}人しか見つかっていません。${who}をタップすると、その周りを探し直します。見つからないときは開始の位置を変えてください。`;
  } else if (state.teacherIdx === null) {
    el.innerHTML = '<span class="t">先生</span>をタップしてください';
  } else if (state.beginnerIdx === null) {
    el.innerHTML = '次に<span class="b">初心者</span>をタップしてください';
  } else {
    el.textContent = state.edited
      ? '点を直しました。よければ「解析する」を押してください'
      : '選べました。ずれている点は、指でドラッグして直せます。よければ「解析する」を押してください';
  }
  const ready = state.teacherIdx !== null && state.beginnerIdx !== null;
  $('to-analyze').disabled = !ready;
  pickCanvas.classList.toggle('editing', ready);
}

// 点を直すときにつかむ点（体の関節と鼻）
const HANDLES = [HEAD_TOP, 0, CHIN, ...JOINTS];

function drawPick() {
  const ctx = pickCanvas.getContext('2d');
  const W = pickCanvas.width, H = pickCanvas.height;
  ctx.drawImage(video, 0, 0, W, H);
  const ready = state.teacherIdx !== null && state.beginnerIdx !== null;
  state.pickPoses.forEach((p, i) => {
    if (ready && i !== state.teacherIdx && i !== state.beginnerIdx) return; // 選んだ2人だけ残す
    const color = i === state.teacherIdx ? COLOR.teacher : i === state.beginnerIdx ? COLOR.beginner : COLOR.other;
    drawSkeleton(ctx, p, color);
    const label = i === state.teacherIdx ? '先生' : i === state.beginnerIdx ? '初心者' : String(i + 1);
    personTag(ctx, p, label, i === state.teacherIdx ? COLOR.teacher : i === state.beginnerIdx ? COLOR.beginner : 'rgba(0,0,0,0.65)');
    if (ready) {
      // つかめる点を、白いふちの丸で示す
      const r = Math.max(5, Math.min(W, H) / 70);
      ctx.lineWidth = Math.max(1.5, r / 3);
      ctx.strokeStyle = '#FFFFFF';
      ctx.fillStyle = color;
      for (const j of HANDLES) {
        if (p[j * 3 + 2] < 0.05) continue; // 顔が見つからなかったときの顎先・頭頂部
        ctx.beginPath();
        ctx.arc(p[j * 3] * W, p[j * 3 + 1] * H, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    }
  });
  pickPrompt();
}

// ---------- 点を手で直す ----------
let drag = null;
function canvasPoint(e) {
  const r = pickCanvas.getBoundingClientRect();
  return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
}

pickCanvas.addEventListener('pointerdown', (e) => {
  if (state.busy || state.teacherIdx === null || state.beginnerIdx === null) return;
  const pt = canvasPoint(e);
  let best = null, bestD = 0.06;
  for (const idx of [state.teacherIdx, state.beginnerIdx]) {
    const p = state.pickPoses[idx];
    for (const j of HANDLES) {
      if (p[j * 3 + 2] < 0.05) continue;
      const d = dist(pt, { x: p[j * 3], y: p[j * 3 + 1] });
      if (d < bestD) { bestD = d; best = { p, j }; }
    }
  }
  if (!best) return;
  drag = best;
  pickCanvas.setPointerCapture(e.pointerId);
  e.preventDefault();
});

pickCanvas.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const pt = canvasPoint(e);
  drag.p[drag.j * 3] = Math.max(0, Math.min(1, pt.x));
  drag.p[drag.j * 3 + 1] = Math.max(0, Math.min(1, pt.y));
  drag.p[drag.j * 3 + 2] = 1; // 手で直した点は「確か」とみなす
  state.edited = true;
  drawPick();
});

const endDrag = () => { drag = null; };
pickCanvas.addEventListener('pointerup', endDrag);
pickCanvas.addEventListener('pointercancel', endDrag);

$('to-pick').addEventListener('click', async () => {
  try {
    readSettings();
  } catch (e) {
    message('file-info', e.message, true);
    return;
  }
  // iPhoneでは、ボタンを押した直後に一度再生しておくとコマの移動が安定する
  video.play().then(() => video.pause()).catch(() => {});
  stopReview();
  lockFrom('step-pick');
  setStep('step-settings', 'done');
  setStep('step-pick', 'active');
  state.teacherIdx = state.beginnerIdx = null;
  state.pickPoses = [];
  pickCanvas.width = state.outW;
  pickCanvas.height = state.outH;
  $('to-analyze').disabled = true;
  const el = $('pick-prompt');
  el.classList.remove('error');
  el.textContent = 'AIを準備しています（初回は少し時間がかかります）…';
  try {
    state.busy = true;
    await getLandmarker(state.model);
    await getFaceLandmarker();
    el.textContent = '人を探しています…';
    await seekTo(video, state.start);
    state.pickPoses = await findPeople();
    state.pickOriginal = state.pickPoses.map((p) => p.slice());
    state.edited = false;
    drawPick();
  } catch (e) {
    console.error(e);
    el.textContent = `AIを動かせませんでした（${e.message}）。ページを読み込み直してください。`;
    el.classList.add('error');
  } finally {
    state.busy = false;
  }
});

function poseAt(pt) {
  let best = -1, bestD = Infinity;
  state.pickPoses.forEach((p, i) => {
    if (i === state.teacherIdx) return;
    const b = bbox(p);
    const inside = pt.x >= b.x0 && pt.x <= b.x1 && pt.y >= b.y0 && pt.y <= b.y1;
    const d = inside ? 0 : dist(pt, center(p));
    if (d < bestD) { bestD = d; best = i; }
  });
  return bestD <= 0.12 ? best : -1;
}

pickCanvas.addEventListener('click', async (e) => {
  if (state.busy || state.beginnerIdx !== null || !state.landmarker) return;
  const r = pickCanvas.getBoundingClientRect();
  const pt = { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
  let best = poseAt(pt);
  if (best < 0) {
    // 見つかっていない人をタップしたときは、その周りを切り出して探し直す
    state.busy = true;
    try {
      const side = Math.min(state.vw, state.vh);
      const more = await detectAround(pt, { w: side * 0.6, h: side });
      for (const p of more) {
        if (!state.pickPoses.some((q) => dist(center(q), center(p)) < 0.06)) {
          state.pickPoses.push(p);
          state.pickOriginal.push(p.slice());
        }
      }
    } finally {
      state.busy = false;
    }
    best = poseAt(pt);
    if (best < 0) { drawPick(); return; }
  }
  if (state.teacherIdx === null) state.teacherIdx = best;
  else state.beginnerIdx = best;
  if (state.beginnerIdx !== null) {
    // 2人が決まったら、顎先・頭頂部を探して、直せる点に加える
    state.busy = true;
    try {
      for (const i of [state.teacherIdx, state.beginnerIdx]) {
        await addHead(state.pickPoses[i]);
        state.pickOriginal[i] = state.pickPoses[i].slice();
      }
    } finally {
      state.busy = false;
    }
  }
  drawPick();
});

// 選び直すときは、手で直した点もAIの位置に戻す
$('pick-reset').addEventListener('click', () => {
  state.teacherIdx = state.beginnerIdx = null;
  state.pickPoses = state.pickOriginal.map((p) => p.slice());
  state.edited = false;
  if (state.pickPoses.length) drawPick();
});

// ---------- 4. 解析 ----------
$('to-analyze').addEventListener('click', async () => {
  setStep('step-pick', 'done');
  setStep('step-analyze', 'active');
  lockFrom('step-review');
  state.busy = true;
  await keepAwake(true);
  try {
    await analyze();
    setStep('step-analyze', 'done');
    await setupReview();
  } catch (e) {
    console.error(e);
    message('analyze-info', `解析が止まりました（${e.message}）。もう一度「解析する」を押してください。`, true);
    setStep('step-pick', 'active');
  } finally {
    state.busy = false;
    keepAwake(false);
  }
});

async function analyze() {
  const step = 1 / state.fps;
  const n = Math.floor((state.end - state.start) / step + 1e-6) + 1;
  const bar = $('analyze-bar');
  state.frames = [];
  state.swaps = [];
  lastCrop.A = lastCrop.B = null;
  let prevA = state.pickPoses[state.teacherIdx];
  let prevB = state.pickPoses[state.beginnerIdx];
  let lostA = 0, lostB = 0;
  const t0 = performance.now();
  message('analyze-info', '終わるまでこの画面を開いたままにしてください。');
  for (let i = 0; i < n; i++) {
    const t = state.start + i * step;
    await seekTo(video, t);
    // 最初のコマは、選んだとき（手で直した場合は直した後）の点をそのまま使う
    const { A, B } = i === 0 ? { A: prevA.slice(), B: prevB.slice() } : await trackFrame(prevA, prevB);
    if (i > 0) {
      if (A) await addHead(A);
      if (B) await addHead(B);
    }
    if (A) prevA = A; else lostA++;
    if (B) prevB = B; else lostB++;
    state.frames.push({ t, A, B });
    if (i % 3 === 0 || i === n - 1) {
      bar.style.width = `${((i + 1) / n) * 100}%`;
      const left = ((performance.now() - t0) / (i + 1)) * (n - i - 1) / 1000;
      message('analyze-info', `${i + 1} / ${n} コマ　あと約${Math.ceil(left)}秒（この画面を開いたままにしてください）`);
      await nextPaint();
    }
  }
  state.headCalibrated = { A: calibrateHeads('A'), B: calibrateHeads('B') };
  const sec = ((performance.now() - t0) / 1000).toFixed(0);
  const lost = (lostA + lostB) ? `　見失ったコマ：先生 ${lostA}・初心者 ${lostB}` : '';
  message('analyze-info', `解析が終わりました（${n}コマ・${sec}秒・${state.delegate}）。${lost}`);
}

// ---------- 5. 確認 ----------
const reviewCanvas = $('review-canvas');
let playing = false;

async function setupReview() {
  reviewCanvas.width = state.outW;
  reviewCanvas.height = state.outH;
  setStep('step-review', 'active');
  updateSwapInfo();
  await showAt(state.start);
}

async function showAt(t) {
  await seekTo(video, t);
  renderReview();
}

function renderReview() {
  const t = video.currentTime;
  drawScene(reviewCanvas.getContext('2d'), frameAt(t));
  $('review-time').textContent = `${t.toFixed(1)}秒`;
  $('seek').value = String(Math.round(((t - state.start) / (state.end - state.start)) * 1000));
}

function loop() {
  if (!playing) return;
  if (video.currentTime >= state.end - 0.01 || video.ended) {
    stopReview();
    showAt(state.start);
    return;
  }
  renderReview();
  requestAnimationFrame(loop);
}

function stopReview() {
  if (!playing) return;
  playing = false;
  video.pause();
  $('play').textContent = '再生';
}

$('play').addEventListener('click', async () => {
  if (playing) { stopReview(); return; }
  if (video.currentTime >= state.end - 0.05 || video.currentTime < state.start) await seekTo(video, state.start);
  video.playbackRate = state.speed;
  try { await video.play(); } catch { return; }
  playing = true;
  $('play').textContent = '止める';
  requestAnimationFrame(loop);
});

$('seek').addEventListener('input', async (e) => {
  stopReview();
  const t = state.start + (state.end - state.start) * (Number(e.target.value) / 1000);
  await showAt(t);
});

$('swap').addEventListener('click', () => {
  stopReview();
  const f = frameAt(video.currentTime);
  if (!f) return;
  const t = Number(f.t.toFixed(3));
  const at = state.swaps.findIndex((s) => Math.abs(s - t) < 1e-3);
  if (at >= 0) state.swaps.splice(at, 1); else state.swaps.push(t);
  state.swaps.sort((x, y) => x - y);
  updateSwapInfo();
  renderReview();
});

function updateSwapInfo() {
  const el = $('swap-info');
  el.textContent = state.swaps.length
    ? `入れ替え：${state.swaps.map((s) => `${s.toFixed(1)}秒`).join('、')} から（同じ位置でもう一度押すと取り消し）`
    : '';
}

// ---------- 6. 書き出し ----------
$('to-export').addEventListener('click', async () => {
  stopReview();
  setStep('step-review', 'done');
  setStep('step-export', 'active');
  $('save-video').disabled = $('save-csv').disabled = true;
  $('result-wrap').hidden = true;
  state.busy = true;
  await keepAwake(true);
  try {
    state.csvBlob = new Blob(['﻿' + buildCsv()], { type: 'text/csv' });
    $('save-csv').disabled = false;
    state.videoBlob = await encodeVideo();
    const url = URL.createObjectURL(state.videoBlob);
    $('result').src = url;
    $('result-wrap').hidden = false;
    $('save-video').disabled = false;
    message('export-info', `できました（動画 ${(state.videoBlob.size / 1e6).toFixed(1)}MB）。下のボタンで保存します。`);
  } catch (e) {
    console.error(e);
    message('export-info', e.message, true);
  } finally {
    state.busy = false;
    keepAwake(false);
    setStep('step-review', 'active');
  }
});

async function pickCodec(config) {
  for (const codec of ['avc1.640028', 'avc1.4d0028', 'avc1.42e028', 'avc1.42e01f']) {
    try {
      const r = await VideoEncoder.isConfigSupported({ ...config, codec });
      if (r.supported) return codec;
    } catch { /* 次を試す */ }
  }
  return null;
}

async function encodeVideo() {
  if (!('VideoEncoder' in window)) {
    throw new Error('このブラウザは動画の書き出しに対応していません。iPhoneはiOS 16.4以降のSafariで開いてください。CSVは保存できます。');
  }
  const W = state.outW, H = state.outH;
  const outFps = state.fps * state.speed; // 0.5倍速では1コマを2倍の長さで見せる
  const base = { width: W, height: H, bitrate: Math.max(1_500_000, Math.round(W * H * outFps * 0.25)), framerate: outFps };
  const codec = await pickCodec(base);
  if (!codec) throw new Error('この端末ではMP4（H.264）を書き出せませんでした。CSVは保存できます。');

  const target = new ArrayBufferTarget();
  // mp4-muxer は整数のコマ数しか受け付けない。1/4倍速（毎秒7.5コマ）でも、各コマの時刻は
  // 1/解析コマ数 秒の倍数になるので、解析のコマ数を渡せば時刻がずれない
  const muxer = new Muxer({ target, video: { codec: 'avc', width: W, height: H, frameRate: state.fps }, fastStart: 'in-memory' });
  let failure = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => { failure = e; },
  });
  encoder.configure({ ...base, codec, avc: { format: 'avc' } });

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  const bar = $('export-bar');
  const n = state.frames.length;
  const dur = 1e6 / outFps;
  for (let i = 0; i < n; i++) {
    if (failure) throw failure;
    const f = state.frames[i];
    await seekTo(video, f.t);
    drawScene(ctx, f);
    const vf = new VideoFrame(canvas, { timestamp: Math.round(i * dur), duration: Math.round(dur) });
    encoder.encode(vf, { keyFrame: i % Math.max(1, Math.round(outFps * 2)) === 0 });
    vf.close();
    while (encoder.encodeQueueSize > 6) await sleep(4);
    if (i % 3 === 0 || i === n - 1) {
      bar.style.width = `${((i + 1) / n) * 100}%`;
      message('export-info', `動画を作っています　${i + 1} / ${n} コマ`);
      await nextPaint();
    }
  }
  await encoder.flush();
  if (failure) throw failure;
  encoder.close();
  muxer.finalize();
  return new Blob([target.buffer], { type: 'video/mp4' });
}

// ---------- CSV ----------
function angle3(a, b, c) {
  const v1 = { x: a.x - b.x, y: a.y - b.y }, v2 = { x: c.x - b.x, y: c.y - b.y };
  const d = Math.hypot(v1.x, v1.y) * Math.hypot(v2.x, v2.y);
  if (!d) return '';
  return Math.acos(Math.max(-1, Math.min(1, (v1.x * v2.x + v1.y * v2.y) / d))) * 180 / Math.PI;
}
// 二の腕の角度：真下が0°、肩の高さが90°
function armRaise(sh, el) {
  const v = { x: el.x - sh.x, y: el.y - sh.y };
  const d = Math.hypot(v.x, v.y);
  if (!d) return '';
  return Math.acos(Math.max(-1, Math.min(1, v.y / d))) * 180 / Math.PI;
}
const r1 = (n) => (n === '' ? '' : Math.round(n * 10) / 10);
const r2 = (n) => Math.round(n * 100) / 100;

function measures(p) {
  const P = (i) => px(p, i);
  const mid = (i, j) => ({ x: (P(i).x + P(j).x) / 2, y: (P(i).y + P(j).y) / 2 });
  const sh = mid(11, 12), hip = mid(23, 24);
  const tilt = Math.atan2(Math.abs(P(11).y - P(12).y), Math.abs(P(11).x - P(12).x)) * 180 / Math.PI;
  return [
    Math.hypot(sh.x - hip.x, sh.y - hip.y),
    angle3(P(23), P(25), P(27)), angle3(P(24), P(26), P(28)),
    angle3(P(11), P(13), P(15)), angle3(P(12), P(14), P(16)),
    armRaise(P(11), P(13)), armRaise(P(12), P(14)),
    tilt,
  ].map(r1);
}

function csvCell(v) {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function buildCsv() {
  const names = Object.keys(POINTS);
  const header = [
    'time_s', 'role', 'tracked_id', 'swapped',
    ...names.flatMap((n) => [`${n}_x`, `${n}_y`, `${n}_vis`]),
    'torso_px', 'knee_angle_left', 'knee_angle_right', 'elbow_angle_left', 'elbow_angle_right',
    'arm_raise_left', 'arm_raise_right', 'shoulder_tilt',
  ];
  const lines = [
    `# movie-motion-capture ${APP_VERSION}`,
    `# source_file: ${state.name}`,
    `# created: ${new Date().toISOString()}`,
    `# video_size_px: ${state.vw}x${state.vh}`,
    `# video_duration_s: ${state.duration.toFixed(2)}`,
    `# analyzed_range_s: ${state.start.toFixed(1)}-${state.end.toFixed(1)}`,
    `# analysis_fps: ${state.fps} / sample_interval_s: 0.1`,
    `# model: MediaPipe Pose Landmarker ${state.model} (${MEDIAPIPE_VERSION}, ${state.delegate})`,
    '# coords: pixels of the source video, origin top-left, y down. *_vis = AI confidence 0-1 (below 0.5 is unreliable)',
    '# angles_deg: knee/elbow = 3-point angle (180 = straight). arm_raise = upper arm from straight down (0 = down, 90 = shoulder height). shoulder_tilt = shoulder line from horizontal',
    '# head points: chin_vis 1 = MediaPipe Face Landmarker point 152. head_top is always ESTIMATED: with a face, chin + (forehead top = face point 10 - chin) x 1.3',
    '# head points when the face AI could not find the face: chin and head_top are ESTIMATED from pose eyes and mouth (vis = 0.4), using the face proportions measured on the same person\'s face-found frames (median), or adult averages if fewer than 5 such frames. vis 0 = no estimate (x/y empty)',
    `# head_estimate_calibrated_from_frames: tracked A ${state.headCalibrated?.A ?? 0}, tracked B ${state.headCalibrated?.B ?? 0}`,
    '# left/right: the person\'s own left/right as detected by the AI (a mirrored video stays mirrored)',
    '# tracked_id: A = person picked as teacher at the start, B = person picked as beginner. swapped = 1 after the user swapped roles',
    `# first_frame: ${state.edited ? 'some points were adjusted by hand (vis set to 1)' : 'AI detection as is'}`,
    `# role_swaps_at_s: ${state.swaps.length ? state.swaps.map((s) => s.toFixed(1)).join(' ') : 'none'}`,
    '# empty row values = the person was not found in that frame',
    header.join(','),
  ];
  for (let k = 0; ; k++) {
    const t = state.start + k * 0.1;
    if (t > state.end + 1e-6) break;
    const f = frameAt(t);
    const r = rolesOf(f);
    for (const role of ['teacher', 'beginner']) {
      const p = r[role];
      const id = (role === 'teacher') !== r.swapped ? 'A' : 'B';
      const row = [t.toFixed(1), role, id, r.swapped ? 1 : 0];
      if (p) {
        for (const n of names) {
          const q = px(p, POINTS[n]);
          if (POINTS[n] >= 33 && q.v < 0.05) row.push('', '', 0); // 顔が見つからなかった
          else row.push(r1(q.x), r1(q.y), r2(q.v));
        }
        row.push(...measures(p));
      } else {
        row.push(...new Array(names.length * 3 + 8).fill(''));
      }
      lines.push(row.map(csvCell).join(','));
    }
  }
  return lines.join('\n') + '\n';
}

// ---------- 保存 ----------
function baseName() {
  return state.name.replace(/\.[^.]+$/, '') || 'video';
}

async function saveBlob(blob, filename) {
  const file = new File([blob], filename, { type: blob.type });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return;
    } catch (e) {
      if (e.name === 'AbortError') return;
    }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
}

$('save-video').addEventListener('click', () => state.videoBlob && saveBlob(state.videoBlob, `${baseName()}_MediaPipePose.mp4`));
$('save-csv').addEventListener('click', () => state.csvBlob && saveBlob(state.csvBlob, `${baseName()}_MediaPipePose.csv`));

// 動作確認用：?src=動画のURL で動画を読み込む
const testSrc = new URLSearchParams(location.search).get('src');
if (testSrc) {
  fetch(testSrc).then((r) => r.blob()).then((b) => handleFile(new File([b], testSrc.split('/').pop(), { type: b.type || 'video/mp4' })));
}
