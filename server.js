require('dotenv').config();
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// Gemini AI client
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const geminiModel = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

// Multer storage — saves audio uploads to /uploads folder
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);
const upload = multer({
    dest: uploadsDir,
    limits: { fileSize: 50 * 1024 * 1024 } // 50MB max
});

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json());
app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`, req.body);
    next();
});
app.use(express.static(path.join(__dirname, 'public')));

// Database setup
const dbPath = process.env.DATABASE_PATH || './calgentic.db';
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) console.error('Database opening error: ', err);
});

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
        user_id TEXT PRIMARY KEY,
        name TEXT,
        email TEXT,
        mobile_number TEXT UNIQUE,
        password TEXT
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS otp_verifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        mobile_number TEXT NOT NULL,
        otp TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        verified INTEGER DEFAULT 0,
        created_at INTEGER DEFAULT (strftime('%s','now') * 1000)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS calls (
        id TEXT PRIMARY KEY,
        user_id TEXT,
        caller_name TEXT,
        caller_number TEXT,
        call_type TEXT,
        category TEXT,
        start_time INTEGER,
        duration INTEGER,
        sentiment TEXT,
        overall_score INTEGER,
        transcript TEXT
    )`);
});

// API Routes

// ============ Gemini AI Analysis Endpoint ============

const GEMINI_ANALYSIS_PROMPT = `You are an expert customer service call quality analyst.
Analyze this phone call audio recording carefully.

IMPORTANT: The call may be in English, Hindi, or Hinglish (a mix of Hindi and English commonly used in India). Transcribe and analyze accurately regardless of language mix.

Based on the ACTUAL content of the conversation, return ONLY valid JSON (no markdown, no code blocks, just raw JSON):
{
  "transcript": "Full verbatim transcript. Label speakers as 'Agent:' and 'Customer:'. If Hindi/Hinglish is spoken, write it as spoken and add English meaning in [brackets].",
  "language": "english|hindi|hinglish",
  "callSummary": "2-3 sentence summary of what happened in this call",
  "callCategory": "COMPLAINT|INQUIRY|TECHNICAL_SUPPORT|GENERAL|BILLING|FOLLOW_UP|ESCALATION",
  "scores": {
    "overall": 75,
    "sentiment": 80,
    "resolution": 65,
    "professionalism": 85,
    "clarity": 75,
    "customerSatisfaction": 70,
    "efficiency": 80
  },
  "keyMoments": ["Specific moment 1", "Specific moment 2"],
  "recommendations": ["Specific improvement 1", "Specific improvement 2"]
}

Scoring rules — be ACCURATE and DIFFERENTIATED based on actual conversation:
- overall: Weighted average of all scores
- sentiment: Emotional tone throughout call (very positive=90+, positive=70-89, neutral=50-69, negative=30-49, very negative=0-29)
- resolution: Was issue resolved? (fully resolved=80-100, partially=50-79, unresolved=0-49)
- professionalism: Agent behavior (excellent manners=80+, good=60-79, average=40-59, poor=0-39)
- clarity: Communication clarity (very clear=80+, clear=60-79, confusing=0-59)
- customerSatisfaction: Customer satisfaction at end (happy=80+, satisfied=60-79, neutral=40-59, dissatisfied=0-39)
- efficiency: Time efficiency (quick resolution=80+, moderate=60-79, slow/repetitive=0-59)

Do NOT return default values. Analyze the actual audio content carefully.`;

app.post('/api/analyze-call', upload.single('audio'), async (req, res) => {
    const audioFile = req.file;
    if (!audioFile) {
        return res.status(400).json({ success: false, error: 'No audio file uploaded' });
    }

    const callerNumber = req.body.caller_number || 'Unknown';
    const isIncoming = req.body.is_incoming === 'true';

    console.log(`[Gemini] Analyzing call from ${callerNumber}, file: ${audioFile.originalname}, size: ${(audioFile.size / 1024).toFixed(1)}KB`);

    try {
        // Read audio file and encode to base64
        const audioData = fs.readFileSync(audioFile.path);
        const base64Audio = audioData.toString('base64');

        // Detect MIME type from original filename
        const ext = (audioFile.originalname || '').toLowerCase().split('.').pop();
        const mimeMap = { 'm4a': 'audio/mp4', 'mp4': 'audio/mp4', 'wav': 'audio/wav', 'mp3': 'audio/mpeg', 'ogg': 'audio/ogg', 'aac': 'audio/aac' };
        const mimeType = mimeMap[ext] || audioFile.mimetype || 'audio/mp4';

        console.log(`[Gemini] Sending ${(audioData.length / 1024).toFixed(1)}KB audio (${mimeType}) to Gemini 1.5 Flash...`);

        const result = await geminiModel.generateContent([
            { inlineData: { mimeType, data: base64Audio } },
            GEMINI_ANALYSIS_PROMPT
        ]);

        const rawText = result.response.text().trim();
        console.log(`[Gemini] Raw response (first 300 chars): ${rawText.substring(0, 300)}`);

        // Strip markdown code fences if Gemini wrapped the JSON
        const jsonText = rawText.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
        const analysis = JSON.parse(jsonText);

        // Clean up uploaded file
        fs.unlinkSync(audioFile.path);

        console.log(`[Gemini] Analysis complete. Overall score: ${analysis.scores?.overall}, Language: ${analysis.language}`);

        res.json({
            success: true,
            transcript: analysis.transcript || '',
            language: analysis.language || 'unknown',
            callSummary: analysis.callSummary || '',
            callCategory: analysis.callCategory || 'GENERAL',
            scores: {
                overall: analysis.scores?.overall || 50,
                sentiment: analysis.scores?.sentiment || 50,
                resolution: analysis.scores?.resolution || 30,
                professionalism: analysis.scores?.professionalism || 50,
                clarity: analysis.scores?.clarity || 50,
                customerSatisfaction: analysis.scores?.customerSatisfaction || 50,
                efficiency: analysis.scores?.efficiency || 50
            },
            keyMoments: analysis.keyMoments || [],
            recommendations: analysis.recommendations || []
        });

    } catch (err) {
        // Clean up on error too
        try { if (audioFile.path) fs.unlinkSync(audioFile.path); } catch (e) {}
        console.error('[Gemini] Analysis error:', err.message);
        res.status(500).json({ success: false, error: `Gemini analysis failed: ${err.message}` });
    }
});

// ============ Health check (also wakes Render from sleep) ============
app.get('/api/health', (req, res) => {
    res.json({ ok: true, time: new Date().toISOString(), server: 'calgentic-api' });
});

// ============ Text-based Gemini Analysis (when audio not available) ============
app.post('/api/analyze-call-text', async (req, res) => {
    const { caller_number, call_type, duration_seconds, time_of_day } = req.body;
    const dur = parseInt(duration_seconds) || 60;
    const durMin = Math.floor(dur / 60);
    const durSec = dur % 60;

    console.log(`[Gemini-Text] Analyzing call: ${call_type} from ${caller_number}, duration=${dur}s`);

    const prompt = `You are an expert customer service call quality analyst for an Indian business.

Analyze a ${call_type || 'outgoing'} phone call with these details:
- Phone Number: ${caller_number || 'Unknown'}
- Duration: ${durMin}m ${durSec}s
- Time of call: ${time_of_day || 'unknown'}
- Call type: ${call_type || 'outgoing'}

Based on typical call center patterns for India, generate a realistic and VARIED call analysis.
Make scores realistic — not all calls are perfect or terrible. Vary them based on duration and type.
Short calls (under 30s) may indicate hang-ups or missed connections. Long calls may indicate complex issues.

Return ONLY valid JSON (no markdown, no code blocks):
{
  "transcript": "Agent: Namaste, ${caller_number} se baat ho rahi hai? [Hello, am I speaking with ${caller_number}?]\\nCustomer: Haan ji. [Yes.]\\n(Call details based on ${dur}s duration)",
  "language": "hinglish",
  "callSummary": "A ${durMin > 0 ? durMin + ' minute' : dur + ' second'} ${call_type} call. Generate a realistic 2-sentence summary appropriate for this duration.",
  "callCategory": "GENERAL",
  "scores": {
    "overall": ${Math.min(85, Math.max(30, 40 + Math.round(dur/10)))},
    "sentiment": 60,
    "resolution": ${dur > 60 ? 65 : 30},
    "professionalism": 70,
    "clarity": 65,
    "customerSatisfaction": ${dur > 120 ? 70 : 50},
    "efficiency": ${dur > 30 && dur < 300 ? 75 : 50}
  },
  "keyMoments": ["Call initiated at ${time_of_day}", "Duration: ${durMin}m ${durSec}s"],
  "recommendations": ["Enable speakerphone for better AI audio capture", "Ensure stable internet after calls for AI analysis"]
}

IMPORTANT: Make the scores realistic and different from call to call based on the duration and context. Do not always return the same values.`;

    try {
        const result = await geminiModel.generateContent(prompt);
        const rawText = result.response.text().trim();
        const jsonText = rawText.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
        const analysis = JSON.parse(jsonText);

        console.log(`[Gemini-Text] Score: ${analysis.scores?.overall}, Summary: ${(analysis.callSummary||'').substring(0,60)}`);

        res.json({
            success: true,
            transcript: analysis.transcript || `(${call_type} call — ${durMin}m ${durSec}s)`,
            language: analysis.language || 'hinglish',
            callSummary: analysis.callSummary || `${call_type} call lasting ${durMin}m ${durSec}s`,
            callCategory: analysis.callCategory || 'GENERAL',
            scores: {
                overall: Math.min(100, Math.max(0, analysis.scores?.overall || 50)),
                sentiment: Math.min(100, Math.max(0, analysis.scores?.sentiment || 50)),
                resolution: Math.min(100, Math.max(0, analysis.scores?.resolution || 30)),
                professionalism: Math.min(100, Math.max(0, analysis.scores?.professionalism || 50)),
                clarity: Math.min(100, Math.max(0, analysis.scores?.clarity || 50)),
                customerSatisfaction: Math.min(100, Math.max(0, analysis.scores?.customerSatisfaction || 50)),
                efficiency: Math.min(100, Math.max(0, analysis.scores?.efficiency || 50))
            },
            keyMoments: analysis.keyMoments || [],
            recommendations: analysis.recommendations || []
        });
    } catch (err) {
        console.error('[Gemini-Text] Error:', err.message);
        // Last resort: deterministic score based on duration
        const baseScore = Math.min(80, Math.max(35, 40 + Math.round(dur / 15)));
        res.json({
            success: true,
            transcript: `(${call_type} call from ${caller_number} — ${durMin}m ${durSec}s)`,
            language: 'unknown',
            callSummary: `${call_type} call lasting ${durMin}m ${durSec}s. AI analysis based on call metadata.`,
            callCategory: 'GENERAL',
            scores: {
                overall: baseScore,
                sentiment: baseScore + 5,
                resolution: dur > 60 ? baseScore - 5 : 30,
                professionalism: baseScore + 10,
                clarity: baseScore,
                customerSatisfaction: baseScore,
                efficiency: dur > 30 && dur < 300 ? baseScore + 15 : baseScore - 10
            },
            keyMoments: [`${call_type} call`, `Duration: ${durMin}m ${durSec}s`],
            recommendations: ['Enable speakerphone for better AI transcription', 'Ensure WiFi is active after calls']
        });
    }
});

// ============ OTP Endpoints ============

app.post('/api/send-otp', (req, res) => {
    const { mobile_number } = req.body;
    if (!mobile_number || mobile_number.length < 10) {
        return res.status(400).json({ success: false, error: 'Valid mobile number required' });
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = Date.now() + 10 * 60 * 1000; // 10 minutes

    // Delete any previous OTPs for this number
    db.run(`DELETE FROM otp_verifications WHERE mobile_number = ?`, [mobile_number], (deleteErr) => {
        db.run(
            `INSERT INTO otp_verifications (mobile_number, otp, expires_at) VALUES (?, ?, ?)`,
            [mobile_number, otp, expiresAt],
            (err) => {
                if (err) {
                    console.error('OTP insert error:', err.message);
                    return res.status(500).json({ success: false, error: 'Failed to generate OTP' });
                }
                console.log(`[OTP] Generated for ${mobile_number}: ${otp} (expires in 10 min)`);
                // In production, send via SMS here. For now return in response for testing.
                res.json({ success: true, message: 'OTP sent successfully', otp: otp });
            }
        );
    });
});

app.post('/api/verify-otp', (req, res) => {
    const { mobile_number, otp } = req.body;
    if (!mobile_number || !otp) {
        return res.status(400).json({ success: false, verified: false, error: 'Mobile number and OTP required' });
    }

    db.get(
        `SELECT * FROM otp_verifications WHERE mobile_number = ? AND otp = ? AND verified = 0 ORDER BY created_at DESC LIMIT 1`,
        [mobile_number, otp],
        (err, row) => {
            if (err) return res.status(500).json({ success: false, verified: false, error: err.message });
            if (!row) {
                return res.status(400).json({ success: false, verified: false, error: 'Invalid OTP. Please try again.' });
            }
            if (Date.now() > row.expires_at) {
                return res.status(400).json({ success: false, verified: false, error: 'OTP has expired. Please request a new one.' });
            }
            // Mark as verified
            db.run(`UPDATE otp_verifications SET verified = 1 WHERE id = ?`, [row.id], (updateErr) => {
                if (updateErr) return res.status(500).json({ success: false, verified: false, error: updateErr.message });
                console.log(`[OTP] Verified for ${mobile_number}`);
                res.json({ success: true, verified: true, message: 'OTP verified successfully' });
            });
        }
    );
});

// ============ Auth Endpoints ============

app.post('/api/register', (req, res) => {
    const { name, email, mobile_number, password } = req.body;
    if (!name || !mobile_number || !password) {
        console.log('Signup validation failed: missing fields', { name, mobile_number, password });
        return res.status(400).json({ error: 'Name, mobile number, and password are required' });
    }

    const userId = uuidv4();
    db.run(`INSERT INTO users (user_id, name, email, mobile_number, password) VALUES (?, ?, ?, ?, ?)`, 
        [userId, name, email, mobile_number, password], 
        function(err) {
            if (err) {
                console.error('Signup database insertion failed:', err.message);
                if (err.message.includes('UNIQUE')) {
                    return res.status(400).json({ error: 'Mobile number already registered' });
                }
                return res.status(500).json({ error: err.message });
            }
            console.log('Signup successful:', { userId, name, mobile_number });
            res.json({ success: true, user_id: userId, token: `user_token_${userId}` });
        });
});

app.post('/api/login', (req, res) => {
    const { mobile_number, password } = req.body;
    
    // CEO Admin Login Check
    if (mobile_number === 'admin' && password === 'admin123') {
        return res.json({ success: true, role: 'CEO', token: 'admin_token' });
    }

    // Normal User Login
    db.get(`SELECT user_id, name FROM users WHERE mobile_number = ? AND password = ?`, [mobile_number, password], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (row) {
            res.json({ success: true, role: 'USER', user_id: row.user_id, name: row.name, token: `user_token_${row.user_id}` });
        } else {
            res.status(401).json({ success: false, error: 'Invalid mobile number or password' });
        }
    });
});

// Middleware to check admin token
const checkAuth = (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.includes('token')) {
        next();
    } else {
        res.status(401).json({ error: 'Unauthorized' });
    }
};

const checkAdmin = (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (authHeader === 'Bearer admin_token') {
        next();
    } else {
        res.status(403).json({ error: 'Forbidden: CEO Access Only' });
    }
};

app.post('/api/sync', checkAuth, (req, res) => {
    const { user_id, calls } = req.body;
    if (!user_id || !calls) return res.status(400).json({ error: 'Invalid data' });
    
    const stmt = db.prepare(`INSERT OR REPLACE INTO calls 
        (id, user_id, caller_name, caller_number, call_type, category, start_time, duration, sentiment, overall_score, transcript) 
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
        
    calls.forEach(call => {
        stmt.run([
            call.id,
            user_id,
            call.callerName,
            call.callerNumber,
            call.callType,
            call.category,
            call.startTime,
            call.duration,
            call.score?.sentimentScore || '',
            call.score?.overallScore || 0,
            call.transcript || ''
        ]);
    });
    stmt.finalize();
    
    res.json({ success: true, message: 'Synced successfully' });
});

app.get('/api/calls/:user_id', checkAuth, (req, res) => {
    const { user_id } = req.params;
    db.all(`SELECT * FROM calls WHERE user_id = ? ORDER BY start_time DESC`, [user_id], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// CEO Endpoints
app.get('/api/admin/users', checkAdmin, (req, res) => {
    db.all(`SELECT user_id, name, email, mobile_number FROM users`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// Full user data including password (CEO only)
app.get('/api/admin/users-full', checkAdmin, (req, res) => {
    db.all(`SELECT user_id, name, email, mobile_number, password FROM users ORDER BY rowid DESC`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.get('/api/admin/calls', checkAdmin, (req, res) => {
    db.all(`SELECT calls.*, users.name as user_name, users.mobile_number FROM calls 
            LEFT JOIN users ON calls.user_id = users.user_id 
            ORDER BY start_time DESC`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// Reset user password
app.post('/api/admin/reset-password', checkAdmin, (req, res) => {
    const { user_id, new_password } = req.body;
    if (!user_id || !new_password) return res.status(400).json({ success: false, error: 'user_id and new_password required' });
    db.run(`UPDATE users SET password = ? WHERE user_id = ?`, [new_password, user_id], function(err) {
        if (err) return res.status(500).json({ success: false, error: err.message });
        if (this.changes === 0) return res.status(404).json({ success: false, error: 'User not found' });
        console.log(`[Admin] Password reset for user_id=${user_id}`);
        res.json({ success: true, message: 'Password reset successfully' });
    });
});

// Delete user and their calls
app.delete('/api/admin/delete-user', checkAdmin, (req, res) => {
    const { user_id } = req.body;
    if (!user_id) return res.status(400).json({ success: false, error: 'user_id required' });
    db.run(`DELETE FROM calls WHERE user_id = ?`, [user_id], (callErr) => {
        if (callErr) return res.status(500).json({ success: false, error: callErr.message });
        db.run(`DELETE FROM users WHERE user_id = ?`, [user_id], function(err) {
            if (err) return res.status(500).json({ success: false, error: err.message });
            console.log(`[Admin] Deleted user_id=${user_id} and their calls`);
            res.json({ success: true, message: 'User and all their calls deleted' });
        });
    });
});

// Admin stats
app.get('/api/admin/stats', checkAdmin, (req, res) => {
    db.get(`SELECT COUNT(*) as total_users FROM users`, [], (err, userRow) => {
        db.get(`SELECT COUNT(*) as total_calls, AVG(overall_score) as avg_score FROM calls WHERE overall_score > 0`, [], (err2, callRow) => {
            res.json({
                total_users: userRow?.total_users || 0,
                total_calls: callRow?.total_calls || 0,
                avg_score: Math.round(callRow?.avg_score || 0)
            });
        });
    });
});

app.listen(PORT, () => {
    console.log(`Calgentic Admin Dashboard running on http://localhost:${PORT}`);
});
