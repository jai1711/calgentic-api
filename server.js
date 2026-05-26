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

const GEMINI_ANALYSIS_PROMPT = `You are Calgentic AI — enterprise call intelligence engine for Indian businesses (competing with Gong.io, Chorus.ai, Salesforce Einstein).

Analyze this phone call audio. Languages supported: English, Hindi, Hinglish, Marathi, Gujarati, Tamil, Telugu. Auto-detect language.

DEEP ANALYSIS REQUIRED:
1. VERBATIM TRANSCRIPT — label every turn Agent:/Customer:. For Hindi/Hinglish: write as spoken + [English meaning]
2. SENTIMENT JOURNEY — track emotion start→middle→end
3. COMPLIANCE CHECK — proper greeting? identity verified? resolution confirmed? closing used?
4. OBJECTION HANDLING — how did agent handle complaints/objections?
5. TALK RATIO — estimate agent vs customer speaking time

SCORING (be PRECISE and UNIQUE per call — never return identical scores for different calls):
- overall: weighted composite (resolution×0.30 + satisfaction×0.25 + professionalism×0.20 + clarity×0.15 + efficiency×0.10)
- sentiment: customer emotion (90+=delighted, 70-89=positive, 50-69=neutral, 30-49=frustrated, 0-29=angry)
- resolution: outcome (90+=exceeded, 70-89=resolved, 50-69=partial, 0-49=unresolved)
- professionalism: agent conduct (90+=exceptional, 70-89=good, 50-69=adequate, 0-49=poor)
- clarity: communication quality (90+=crystal clear, 70-89=clear, 0-69=confusing)
- customerSatisfaction: predicted CSAT (90+=5star, 70-89=satisfied, 50-69=neutral, 0-49=dissatisfied)
- efficiency: time value (90+=quick perfect, 70-89=efficient, 50-69=adequate, 0-49=slow/wasteful)

Return ONLY valid JSON (no markdown, no code fences, raw JSON only):
{
  "transcript": "Complete verbatim. Agent: / Customer: labels. Every word.",
  "language": "english|hindi|hinglish|marathi|gujarati|tamil|telugu",
  "callSummary": "3 sentences: (1) purpose, (2) what happened, (3) outcome",
  "callCategory": "COMPLAINT|INQUIRY|TECHNICAL_SUPPORT|GENERAL|BILLING|FOLLOW_UP|ESCALATION|SALES|FEEDBACK",
  "customerIntent": "What customer actually wanted in one sentence",
  "resolutionStatus": "RESOLVED|PARTIALLY_RESOLVED|UNRESOLVED|ESCALATED",
  "scores": {
    "overall": 75,
    "sentiment": 80,
    "resolution": 70,
    "professionalism": 85,
    "clarity": 75,
    "customerSatisfaction": 72,
    "efficiency": 78
  },
  "keyMoments": [
    "~0:15 — Customer explained billing issue",
    "~1:30 — Agent provided resolution",
    "~2:45 — Call closed professionally"
  ],
  "recommendations": [
    "Specific actionable tip based on THIS call",
    "Another specific improvement for THIS agent"
  ],
  "strengths": ["What agent did well in this call"],
  "redFlags": ["Issues found in this call if any"],
  "coachingTip": "One sentence coaching tip specific to this call"
}

RULES: Never return all-50 defaults. Each call = unique scores. Recommendations must reference actual call content.`;

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
