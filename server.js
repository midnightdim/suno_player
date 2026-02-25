const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const RATINGS_FILE = path.join(DATA_DIR, 'ratings.json');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── In-memory session store ────────────────────────────────────────────────
let session = null;

// ─── Helpers ────────────────────────────────────────────────────────────────

function loadRatings() {
  try {
    if (fs.existsSync(RATINGS_FILE)) {
      return JSON.parse(fs.readFileSync(RATINGS_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('Failed to load ratings:', e.message);
  }
  return {};
}

function saveRatings(data) {
  fs.writeFileSync(RATINGS_FILE, JSON.stringify(data, null, 2), 'utf8');
}

async function fetchSunoClip(id) {
  // Try the public metadata endpoint first (no auth needed for public songs)
  // Fall back to constructing CDN URLs
  const clip = {
    id,
    audioUrl: `https://cdn1.suno.ai/${id}.mp3`,
    imageUrl: `https://cdn2.suno.ai/image_${id}.jpeg`,
    title: null,
    style: null,
    duration: null,
  };

  if (!session) return clip;

  try {
    const res = await fetch(`https://studio-api.prod.suno.com/api/clip/${id}`, {
      headers: {
        'Authorization': session.authorization,
        'Content-Type': 'application/json',
        ...(session.deviceId ? { 'Device-Id': session.deviceId } : {}),
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

// ─── Routes ─────────────────────────────────────────────────────────────────

// Session management
app.post('/api/session', (req, res) => {
  const { authorization, deviceId } = req.body;
  if (!authorization) {
    return res.status(400).json({ error: 'Authorization token is required' });
  }
  session = {
    authorization: authorization.startsWith('Bearer ') ? authorization : `Bearer ${authorization}`,
    deviceId: deviceId || null,
    createdAt: new Date().toISOString(),
  };
  console.log('Session created at', session.createdAt);
  res.json({ ok: true, createdAt: session.createdAt });
});

app.get('/api/session', (req, res) => {
  res.json({ active: !!session, createdAt: session?.createdAt || null });
});

// Fetch metadata for a batch of track IDs
app.post('/api/metadata', async (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'ids array is required' });
  }

  // Process in small batches to avoid hammering the API
  const BATCH_SIZE = 5;
  const results = [];

  for (let i = 0; i < ids.length; i += BATCH_SIZE) {
    const batch = ids.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.all(batch.map(id => fetchSunoClip(id)));
    results.push(...batchResults);

    // Small delay between batches
    if (i + BATCH_SIZE < ids.length) {
      await new Promise(r => setTimeout(r, 200));
    }
  }

  res.json({ tracks: results });
});

// Ratings CRUD
app.get('/api/ratings', (req, res) => {
  res.json(loadRatings());
});

app.post('/api/ratings', (req, res) => {
  const { trackId, rating, note, title, imageUrl, style } = req.body;
  if (!trackId) {
    return res.status(400).json({ error: 'trackId is required' });
  }

  const ratings = loadRatings();
  ratings[trackId] = {
    ...(ratings[trackId] || {}),
    ...(rating !== undefined ? { rating } : {}),
    ...(note !== undefined ? { note } : {}),
    ...(title !== undefined ? { title } : {}),
    ...(imageUrl !== undefined ? { imageUrl } : {}),
    ...(style !== undefined ? { style } : {}),
    updatedAt: new Date().toISOString(),
  };

  saveRatings(ratings);
  res.json({ ok: true });
});

// Bulk save ratings (for import/sync)
app.post('/api/ratings/bulk', (req, res) => {
  const { ratings: incoming } = req.body;
  if (!incoming || typeof incoming !== 'object') {
    return res.status(400).json({ error: 'ratings object is required' });
  }

  const existing = loadRatings();
  Object.assign(existing, incoming);
  saveRatings(existing);
  res.json({ ok: true, count: Object.keys(existing).length });
});

// Delete a track from ratings
app.delete('/api/ratings/:trackId', (req, res) => {
  const ratings = loadRatings();
  delete ratings[req.params.trackId];
  saveRatings(ratings);
  res.json({ ok: true });
});

// Export ratings as downloadable JSON
app.get('/api/export', (req, res) => {
  const ratings = loadRatings();
  res.setHeader('Content-Disposition', 'attachment; filename=suno-ratings.json');
  res.setHeader('Content-Type', 'application/json');
  res.json(ratings);
});

// ─── Start ──────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`🎵 Suno Player server running at http://localhost:${PORT}`);
});
