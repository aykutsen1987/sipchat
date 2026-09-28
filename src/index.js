require('dotenv').config();

const http = require('http');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { Server } = require('socket.io');

const authRoutes = require('./routes/auth.routes');
const chatsRoutes = require('./routes/chats.routes');
const mediaRoutes = require('./routes/media.routes');
const usersRoutes = require('./routes/users.routes');
const pushRoutes = require('./routes/push.routes');
const { attachSockets } = require('./sockets');

const app = express();
const server = http.createServer(app);

// --- Security & hardening -------------------------------------------------
app.use(helmet());
app.set('trust proxy', 1); // Render sits behind a reverse proxy

const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: allowedOrigins.length > 0 ? allowedOrigins : true,
    credentials: true,
  }),
);

app.use(express.json({ limit: '1mb' }));

// Generic API rate limit: 300 req / 15 min / IP.
app.use(
  '/api',
  rateLimit({ windowMs: 15 * 60 * 1000, max: 300, standardHeaders: true, legacyHeaders: false }),
);

// Tighter limit specifically on auth endpoints to slow down credential
// stuffing / brute-force attempts.
app.use(
  '/api/auth',
  rateLimit({ windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false }),
);

// --- Routes ----------------------------------------------------------------
app.get('/health', (req, res) => res.json({ status: 'ok' }));
app.use('/api/auth', authRoutes);
app.use('/api/chats', chatsRoutes);
app.use('/api/media', mediaRoutes);
app.use('/api/users', usersRoutes);
app.use('/api/push', pushRoutes);

app.use((req, res) => res.status(404).json({ error: 'Not found' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('Unhandled error', err);
  res.status(500).json({ error: 'Sunucu hatası.' });
});

// --- Real-time layer ---------------------------------------------------
const io = new Server(server, {
  cors: {
    origin: allowedOrigins.length > 0 ? allowedOrigins : true,
  },
});
app.set('io', io);
attachSockets(io);

const port = process.env.PORT || 3000;
server.listen(port, () => {
  console.log(`SipChat backend listening on port ${port}`);
});
