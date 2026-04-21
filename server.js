const express = require('express');
const cors = require('cors');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Helper: fetch URL via Node https
function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

// Helper: clean escaped strings from YouTube JSON
function cleanStr(s) {
  return (s || '')
    .replace(/\\u0026/g, '&')
    .replace(/\\u003c/g, '<')
    .replace(/\\u003e/g, '>')
    .replace(/\\n/g, ' ')
    .replace(/\\\//g, '/')
    .replace(/\\"/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();
}

// Helper: format seconds to MM:SS or HH:MM:SS
function formatTime(seconds) {
  const s = Math.floor(seconds);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}:${String(m % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

// Helper: parse XML transcript
function parseXml(xml) {
  const lines = [];
  const regex = /<text[^>]+start="([\d.]+)"[^>]*>([\s\S]*?)<\/text>/g;
  let match;
  while ((match = regex.exec(xml)) !== null) {
    const seconds = parseFloat(match[1]);
    const raw = match[2]
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, ' ')
      .replace(/&#\d+;/g, m => String.fromCharCode(parseInt(m.replace(/&#|;/g, ''))))
      .trim();
    if (raw) lines.push({ seconds, time: formatTime(seconds), text: raw });
  }
  return lines;
}

// ── MAIN ROUTE ──────────────────────────────────────────
app.get('/transcript', async (req, res) => {
  const { videoId, lang } = req.query;

  if (!videoId) {
    return res.status(400).json({ error: 'videoId parameter required' });
  }

  const langCode = lang || 'en';

  try {
    // Step 1: Fetch YouTube page
    const ytUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const html = await fetchUrl(ytUrl);

    if (!html || html.length < 500) {
      return res.status(500).json({ error: 'Could not load YouTube page' });
    }

    // Step 2: Extract video title
    let title = 'Unknown Title';
    const titleMatch = html.match(/"title":"(.*?)(?<!\\)"/);
    if (titleMatch) title = cleanStr(titleMatch[1]);

    // Step 3: Extract caption tracks
    let allTracks = [];

    try {
      const bm = html.match(/"captionTracks":([\s\S]*?\])/);
      if (bm) {
        const cleaned = bm[1]
          .replace(/\\u0026/g, '&')
          .replace(/\\\//g, '/')
          .replace(/\\"/g, '"');
        allTracks = JSON.parse(cleaned);
      }
    } catch (e) {
      allTracks = [];
    }

    // Fallback regex if JSON parse failed
    if (!allTracks.length) {
      const matches = [...html.matchAll(/"baseUrl":"(https:\/\/www\.youtube\.com\/api\/timedtext[^"]+)"/g)];
      allTracks = matches.map(m => ({ baseUrl: cleanStr(m[1]) }));
    }

    if (!allTracks.length) {
      return res.status(404).json({
        error: 'No captions found. This video may not have subtitles enabled.'
      });
    }

    // Step 4: Pick best language
    const preferred = allTracks.find(t => t.languageCode === langCode)
      || allTracks.find(t => t.languageCode === 'en')
      || allTracks.find(t => t.kind !== 'asr')
      || allTracks[0];

    const captionUrl = preferred.baseUrl || '';
    if (!captionUrl || !captionUrl.startsWith('http')) {
      return res.status(500).json({ error: 'No valid caption URL found' });
    }

    // Step 5: Fetch transcript XML
    const xmlText = await fetchUrl(captionUrl);

    if (!xmlText || !xmlText.includes('<text')) {
      return res.status(500).json({ error: 'Transcript XML unavailable' });
    }

    // Step 6: Parse and return
    const transcript = parseXml(xmlText);

    if (!transcript.length) {
      return res.status(500).json({ error: 'Transcript is empty after parsing' });
    }

    res.json({
      success: true,
      videoId,
      title,
      language: langCode,
      count: transcript.length,
      transcript
    });

  } catch (err) {
    res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'TranscriptX Backend is running!', version: '1.0' });
});

app.listen(PORT, () => {
  console.log(`TranscriptX backend running on port ${PORT}`);
});
      
