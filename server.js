/**
 * SERVER.JS - Final Production Build
 * Architecture: Node.js + MongoDB Atlas + Cloudinary
 * Run with: node server.js
 */
require('dotenv').config();
const express = require('express');
const session = require('cookie-session');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const axios = require('axios');
const mongoose = require('mongoose');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const cloudinary = require('cloudinary').v2;

// --- CONFIGURATION ---
const PORT = process.env.PORT || 3000;
const ADMIN_IDS = ['1192320766402908194']; // Your Discord ID

// 1. Cloudinary Config
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

// 2. FFmpeg Setup
ffmpeg.setFfmpegPath(ffmpegPath);

// 3. MongoDB Connection
if (!process.env.MONGO_URI) {
    console.error("❌ CRITICAL: MONGO_URI is missing from .env file");
    process.exit(1);
}
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('✅ Connected to MongoDB Atlas'))
    .catch(err => console.error('❌ MongoDB Connection Error:', err));

// --- SCHEMAS ---
const Project = mongoose.model('Project', new mongoose.Schema({ 
    title: String, 
    image: String, 
    order: { type: Number, default: 0 } 
}));

const Review = mongoose.model('Review', new mongoose.Schema({ 
    name: String, 
    feedback: String, 
    stars: Number, 
    date: { type: String, default: () => new Date().toLocaleDateString() }, 
    avatar: String, 
    order: { type: Number, default: 0 } 
}));

const Music = mongoose.model('Music', new mongoose.Schema({ 
    title: String, 
    artist: String, 
    file: String, 
    cover: String, 
    order: { type: Number, default: 0 } 
}));

const Setting = mongoose.model('Setting', new mongoose.Schema({ 
    key: String, 
    value: String 
}));

const ViewCounter = mongoose.model('ViewCounter', new mongoose.Schema({ 
    count: { type: Number, default: 1400 } 
}));

// --- MIDDLEWARE ---
const app = express();

// Ensure temp folder exists for uploads before they go to cloud
if (!fs.existsSync('./temp')) fs.mkdirSync('./temp');

app.use(cors());
app.use(express.static('public')); // Serves index.html
app.use('/assets', express.static('assets')); // Serves static assets like favicon
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));
app.use(session({
    name: 'session',
    keys: [process.env.SESSION_KEY || 'secretKey1', process.env.SESSION_KEY2 || 'secretKey2'],
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
}));

// --- MULTER (Temporary Storage) ---
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, 'temp/'),
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname);
        cb(null, Date.now() + '-' + Math.round(Math.random() * 1E9) + ext);
    }
});
const upload = multer({ storage, limits: { fileSize: 100 * 1024 * 1024 } }); // 100MB Limit per file

// --- HELPER: Cloudinary Upload & Cleanup ---
async function uploadToCloudinary(localPath, folder, resourceType = 'auto') {
    try {
        const result = await cloudinary.uploader.upload(localPath, {
            folder: `axel_portfolio/${folder}`,
            resource_type: resourceType,
            use_filename: true,
            unique_filename: false
        });
        // Delete local temp file after successful upload
        if (fs.existsSync(localPath)) fs.unlinkSync(localPath);
        return result.secure_url;
    } catch (error) {
        console.error("Cloudinary Upload Failed:", error);
        // Try to delete temp file even if upload failed
        if (fs.existsSync(localPath)) fs.unlinkSync(localPath);
        throw error;
    }
}

// --- AUTHENTICATION (Discord) ---
const DISCORD_CLIENT_ID = process.env.CLIENT_ID;
const DISCORD_CLIENT_SECRET = process.env.CLIENT_SECRET;
const DISCORD_REDIRECT_URI = 'https://realistic-portfolio.onrender.com/auth/discord';

const requireAdmin = (req, res, next) => {
    if (!req.session.user?.isAdmin) return res.status(403).json({ error: 'Unauthorized' });
    next();
};

app.get('/auth/discord', (req, res) => {
    res.redirect(`https://discord.com/api/oauth2/authorize?client_id=${DISCORD_CLIENT_ID}&redirect_uri=${encodeURIComponent(DISCORD_REDIRECT_URI)}&response_type=code&scope=identify`);
});

app.get('/auth/discord/callback', async (req, res) => {
    const { code } = req.query;
    if (!code) return res.redirect('/');
    try {
        const tokenRes = await axios.post('https://discord.com/api/oauth2/token', new URLSearchParams({
            client_id: DISCORD_CLIENT_ID,
            client_secret: DISCORD_CLIENT_SECRET,
            code,
            grant_type: 'authorization_code',
            redirect_uri: DISCORD_REDIRECT_URI,
            scope: 'identify',
        }));
        const userRes = await axios.get('https://discord.com/api/users/@me', { headers: { Authorization: `Bearer ${tokenRes.data.access_token}` } });
        
        if (ADMIN_IDS.includes(userRes.data.id)) {
            req.session.user = { id: userRes.data.id, isAdmin: true };
        }
        res.redirect('/');
    } catch (err) {
        console.error("Auth Error:", err);
        res.redirect('/');
    }
});

app.get('/api/me', (req, res) => res.json(req.session.user || { isAdmin: false }));
app.post('/api/auth/logout', (req, res) => { req.session = null; res.json({ success: true }); });

// --- API ROUTES ---

// 1. SETTINGS (Global PFP)
app.get('/api/settings', async (req, res) => {
    const pfp = await Setting.findOne({ key: 'pfp' });
    res.json({ pfp: pfp ? pfp.value : '/assets/pfp.jpg' });
});

app.post('/api/settings/pfp', requireAdmin, upload.single('pfp'), async (req, res) => {
    if(!req.file) return res.status(400).send('No file');
    try {
        const url = await uploadToCloudinary(req.file.path, 'settings', 'image');
        await Setting.findOneAndUpdate({ key: 'pfp' }, { value: url }, { upsert: true });
        res.json({ pfp: url });
    } catch(e) { res.status(500).send(e.toString()); }
});

// 2. PROJECTS
app.get('/api/projects', async (req, res) => {
    const projects = await Project.find().sort({ order: 1 });
    // Map _id to id for frontend compatibility
    res.json(projects.map(p => ({ id: p._id, title: p.title, image: p.image })));
});

app.post('/api/projects', requireAdmin, upload.single('image'), async (req, res) => {
    try {
        const url = await uploadToCloudinary(req.file.path, 'projects', 'image');
        const newProject = new Project({ 
            title: req.body.title, 
            image: url, 
            order: -Date.now() 
        });
        await newProject.save();
        res.json({ ...newProject._doc, id: newProject._id });
    } catch(e) { res.status(500).send(e.toString()); }
});

app.delete('/api/projects/:id', requireAdmin, async (req, res) => {
    await Project.findByIdAndDelete(req.params.id);
    res.json({ success: true });
});

app.put('/api/projects/reorder', requireAdmin, async (req, res) => {
    const ops = req.body.map((id, index) => ({
        updateOne: { filter: { _id: id }, update: { order: index } }
    }));
    await Project.bulkWrite(ops);
    res.json({ success: true });
});

// 3. REVIEWS
app.get('/api/reviews', async (req, res) => {
    const reviews = await Review.find().sort({ order: 1 });
    res.json(reviews.map(r => ({ ...r._doc, id: r._id })));
});

app.post('/api/reviews', requireAdmin, upload.single('avatar'), async (req, res) => {
    try {
        let avatarUrl = 'https://cdn.discordapp.com/embed/avatars/0.png';
        if (req.file) {
            avatarUrl = await uploadToCloudinary(req.file.path, 'avatars', 'image');
        }
        const newReview = new Review({
            name: req.body.name,
            feedback: req.body.feedback,
            stars: parseInt(req.body.stars) || 5,
            avatar: avatarUrl,
            order: -Date.now()
        });
        await newReview.save();
        res.json({ ...newReview._doc, id: newReview._id });
    } catch(e) { res.status(500).send(e.toString()); }
});

app.delete('/api/reviews/:id', requireAdmin, async (req, res) => {
    await Review.findByIdAndDelete(req.params.id);
    res.json({ success: true });
});

app.put('/api/reviews/reorder', requireAdmin, async (req, res) => {
    const ops = req.body.map((id, index) => ({
        updateOne: { filter: { _id: id }, update: { order: index } }
    }));
    await Review.bulkWrite(ops);
    res.json({ success: true });
});

// 4. MUSIC (With FFmpeg Video-to-Audio)
app.get('/api/music', async (req, res) => {
    const music = await Music.find().sort({ order: 1 });
    res.json(music.map(m => ({ ...m._doc, id: m._id })));
});

app.post('/api/music', requireAdmin, upload.fields([{ name: 'audio', maxCount: 1 }, { name: 'cover', maxCount: 1 }]), async (req, res) => {
    try {
        if (!req.files || !req.files['audio']) return res.status(400).send('Audio/Video file required');
        
        // Handle Cover Art
        let coverUrl = 'https://placehold.co/400x400/101010/FFF';
        if (req.files['cover']) {
            coverUrl = await uploadToCloudinary(req.files['cover'][0].path, 'covers', 'image');
        }

        // Handle Audio/Video
        const file = req.files['audio'][0];
        let filePathToUpload = file.path;
        let resourceType = 'video'; // Cloudinary treats audio as video type

        // Convert Video to MP3 if necessary
        if (file.mimetype.startsWith('video/')) {
            const newFilename = file.filename.replace(path.extname(file.filename), '.mp3');
            const newPath = path.join('temp', newFilename);
            
            await new Promise((resolve, reject) => {
                ffmpeg(file.path).toFormat('mp3')
                    .on('error', reject)
                    .on('end', () => {
                        fs.unlinkSync(file.path); // Delete original large video file
                        resolve();
                    })
                    .save(newPath);
            });
            
            filePathToUpload = newPath;
        }

        // Upload to Cloudinary
        const audioUrl = await uploadToCloudinary(filePathToUpload, 'music', resourceType);

        const newMusic = new Music({
            title: req.body.title,
            artist: req.body.artist,
            file: audioUrl,
            cover: coverUrl,
            order: -Date.now()
        });
        await newMusic.save();
        res.json({ ...newMusic._doc, id: newMusic._id });

    } catch (e) { 
        console.error("Music Upload Error:", e);
        res.status(500).send(e.toString()); 
    }
});

app.delete('/api/music/:id', requireAdmin, async (req, res) => {
    await Music.findByIdAndDelete(req.params.id);
    res.json({ success: true });
});

app.put('/api/music/reorder', requireAdmin, async (req, res) => {
    const ops = req.body.map((id, index) => ({
        updateOne: { filter: { _id: id }, update: { order: index } }
    }));
    await Music.bulkWrite(ops);
    res.json({ success: true });
});

// 5. VIEW COUNTER
app.get('/api/view', async (req, res) => {
    let counter = await ViewCounter.findOne();
    if (!counter) counter = new ViewCounter();
    counter.count++;
    await counter.save();
    res.json(counter);
});

// --- START SERVER ---
app.listen(PORT, () => console.log(`🔥 Server running at http://localhost:${PORT}`));
