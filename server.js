const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const NodeID3 = require('node-id3');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const PROJECTS_FILE = path.join(DATA_DIR, 'projects.json');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── Helpers ────────────────────────────────────────────────────────────────

function friendlySunoError(status) {
  const map = {
    401: 'Auth token expired or invalid. Please paste a fresh Bearer token from Suno.',
    403: 'Access denied. Your token may have expired — try getting a new one from Suno.',
    404: 'Not found. Check that the workspace/playlist ID is correct.',
    429: 'Rate limited by Suno. Wait a moment and try again.',
  };
  if (map[status]) return map[status];
  if (status >= 500) return `Suno servers are having issues (${status}). Try again later.`;
  return `Suno API error: ${status}`;
}

function loadProjects() {
  try {
    if (fs.existsSync(PROJECTS_FILE)) {
      return JSON.parse(fs.readFileSync(PROJECTS_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('Failed to load projects:', e.message);
  }
  return {};
}

function saveProjects(data) {
  fs.writeFileSync(PROJECTS_FILE, JSON.stringify(data, null, 2), 'utf8');
}

// Ensure at least one default project exists for backwards compatibility if they have old sessions
function migrateLegacySessions() {
  const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
  if (fs.existsSync(SESSIONS_FILE)) {
    const legacy = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
    if (Object.keys(legacy).length > 0) {
      const projects = loadProjects();
      if (!projects['default']) {
        projects['default'] = {
          slug: 'default',
          title: 'Legacy Sessions',
          createdAt: new Date().toISOString(),
          sessions: legacy
        };
        saveProjects(projects);
      }
      // Backup the old file just in case
      fs.renameSync(SESSIONS_FILE, path.join(DATA_DIR, 'sessions.json.bak'));
      console.log('Migrated legacy sessions to "default" project.');
    }
  }
}
migrateLegacySessions();

async function fetchSunoClip(id, authObj = null) {
  const clip = {
    id,
    audioUrl: `https://cdn1.suno.ai/${id}.mp3`,
    imageUrl: `https://cdn2.suno.ai/image_${id}.jpeg`,
    title: null,
    style: null,
    duration: null,
  };

  if (!authObj) return clip;

  try {
    const res = await fetch(`https://studio-api.prod.suno.com/api/clip/${id}`, {
      headers: {
        'Authorization': authObj.authorization,
        'Content-Type': 'application/json',
        ...(authObj.deviceId ? { 'Device-Id': authObj.deviceId } : {}),
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

async function fetchWorkspaceIds(workspaceId, authObj) {
  if (!authObj) throw new Error('Auth required to fetch workspace');

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
        'Authorization': authObj.authorization,
        'Content-Type': 'application/json',
        ...(authObj.deviceId ? { 'Device-Id': authObj.deviceId } : {}),
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Gecko/20100101 Firefox/147.0',
      },
      body: JSON.stringify(bodyObj),
    });

    if (!res.ok) throw new Error(friendlySunoError(res.status));

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

async function fetchPlaylistTracks(playlistId) {
  const allTracks = [];
  let page = 1;

  while (true) {
    const url = `https://studio-api.prod.suno.com/api/playlist/${playlistId}?page=${page}`;
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Gecko/20100101 Firefox/147.0',
      },
    });

    if (!res.ok) throw new Error(friendlySunoError(res.status));

    const data = await res.json();
    const clips = data?.playlist_clips ?? [];

    if (!clips.length) break;

    clips.forEach(pc => {
      const c = pc.clip || pc;
      if (c?.id) {
        allTracks.push({
          id: c.id,
          title: c.title || null,
          style: c.metadata?.tags || c.metadata?.prompt || null,
          imageUrl: c.image_url || c.image_large_url || `https://cdn2.suno.ai/image_${c.id}.jpeg`,
          audioUrl: c.audio_url || `https://cdn1.suno.ai/${c.id}.mp3`,
          duration: c.metadata?.duration || null,
        });
      }
    });

    console.log(`🎵 Playlist page ${page} → ${clips.length} clips (total: ${allTracks.length})`);

    if (!data.has_more && clips.length < 20) break;
    page++;
    await new Promise(r => setTimeout(r, 400));
  }

  return allTracks;
}

// ─── Routes ─────────────────────────────────────────────────────────────────

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';

// Check admin password
function checkAdmin(req) {
  return req.headers['x-admin-password'] === ADMIN_PASSWORD;
}

// ─── Projects CRUD ───

app.get('/api/projects', (req, res) => {
  const projects = loadProjects();
  const list = Object.values(projects).map(p => ({
    slug: p.slug,
    title: p.title,
    description: p.description || '',
    locked: !!p.passwordHash,
    createdAt: p.createdAt,
    sessionCount: p.sessions ? Object.keys(p.sessions).length : 0
  }));
  list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json(list);
});

app.post('/api/projects', (req, res) => {
  const { title, slug, password, description } = req.body;
  if (!title || !slug) return res.status(400).json({ error: 'Title and slug required' });

  const projects = loadProjects();
  if (projects[slug]) return res.status(400).json({ error: 'Project slug already exists' });

  projects[slug] = {
    slug,
    title,
    description: description || '',
    sessions: {},
    createdAt: new Date().toISOString(),
    ...(password ? { passwordHash: crypto.createHash('sha256').update(password).digest('hex') } : {}),
  };
  saveProjects(projects);
  res.json({ ok: true, slug });
});

app.post('/api/projects/:slug/unlock', (req, res) => {
  const projects = loadProjects();
  const project = projects[req.params.slug];
  if (!project) return res.status(404).json({ error: 'Project not found' });
  if (!project.passwordHash) return res.json({ ok: true });

  const { password } = req.body;
  if (checkAdmin(req)) return res.json({ ok: true, admin: true });

  const hash = crypto.createHash('sha256').update(password || '').digest('hex');
  if (hash !== project.passwordHash) return res.status(403).json({ error: 'Wrong password' });
  res.json({ ok: true });
});

app.delete('/api/projects/:slug', (req, res) => {
  const projects = loadProjects();
  const project = projects[req.params.slug];
  if (!project) return res.status(404).json({ error: 'Project not found' });

  // Require admin or correct password
  let authorized = false;
  if (checkAdmin(req)) {
    authorized = true;
  } else if (!project.passwordHash) {
    authorized = true; // No password, anyone can delete (or you could restrict this)
  } else {
    const password = req.headers['x-project-password'];
    if (password) {
      const hash = crypto.createHash('sha256').update(password).digest('hex');
      if (hash === project.passwordHash) authorized = true;
    }
  }

  if (!authorized) return res.status(403).json({ error: 'Unauthorized to delete project' });

  delete projects[req.params.slug];
  saveProjects(projects);
  res.json({ ok: true });
});


// ─── Sessions CRUD ───

// Helper to reliably get a project's sessions map
function getProjectSessions(project) {
  if (!project.sessions) project.sessions = {};
  return project.sessions;
}

app.get('/api/projects/:slug/sessions', (req, res) => {
  const projects = loadProjects();
  const project = projects[req.params.slug];
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const sessions = getProjectSessions(project);
  const list = Object.entries(sessions).map(([id, s]) => ({
    id,
    name: s.name,
    icon: s.icon || '🎧',
    locked: !!s.passwordHash,
    createdAt: s.createdAt,
    trackCount: s.tracks ? s.tracks.length : 0,
    ratedCount: s.ratings ? Object.values(s.ratings).filter(r => r.rating).length : 0,
    workspaceId: s.workspaceId,
  }));
  list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json(list);
});

app.get('/api/projects/:slug/sessions/:id', (req, res) => {
  const projects = loadProjects();
  const project = projects[req.params.slug];
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const sessions = getProjectSessions(project);
  const session = sessions[req.params.id];
  if (!session) return res.status(404).json({ error: 'Session not found' });

  if (session.passwordHash && !checkAdmin(req)) {
    return res.status(403).json({ error: 'Password required', locked: true });
  }
  const { passwordHash, ...safe } = session;
  res.json(safe);
});

// Verify session password
app.post('/api/projects/:slug/sessions/:id/unlock', (req, res) => {
  const projects = loadProjects();
  const project = projects[req.params.slug];
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const sessions = getProjectSessions(project);
  const session = sessions[req.params.id];
  if (!session) return res.status(404).json({ error: 'Session not found' });

  if (checkAdmin(req)) return res.json({ ok: true, admin: true });

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

app.post('/api/projects/:slug/sessions', (req, res) => {
  const projects = loadProjects();
  const project = projects[req.params.slug];
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const sessions = getProjectSessions(project);

  const { name, tracks, icon, password, workspaceId } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });

  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  sessions[id] = {
    name,
    icon: icon || '🎧',
    tracks: tracks || [],
    ratings: {},
    createdAt: new Date().toISOString(),
    ...(workspaceId ? { workspaceId } : {}),
    ...(password ? { passwordHash: crypto.createHash('sha256').update(password).digest('hex') } : {}),
  };
  saveProjects(projects);
  res.json({ ok: true, id });
});

app.delete('/api/projects/:slug/sessions/:id', (req, res) => {
  const projects = loadProjects();
  const project = projects[req.params.slug];
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const sessions = getProjectSessions(project);
  const session = sessions[req.params.id];
  if (!session) return res.status(404).json({ error: 'Session not found' });

  // Require admin or correct password if session is locked
  let authorized = false;
  if (checkAdmin(req)) {
    authorized = true;
  } else if (!session.passwordHash) {
    authorized = true;
  } else {
    const password = req.headers['x-session-password'];
    if (password) {
      const hash = crypto.createHash('sha256').update(password).digest('hex');
      if (hash === session.passwordHash) authorized = true;
    }
  }

  if (!authorized) return res.status(403).json({ error: 'Unauthorized to delete session' });

  delete sessions[req.params.id];
  saveProjects(projects);
  res.json({ ok: true });
});

app.put('/api/projects/:slug/sessions/:id', (req, res) => {
  const projects = loadProjects();
  const project = projects[req.params.slug];
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const sessions = getProjectSessions(project);
  const session = sessions[req.params.id];
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const { tracks, newTracks, ratings, name, icon, workspaceId } = req.body;
  if (tracks !== undefined) session.tracks = tracks;
  if (newTracks !== undefined && Array.isArray(newTracks)) {
    const existingIds = new Set(session.tracks.map(t => t.id));
    for (const t of newTracks) {
      if (!existingIds.has(t.id)) {
        session.tracks.push(t);
      }
    }
  }
  if (ratings !== undefined) session.ratings = ratings;
  if (name !== undefined) session.name = name;
  if (icon !== undefined) session.icon = icon;
  if (workspaceId !== undefined) session.workspaceId = workspaceId;
  session.updatedAt = new Date().toISOString();

  saveProjects(projects);
  res.json({ ok: true });

});

app.post('/api/projects/:slug/sessions/:id/rate', (req, res) => {
  const projects = loadProjects();
  const project = projects[req.params.slug];
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const sessions = getProjectSessions(project);
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

  saveProjects(projects);
  res.json({ ok: true });
});

// Export a session as downloadable JSON
app.get('/api/projects/:slug/sessions/:id/export', (req, res) => {
  const projects = loadProjects();
  const project = projects[req.params.slug];
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const sessions = getProjectSessions(project);
  const session = sessions[req.params.id];
  if (!session) return res.status(404).json({ error: 'Session not found' });

  res.setHeader('Content-Disposition', `attachment; filename=suno-session-${req.params.id}.json`);
  res.setHeader('Content-Type', 'application/json');
  res.json(session);
});

// Fetch metadata for a batch of track IDs
app.post('/api/metadata', async (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'ids array is required' });
  }

  const authHeader = req.headers.authorization;
  const authObj = authHeader ? { authorization: authHeader, deviceId: req.headers['device-id'] } : null;

  const BATCH_SIZE = 5;
  const results = [];

  for (let i = 0; i < ids.length; i += BATCH_SIZE) {
    const batch = ids.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.all(batch.map(id => fetchSunoClip(id, authObj)));
    results.push(...batchResults);
    if (i + BATCH_SIZE < ids.length) await new Promise(r => setTimeout(r, 200));
  }

  res.json({ tracks: results });
});

// Fetch all tracks from a Suno workspace
app.post('/api/workspace', async (req, res) => {
  let { workspaceId } = req.body;
  if (!workspaceId) return res.status(400).json({ error: 'workspaceId is required' });

  const urlMatch = workspaceId.match(/(?:workspace\/|wid=)([a-f0-9-]{36})/i);
  if (urlMatch) workspaceId = urlMatch[1];

  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Auth token required. Set it first.' });
  const authObj = { authorization: authHeader, deviceId: req.headers['device-id'] };

  try {
    const tracks = await fetchWorkspaceIds(workspaceId, authObj);
    res.json({ tracks, count: tracks.length });
  } catch (e) {
    console.error('Workspace fetch error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Fetch all tracks from a Suno playlist (no auth needed)
app.post('/api/playlist', async (req, res) => {
  let { playlistId } = req.body;
  if (!playlistId) return res.status(400).json({ error: 'playlistId is required' });

  // Extract UUID from full URL if needed
  const urlMatch = playlistId.match(/playlist\/([a-f0-9-]{36})/i);
  if (urlMatch) playlistId = urlMatch[1];

  try {
    const tracks = await fetchPlaylistTracks(playlistId);
    res.json({ tracks, count: tracks.length });
  } catch (e) {
    console.error('Playlist fetch error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

function fetchBuffer(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode >= 400) return resolve(null);
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

app.get('/api/download/:id', async (req, res) => {
  const url = `https://cdn1.suno.ai/${req.params.id}.mp3`;

  const rawTitle = req.query.title || req.params.id;
  const safeFilename = rawTitle.replace(/[\/\\?%*:|"<>]/g, '-').trim() || req.params.id;

  try {
    const mp3Buffer = await fetchBuffer(url);
    if (!mp3Buffer) return res.status(404).send('File not found or unreachable');

    const tags = {
      title: rawTitle,
      artist: 'Suno AI',
      album: req.query.style || 'Suno Generations',
    };

    if (req.query.image) {
      const imgBuffer = await fetchBuffer(req.query.image);
      if (imgBuffer) {
        tags.image = {
          mime: "jpeg",
          type: { id: 3, name: "front cover" },
          description: "Cover",
          imageBuffer: imgBuffer
        };
      }
    }

    const taggedBuffer = NodeID3.write(tags, mp3Buffer);

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}.mp3"`);
    res.send(taggedBuffer);
  } catch (e) {
    res.status(500).send(e.message);
  }
});

app.get('/:slug', (req, res, next) => {
  if (req.params.slug === 'api') return next();
  res.sendFile(path.join(__dirname, 'public', 'project.html'));
});

// ─── Start ──────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`🎵 Suno Player server running at http://localhost:${PORT}`);
});
