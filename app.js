require('dotenv').config();

const path = require('path');
const express = require('express');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');

const { testDbConnection } = require('./config/db');
const { runMigrations } = require('./scripts/run_migrations');
const { ensureAdminUser } = require('./services/userService');

const v1Router = require('./routes/v1');
const adminRouter = require('./routes/admin');
const errorHandler = require('./middleware/errorHandler');

const app = express();
const PORT = Number(process.env.PORT || 3000);

app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(morgan('tiny'));

app.get('/healthz', (req, res) => res.json({ ok: true, ts: Date.now() }));

app.use('/api/v1', v1Router);
app.use('/api/admin', adminRouter);

app.use('/admin', express.static(path.join(__dirname, 'public', 'admin')));
app.get('/admin', (req, res) => res.redirect('/admin/login.html'));
app.get('/', (req, res) => res.redirect('/admin/login.html'));

app.use(errorHandler);

async function start() {
  await testDbConnection();
  await runMigrations();
  await ensureAdminUser();
  app.listen(PORT, () => {
    console.log(`[OK] lanzou-resource-hub listening on :${PORT}`);
    console.log(`[OK] Admin UI:      http://127.0.0.1:${PORT}/admin/login.html`);
    console.log(`[OK] Public API v1: http://127.0.0.1:${PORT}/api/v1/*`);
  });
}

start().catch((err) => {
  console.error('[FATAL] Startup failed:', err);
  process.exit(1);
});
