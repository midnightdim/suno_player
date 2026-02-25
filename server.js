const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── In-memory auth store ───────────────────────────────────────────────────
let auth = null; // { authorization, deviceId, createdAt }

// ─── Helpers ────────────────────────────────────────────────────────────────

function loadSessions() {
  try {
    if (fs.existsSync(SESSIONS_FILE)) {
      return JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('Failed to load sessions:', e.message);
  }
  return {};
}

function saveSessions(data) {
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify(data, null, 2), 'utf8');
}

async function fetchSunoClip(id) {
  const clip = {
    id,
    audioUrl: `https://cdn1.suno.ai/${id}.mp3`,
    imageUrl: `https://cdn2.suno.ai/image_${id}.jpeg`,
    title: null,
    style: null,
    duration: null,
  };

  if (!auth) return clip;

  try {
    const res = await fetch(`https://studio-api.prod.suno.com/api/clip/${id}`, {
      headers: {
        'Authorization': auth.authorization,
        'Content-Type': 'application/json',
        ...(auth.deviceId ? { 'Device-Id': auth.deviceId } : {}),
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Gecko/20100101 Firefox/147.0',
      },
    });

    if (res.ok) {
      const data = await res.json();
      clip.title = data.title || null;
      clip.style = data.metadata?.tags || data.metadata?.prompt || null;
      clip.imageUrl = data.image_url || data.image_large_url || clip.imageUrl;
      clip.audioUrl = data.audio_url || clip.audioUrl;
      clip.duration = data.metadata?.duration || null;
    }
  } catch (e) {
    console.error(`Failed to fetch metadata for ${id}:`, e.message);
  }

  return clip;
}

async function fetchWorkspaceIds(workspaceId) {
  if (!auth) throw new Error('Auth required to fetch workspace');

  const allIds = [];
  let currentCursor = null;
  let pageIndex = 0;
  const BASE = 'https://studio-api.prod.suno.com/api/feed/v3';

  while (true) {
    const bodyObj = {
      cursor: currentCursor,
      limit: 20,
      filters: {
        disliked: 'False',
        trashed: 'False',
        fromStudioProject: { presence: 'False' },
        stem: { presence: 'False' },
        workspace: { presence: 'True', workspaceId },
      },
      page: pageIndex,
    };

    const res = await fetch(BASE, {
      method: 'POST',
      headers: {
        'Authorization': auth.authorization,
        'Content-Type': 'application/json',
        ...(auth.deviceId ? { 'Device-Id': auth.deviceId } : {}),
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Gecko/20100101 Firefox/147.0',
      },
      body: JSON.stringify(bodyObj),
    });

    if (!res.ok) throw new Error(`Suno API error: ${res.status}`);

    const data = await res.json();
    const clips = data?.clips ?? [];

    if (!clips.length) break;

    clips.forEach(c => {
      if (c?.id) {
        allIds.push({
          id: c.id,
          title: c.title || null,
          style: c.metadata?.tags || c.metadata?.prompt || null,
          imageUrl: c.image_url || c.image_large_url || `https://cdn2.suno.ai/image_${c.id}.jpeg`,
          audioUrl: c.audio_url || `https://cdn1.suno.ai/${c.id}.mp3`,
          duration: c.metadata?.duration || null,
        });
      }
    });

    console.log(`📄 Page ${pageIndex} → ${clips.length} clips (total: ${allIds.length})`);

    if (!data.has_more || !data.next_cursor) break;
    currentCursor = data.next_cursor;
    pageIndex++;

    await new Promise(r => setTimeout(r, 400));
  }

  return allIds;
}

// ─── Routes ─────────────────────────────────────────────────────────────────

// Auth management (server-level, not per-session)
app.post('/api/auth', (req, res) => {
  let { authorization, deviceId } = req.body;
  if (!authorization) {
    return res.status(400).json({ error: 'Authorization token is required' });
  }
  // Strip non-ASCII chars that break Node fetch headers (e.g. Unicode ellipsis from copy-paste)
  authorization = authorization.replace(/[^\x00-\x7F]/g, '').trim();
  auth = {
    authorization: authorization.startsWith('Bearer ') ? authorization : `Bearer ${authorization}`,
    deviceId: deviceId || null,
    createdAt: new Date().toISOString(),
  };
  console.log('Auth set at', auth.createdAt);
  res.json({ ok: true, createdAt: auth.createdAt });
});

app.get('/api/auth', (req, res) => {
  res.json({ active: !!auth, createdAt: auth?.createdAt || null });
});

// Sessions CRUD
app.get('/api/sessions', (req, res) => {
  const sessions = loadSessions();
  const list = Object.entries(sessions).map(([id, s]) => ({
    id,
    name: s.name,
    icon: s.icon || '🎧',
    locked: !!s.passwordHash,
    createdAt: s.createdAt,
    trackCount: s.tracks ? s.tracks.length : 0,
    ratedCount: s.ratings ? Object.values(s.ratings).filter(r => r.rating).length : 0,
  }));
  list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json(list);
});

app.get('/api/sessions/:id', (req, res) => {
  const sessions = loadSessions();
  const session = sessions[req.params.id];
  if (!session) return res.status(404).json({ error: 'Session not found' });
  if (session.passwordHash) return res.status(403).json({ error: 'Password required', locked: true });
  const { passwordHash, ...safe } = session;
  res.json(safe);
});

// Verify password and return session data
app.post('/api/sessions/:id/unlock', (req, res) => {
  const sessions = loadSessions();
  const session = sessions[req.params.id];
  if (!session) return res.status(404).json({ error: 'Session not found' });
  if (!session.passwordHash) {
    const { passwordHash, ...safe } = session;
    return res.json(safe);
  }
  const { password } = req.body;
  const hash = crypto.createHash('sha256').update(password || '').digest('hex');
  if (hash !== session.passwordHash) return res.status(403).json({ error: 'Wrong password' });
  const { passwordHash, ...safe } = session;
  res.json(safe);
});

app.post('/api/sessions', (req, res) => {
  const { name, tracks, icon, password } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });

  const sessions = loadSessions();
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  sessions[id] = {
    name,
    icon: icon || '🎧',
    tracks: tracks || [],
    ratings: {},
    createdAt: new Date().toISOString(),
    ...(password ? { passwordHash: crypto.createHash('sha256').update(password).digest('hex') } : {}),
  };
  saveSessions(sessions);
  res.json({ ok: true, id });
});

app.delete('/api/sessions/:id', (req, res) => {
  const sessions = loadSessions();
  delete sessions[req.params.id];
  saveSessions(sessions);
  res.json({ ok: true });
});

// Update session (save tracks, ratings, etc.)
app.put('/api/sessions/:id', (req, res) => {
  const sessions = loadSessions();
  const session = sessions[req.params.id];
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const { tracks, ratings, name } = req.body;
  if (tracks !== undefined) session.tracks = tracks;
  if (ratings !== undefined) session.ratings = ratings;
  if (name !== undefined) session.name = name;
  session.updatedAt = new Date().toISOString();

  saveSessions(sessions);
  res.json({ ok: true });
});

// Save a single rating within a session
app.post('/api/sessions/:id/rate', (req, res) => {
  const sessions = loadSessions();
  const session = sessions[req.params.id];
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const { trackId, rating, note, title, imageUrl, style } = req.body;
  if (!trackId) return res.status(400).json({ error: 'trackId is required' });

  if (!session.ratings) session.ratings = {};
  session.ratings[trackId] = {
    ...(session.ratings[trackId] || {}),
    ...(rating !== undefined ? { rating } : {}),
    ...(note !== undefined ? { note } : {}),
    ...(title !== undefined ? { title } : {}),
    ...(imageUrl !== undefined ? { imageUrl } : {}),
    ...(style !== undefined ? { style } : {}),
    updatedAt: new Date().toISOString(),
  };

  saveSessions(sessions);
  res.json({ ok: true });
});

// Fetch metadata for a batch of track IDs
app.post('/api/metadata', async (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'ids array is required' });
  }

  const BATCH_SIZE = 5;
  const results = [];

  for (let i = 0; i < ids.length; i += BATCH_SIZE) {
    const batch = ids.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.all(batch.map(id => fetchSunoClip(id)));
    results.push(...batchResults);
    if (i + BATCH_SIZE < ids.length) await new Promise(r => setTimeout(r, 200));
  }

  res.json({ tracks: results });
});

// Fetch all tracks from a Suno workspace
app.post('/api/workspace', async (req, res) => {
  const { workspaceId } = req.body;
  if (!workspaceId) return res.status(400).json({ error: 'workspaceId is required' });
  if (!auth) return res.status(401).json({ error: 'Auth token required. Set it first.' });

  try {
    const tracks = await fetchWorkspaceIds(workspaceId);
    res.json({ tracks, count: tracks.length });
  } catch (e) {
    console.error('Workspace fetch error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Export a session as downloadable JSON
app.get('/api/sessions/:id/export', (req, res) => {
  const sessions = loadSessions();
  const session = sessions[req.params.id];
  if (!session) return res.status(404).json({ error: 'Session not found' });

  res.setHeader('Content-Disposition', `attachment; filename=suno-session-${req.params.id}.json`);
  res.setHeader('Content-Type', 'application/json');
  res.json(session);
});

// ─── Start ──────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`🎵 Suno Player server running at http://localhost:${PORT}`);
});
