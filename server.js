/**
 * SportsByDustin Live Stream Tweet Bot
 * ─────────────────────────────────────────────────────────────────
 * Drop a bet slip screenshot → Gemini reads it → tweet posted via Buffer
 *
 * START:  node server.js
 * OPEN:   http://localhost:3000
 * ─────────────────────────────────────────────────────────────────
 */

'use strict';
require('dotenv').config();

const express = require('express');
const multer  = require('multer');

const app    = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

app.use(express.json({ limit: '20mb' }));

const {
  ANTHROPIC_API_KEY,
  BUFFER_ACCESS_TOKEN,
  BUFFER_CHANNEL_ID,
  IMGBB_API_KEY,
  TWITCH_URL = 'Twitch.tv/SportsByDustin',
  PORT       = 3000,
} = process.env;

// ══════════════════════════════════════════════════════════════════
// API Routes
// ══════════════════════════════════════════════════════════════════

// GET /api/config
app.get('/api/config', (req, res) => res.json({
  hasImgbb: !!IMGBB_API_KEY,
  twitchUrl: TWITCH_URL,
}));

// POST /api/analyze — Gemini Vision → tweet text
app.post('/api/analyze', upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image uploaded.' });

  const mimeType = req.file.mimetype.toLowerCase()
    .replace('image/jpg',  'image/jpeg')
    .replace('image/heic', 'image/jpeg')
    .replace('image/heif', 'image/jpeg');
  const allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
  if (!allowed.includes(mimeType)) {
    return res.status(400).json({ error: `Unsupported format: ${req.file.mimetype}. Please use JPEG or PNG.` });
  }

  try {
    const tweet = await analyzeWithClaude(req.file.buffer.toString('base64'), mimeType);
    res.json({ tweet });
  } catch (err) {
    console.error('[analyze]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/post — upload image to ImgBB, post via Buffer
app.post('/api/post', upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image provided.' });
  const { tweet } = req.body;
  if (!tweet) return res.status(400).json({ error: 'No tweet text provided.' });

  try {
    let imageUrl = null;
    if (IMGBB_API_KEY) {
      imageUrl = await uploadToImgbb(req.file.buffer);
    }
    await postToBuffer(tweet, imageUrl);
    res.json({ ok: true });
  } catch (err) {
    console.error('[post]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Debug helpers ─────────────────────────────────────────────────

// GET /api/buffer-channels — find your Buffer channel ID
app.get('/api/buffer-channels', async (req, res) => {
  const gql = (query) => fetch(BUFFER_GQL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${BUFFER_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  }).then(r => r.json());

  try {
    const orgResp = await gql(`query { account { id name organizations { id name } } }`);
    const orgs = orgResp?.data?.account?.organizations;
    if (!orgs?.length) return res.json({ raw: orgResp, hint: 'Could not find organizations.' });

    const organizationId = orgs[0].id;
    const chanResp = await gql(`query { channels(input: { organizationId: "${organizationId}" }) { id name service serviceId } }`);
    const channels = chanResp?.data?.channels;
    res.json({ organizationId, channels: channels ?? chanResp });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════
// Claude Vision
// ══════════════════════════════════════════════════════════════════

async function analyzeWithClaude(base64, mimeType) {
  const prompt = `You are the social media manager for @SportsByDustin, a sports betting live-stream on Twitch.

Dustin just dropped a bet slip screenshot during his LIVE stream at ${TWITCH_URL}.

Analyze the slip and write a tweet to post RIGHT NOW. Follow these rules exactly:

TWEET FORMAT (pick one):
• Standard:  [Platform] [Sport] slip built live on stream 🎯
• Big parlay (NUKE): [Platform] [Sport] NUKE built live on stream 🚀

Then a blank line, then:
LIVE NOW: ${TWITCH_URL}

PLATFORM — detect from logos, colors, UI (write exactly as shown):
Onyx · Betr · DraftKings Pick6 · Underdog · Sleeper · ReBet · DraftKings · FanDuel · BetMGM · PrizePicks · Caesars
If unclear → write "Slip"

SPORT — include if clearly visible (NBA, NFL, MLB, NHL, NCAAB, NCAAF, etc.). Omit if unclear.

NUKE — use when the slip has many legs, huge potential payout, or is an aggressive high-risk parlay. Use 🚀.
Standard — most slips. Use 🎯.

OUTPUT: Return ONLY the tweet text. No quotes. No explanation. No markdown.`;

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 280,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64 } },
          { type: 'text', text: prompt },
        ],
      }],
    }),
  });

  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`Claude API ${resp.status}: ${txt}`);
  }
  const json = await resp.json();
  return json.content[0].text.trim();
}

// ══════════════════════════════════════════════════════════════════
// ImgBB Upload
// ══════════════════════════════════════════════════════════════════

async function uploadToImgbb(buffer) {
  const params = new URLSearchParams({
    key:   IMGBB_API_KEY,
    image: buffer.toString('base64'),
  });
  const resp = await fetch('https://api.imgbb.com/1/upload', { method: 'POST', body: params });
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`ImgBB upload ${resp.status}: ${txt}`);
  }
  const json = await resp.json();
  return json.data.url;
}

// ══════════════════════════════════════════════════════════════════
// Buffer Post
// ══════════════════════════════════════════════════════════════════

const BUFFER_GQL = 'https://api.buffer.com/graphql';

async function postToBuffer(tweetText, imageUrl) {
  const input = {
    channelId: BUFFER_CHANNEL_ID,
    text: tweetText,
    schedulingType: 'automatic',
    mode: 'shareNow',
    ...(imageUrl && { assets: { images: [{ url: imageUrl }] } }),
  };

  const query = `
    mutation CreatePost($input: CreatePostInput!) {
      createPost(input: $input) {
        ... on PostActionSuccess { post { id text } }
        ... on MutationError { message }
      }
    }
  `;

  const resp = await fetch(BUFFER_GQL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${BUFFER_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables: { input } }),
  });

  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`Buffer API ${resp.status}: ${txt}`);
  }

  const json = await resp.json();
  if (json?.errors?.length) throw new Error('Buffer API error: ' + json.errors.map(e => e.message).join(', '));
  const result = json?.data?.createPost;
  if (result?.message) throw new Error('Buffer error: ' + result.message);
  return json;
}

// ══════════════════════════════════════════════════════════════════
// Web UI
// ══════════════════════════════════════════════════════════════════

app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.send(HTML);
});

// ── Start ─────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  const os   = require('os');
  const nets = os.networkInterfaces();
  let localIp = 'localhost';
  for (const iface of Object.values(nets).flat()) {
    if (iface.family === 'IPv4' && !iface.internal) { localIp = iface.address; break; }
  }
  console.log('\n ✅  SportsByDustin Tweet Bot running');
  console.log(`    Desktop: http://localhost:${PORT}`);
  console.log(`    Mobile:  http://${localIp}:${PORT}\n`);
});

// ══════════════════════════════════════════════════════════════════
// HTML (entire web app, embedded)
// ══════════════════════════════════════════════════════════════════

const HTML = /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0">
<title>SportsByDustin Tweet Bot</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  :root {
    --bg:     #0A0E17;
    --bg2:    #111827;
    --card:   #161D2C;
    --border: rgba(255,255,255,.08);
    --accent: #1D9BF0;
    --accent2:#1a8cd8;
    --white:  #FFFFFF;
    --gray:   #8899AA;
    --lgray:  #1E293B;
    --red:    #EF4444;
    --green:  #10B981;
    --font:   -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  }

  html, body {
    background: var(--bg);
    color: var(--white);
    font-family: var(--font);
    min-height: 100vh;
  }

  body {
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 28px 16px 56px;
  }

  /* ── Header ── */
  .header {
    width: 100%;
    max-width: 480px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 28px;
  }
  .logo { display: flex; flex-direction: column; line-height: 1; }
  .logo-name { font-size: 20px; font-weight: 800; color: var(--white); letter-spacing: .5px; }
  .logo-name span { color: var(--accent); }
  .logo-sub  { font-size: 11px; color: var(--gray); letter-spacing: 2px; text-transform: uppercase; margin-top: 3px; }
  .live-badge {
    background: var(--red);
    color: white;
    font-size: 11px;
    font-weight: 700;
    padding: 5px 11px;
    border-radius: 5px;
    letter-spacing: 1px;
    animation: pulse 1.8s ease-in-out infinite;
  }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.55} }

  /* ── Card ── */
  .card {
    width: 100%;
    max-width: 480px;
    background: var(--card);
    border-radius: 18px;
    padding: 26px;
    border: 1px solid var(--border);
  }

  /* ── Drop zone ── */
  .label {
    font-size: 11px;
    font-weight: 600;
    color: var(--gray);
    letter-spacing: 1.5px;
    text-transform: uppercase;
    margin-bottom: 10px;
  }
  .drop-zone {
    border: 2px dashed rgba(29,155,240,.35);
    border-radius: 14px;
    min-height: 190px;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 10px;
    cursor: pointer;
    transition: border-color .2s, background .2s;
    padding: 28px 20px;
    text-align: center;
    position: relative;
    overflow: hidden;
  }
  .drop-zone.drag-over {
    border-color: var(--accent);
    background: rgba(29,155,240,.06);
  }
  .drop-zone input[type=file] {
    position: absolute;
    inset: 0;
    opacity: 0;
    cursor: pointer;
    width: 100%;
    height: 100%;
  }
  .drop-icon { font-size: 44px; line-height: 1; }
  .drop-text { font-size: 17px; font-weight: 700; color: var(--white); }
  .drop-sub  { font-size: 13px; color: var(--gray); line-height: 1.5; }

  /* ── Processing ── */
  .processing {
    display: none;
    flex-direction: column;
    align-items: center;
    gap: 14px;
    padding: 36px 0;
    text-align: center;
  }
  .spinner {
    width: 44px; height: 44px;
    border: 3px solid rgba(29,155,240,.2);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin .8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .processing-text { font-size: 16px; font-weight: 600; color: var(--gray); }

  /* ── Preview ── */
  .preview { display: none; }
  .preview-image {
    width: 100%;
    border-radius: 12px;
    margin-bottom: 18px;
    object-fit: contain;
    max-height: 280px;
    background: var(--bg);
  }
  textarea {
    width: 100%;
    background: var(--bg2);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 14px;
    font-size: 15px;
    font-family: var(--font);
    color: var(--white);
    resize: vertical;
    min-height: 110px;
    line-height: 1.55;
    outline: none;
    transition: border-color .2s;
  }
  textarea:focus { border-color: var(--accent); }
  .char-count {
    text-align: right;
    font-size: 12px;
    color: var(--gray);
    margin-top: 6px;
    margin-bottom: 18px;
  }
  .char-count.over { color: var(--red); }

  /* ── Buttons ── */
  .btn {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    width: 100%;
    padding: 16px;
    border-radius: 12px;
    font-size: 17px;
    font-weight: 700;
    border: none;
    cursor: pointer;
    transition: opacity .15s, transform .1s;
    font-family: var(--font);
    letter-spacing: .3px;
  }
  .btn:active { transform: scale(.97); }
  .btn-primary { background: var(--accent); color: #fff; }
  .btn-primary:hover { background: var(--accent2); }
  .btn-primary:disabled { opacity: .45; cursor: not-allowed; transform: none; }
  .btn-ghost {
    background: transparent;
    color: var(--gray);
    border: 1px solid var(--border);
    margin-top: 10px;
    font-size: 14px;
    padding: 12px;
  }
  .btn-ghost:hover { color: var(--white); border-color: rgba(255,255,255,.2); }

  /* ── Success ── */
  .success { display: none; flex-direction: column; align-items: center; gap: 12px; padding: 20px 0; text-align: center; }
  .success-icon { font-size: 58px; }
  .success-title { font-size: 22px; font-weight: 800; color: var(--accent); }
  .success-sub { font-size: 14px; color: var(--gray); line-height: 1.5; }
  .success-tweet {
    background: var(--bg2);
    border-radius: 10px;
    padding: 14px;
    font-size: 14px;
    color: #CBD5E1;
    line-height: 1.55;
    text-align: left;
    width: 100%;
    white-space: pre-wrap;
    border: 1px solid var(--border);
  }

  /* ── Warning / Error bars ── */
  .error-bar {
    width: 100%;
    max-width: 480px;
    background: rgba(239,68,68,.12);
    border: 1px solid var(--red);
    border-radius: 10px;
    padding: 12px 16px;
    font-size: 14px;
    color: #FCA5A5;
    margin-top: 12px;
    display: none;
  }
  .warning-bar {
    width: 100%;
    background: rgba(245,158,11,.1);
    border: 1px solid rgba(245,158,11,.35);
    border-radius: 8px;
    padding: 10px 14px;
    font-size: 13px;
    color: #FCD34D;
    margin-bottom: 14px;
    display: none;
    line-height: 1.4;
  }

  .divider { height: 1px; background: var(--border); margin: 20px 0; }

  /* ── Twitch strip ── */
  .twitch-strip {
    width: 100%;
    max-width: 480px;
    margin-top: 16px;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    font-size: 13px;
    color: var(--gray);
  }
  .twitch-strip a { color: #9147ff; text-decoration: none; font-weight: 600; }
  .twitch-strip a:hover { text-decoration: underline; }
</style>
</head>
<body>

<!-- Header -->
<div class="header">
  <div class="logo">
    <span class="logo-name">Sports<span>By</span>Dustin</span>
    <span class="logo-sub">Tweet Bot</span>
  </div>
  <div class="live-badge">● LIVE</div>
</div>

<!-- Main card -->
<div class="card">

  <!-- Drop zone -->
  <div class="label">Bet Slip</div>
  <div id="dropZone" class="drop-zone">
    <input type="file" id="fileInput" accept="image/*" capture="environment">
    <div class="drop-icon">📸</div>
    <div class="drop-text">Drop bet slip here</div>
    <div class="drop-sub">or tap to select from camera / gallery</div>
  </div>

  <!-- Processing -->
  <div id="processing" class="processing">
    <div class="spinner"></div>
    <div class="processing-text" id="processingText">Reading slip with Gemini…</div>
  </div>

  <!-- Tweet preview -->
  <div id="preview" class="preview">
    <img id="previewImage" class="preview-image" src="" alt="Bet slip">
    <div class="label">Tweet</div>
    <textarea id="tweetText" maxlength="280" rows="4"
      placeholder="Generated tweet will appear here…"></textarea>
    <div class="char-count" id="charCount">0 / 280</div>

    <div id="noImageWarning" class="warning-bar">
      ⚠️ No ImgBB key configured — tweet will post as text only (no image).
      Add IMGBB_API_KEY to your environment to include the image.
    </div>

    <button class="btn btn-primary" id="postBtn">
      <span>𝕏</span> Post to Twitter/X Now
    </button>
    <button class="btn btn-ghost" id="resetBtn">Start over</button>
  </div>

  <!-- Success -->
  <div id="success" class="success">
    <div class="success-icon">🚀</div>
    <div class="success-title">Tweet posted!</div>
    <div class="success-sub">It's live on Twitter/X via Buffer.</div>
    <div class="success-tweet" id="postedTweet"></div>
    <button class="btn btn-primary" id="anotherBtn" style="margin-top:8px">Post another slip</button>
  </div>

</div>

<!-- Error bar -->
<div class="error-bar" id="errorBar"></div>

<!-- Twitch strip -->
<div class="twitch-strip">
  🟣 Live at <a href="https://twitch.tv/SportsByDustin" target="_blank">Twitch.tv/SportsByDustin</a>
</div>

<script>
// ── State ────────────────────────────────────────────────────────
let currentImageFile    = null;
let currentImageDataUrl = null;
let hasImgbb            = false;

// ── Elements ─────────────────────────────────────────────────────
const dropZone        = document.getElementById('dropZone');
const fileInput       = document.getElementById('fileInput');
const processingDiv   = document.getElementById('processing');
const processingText  = document.getElementById('processingText');
const previewDiv      = document.getElementById('preview');
const previewImage    = document.getElementById('previewImage');
const tweetTextarea   = document.getElementById('tweetText');
const charCount       = document.getElementById('charCount');
const postBtn         = document.getElementById('postBtn');
const resetBtn        = document.getElementById('resetBtn');
const successDiv      = document.getElementById('success');
const postedTweet     = document.getElementById('postedTweet');
const anotherBtn      = document.getElementById('anotherBtn');
const errorBar        = document.getElementById('errorBar');
const noImageWarning  = document.getElementById('noImageWarning');

// ── Init ─────────────────────────────────────────────────────────
async function init() {
  const cfg = await fetch('/api/config').then(r => r.json());
  hasImgbb = cfg.hasImgbb;
}

// ── Drag & drop ──────────────────────────────────────────────────
dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', e => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file && file.type.startsWith('image/')) handleFile(file);
  else showError('Please drop an image file.');
});
fileInput.addEventListener('change', () => {
  if (fileInput.files[0]) handleFile(fileInput.files[0]);
});

// ── Image normalizer ─────────────────────────────────────────────
async function normalizeToJpeg(file) {
  const MAX_PX  = 1920;
  const QUALITY = 0.75;
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      let w = img.naturalWidth, h = img.naturalHeight;
      if (w > MAX_PX || h > MAX_PX) {
        if (w >= h) { h = Math.round(h * MAX_PX / w); w = MAX_PX; }
        else        { w = Math.round(w * MAX_PX / h); h = MAX_PX; }
      }
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      canvas.toBlob(blob => {
        URL.revokeObjectURL(url);
        resolve(new File([blob], file.name.replace(/\\.[^.]+$/, '.jpg'), { type: 'image/jpeg' }));
      }, 'image/jpeg', QUALITY);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not load image')); };
    img.src = url;
  });
}

// ── File handling ─────────────────────────────────────────────────
async function handleFile(rawFile) {
  clearError();
  let file;
  try { file = await normalizeToJpeg(rawFile); }
  catch (e) { showError('Could not read image: ' + e.message); return; }

  currentImageFile    = file;
  currentImageDataUrl = await readAsDataUrl(file);

  showScreen('processing');
  processingText.textContent = 'Reading slip with Gemini…';

  const formData = new FormData();
  formData.append('image', file);

  try {
    const resp = await fetch('/api/analyze', { method: 'POST', body: formData });
    const json = await resp.json();
    if (!resp.ok || json.error) throw new Error(json.error || 'Analysis failed');

    tweetTextarea.value      = json.tweet;
    previewImage.src         = currentImageDataUrl;
    noImageWarning.style.display = hasImgbb ? 'none' : 'block';
    updateCharCount();
    showScreen('preview');
  } catch (err) {
    showScreen('drop');
    showError('❌ ' + err.message);
  }
}

// ── Post tweet ────────────────────────────────────────────────────
postBtn.addEventListener('click', async () => {
  const tweet = tweetTextarea.value.trim();
  if (!tweet) { showError('Tweet text is empty.'); return; }
  if (tweet.length > 280) { showError('Tweet exceeds 280 characters.'); return; }

  postBtn.disabled = true;
  postBtn.innerHTML = '<span class="spinner" style="width:20px;height:20px;border-width:2px;display:inline-block"></span> Posting…';
  clearError();

  const formData = new FormData();
  formData.append('tweet', tweet);
  formData.append('image', currentImageFile);

  try {
    const resp = await fetch('/api/post', { method: 'POST', body: formData });
    const json = await resp.json();
    if (!resp.ok || json.error) throw new Error(json.error || 'Post failed');

    postedTweet.textContent = tweet;
    showScreen('success');
  } catch (err) {
    showError('❌ ' + err.message);
    postBtn.disabled = false;
    postBtn.innerHTML = '<span>𝕏</span> Post to Twitter/X Now';
  }
});

// ── Reset ─────────────────────────────────────────────────────────
function reset() {
  currentImageFile    = null;
  currentImageDataUrl = null;
  fileInput.value     = '';
  tweetTextarea.value = '';
  charCount.textContent = '0 / 280';
  charCount.classList.remove('over');
  postBtn.disabled  = false;
  postBtn.innerHTML = '<span>𝕏</span> Post to Twitter/X Now';
  clearError();
  showScreen('drop');
}
resetBtn.addEventListener('click', reset);
anotherBtn.addEventListener('click', reset);

// ── Char count ────────────────────────────────────────────────────
tweetTextarea.addEventListener('input', updateCharCount);
function updateCharCount() {
  const len = tweetTextarea.value.length;
  charCount.textContent = len + ' / 280';
  charCount.classList.toggle('over', len > 280);
}

// ── Screen management ─────────────────────────────────────────────
function showScreen(screen) {
  dropZone.style.display      = screen === 'drop'       ? 'flex'  : 'none';
  processingDiv.style.display = screen === 'processing' ? 'flex'  : 'none';
  previewDiv.style.display    = screen === 'preview'    ? 'block' : 'none';
  successDiv.style.display    = screen === 'success'    ? 'flex'  : 'none';
}

// ── Helpers ───────────────────────────────────────────────────────
function showError(msg) { errorBar.textContent = msg; errorBar.style.display = 'block'; }
function clearError()   { errorBar.style.display = 'none'; }
function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// ── Boot ──────────────────────────────────────────────────────────
init();
</script>
</body>
</html>`;
