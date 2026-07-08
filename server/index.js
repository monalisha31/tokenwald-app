'use strict';

// Load environment variables from a local .env file (e.g. ANTHROPIC_API_KEY).
require('dotenv').config();

const path = require('path');
const express = require('express');
const { Run, EXPLORER } = require('./run');
const { vaultPartners } = require('./vaultFeed');
const { fetchGoldPriceUSDPerGram } = require('./priceFeed');
const kyc = require('./kyc');
const copilot = require('./copilot');
const advisor = require('./advisor');

const PORT = process.env.PORT || 4600;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

let run = new Run(BASE_URL);

app.get('/api/status', (req, res) => {
  res.json({
    live: true,
    network: 'XRPL Testnet',
    explorer: EXPLORER,
    stepsDone: [...run.done],
    vaultPartners
  });
});

app.post('/api/reset', async (req, res) => {
  const old = run;
  run = new Run(BASE_URL);
  old.dispose();
  res.json({ ok: true });
});

// Streams NDJSON events while the step executes real Testnet transactions,
// so the UI can render each one the moment it validates.
app.post('/api/step/:i', async (req, res) => {
  const i = Number(req.params.i);
  if (!(i >= 0 && i <= 7)) return res.status(400).json({ error: 'bad step' });

  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Cache-Control', 'no-cache');
  const emit = (ev) => res.write(JSON.stringify(ev) + '\n');

  try {
    await run.runStep(i, emit, req.body || {});
    emit({ kind: 'done' });
  } catch (err) {
    emit({ kind: 'error', message: String(err.message || err) });
  }
  res.end();
});

app.get('/api/compliance/v:n', (req, res) => {
  const state = run.complianceVersions[Number(req.params.n)];
  if (!state) return res.status(404).json({ error: 'no such version' });
  res.json(state);
});

app.get('/api/price', async (req, res) => {
  res.json(await fetchGoldPriceUSDPerGram());
});

app.post('/api/kyc/verify', async (req, res) => {
  res.json(await kyc.verify(req.body || {}));
});

// Launch email list. Entries are stored in server/waitlist.json for the
// tokenwald@gmail.com inbox owner to import; swap for an email service
// (e.g. Mailchimp/Buttondown) before public launch.
const fs = require('fs');
const WAITLIST_FILE = path.join(__dirname, 'waitlist.json');
app.post('/api/waitlist', (req, res) => {
  const email = String((req.body && req.body.email) || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'invalid email' });
  let list = [];
  try { list = JSON.parse(fs.readFileSync(WAITLIST_FILE, 'utf8')); } catch (e) {}
  if (!list.some((e) => e.email === email)) {
    list.push({ email, ts: new Date().toISOString(), contact: 'tokenwald@gmail.com' });
    fs.writeFileSync(WAITLIST_FILE, JSON.stringify(list, null, 2));
  }
  res.json({ ok: true });
});

// Jurisdiction Copilot brainstorm chat — Claude Sonnet 5 (see server/copilot.js).
app.post('/api/copilot/chat', async (req, res) => {
  try {
    res.json(await copilot.chat(req.body || {}));
  } catch (err) {
    res.status(err.status || 500).json({ error: String(err.message || err) });
  }
});

// Copilot regulation analysis → structured compliance profile — Claude Sonnet 5.
app.post('/api/copilot/analyze', async (req, res) => {
  try {
    res.json(await copilot.analyze(req.body || {}));
  } catch (err) {
    res.status(err.status || 500).json({ error: String(err.message || err) });
  }
});

// Tokenization Advisor plan — Claude Sonnet 5 (see server/advisor.js).
app.post('/api/advisor/plan', async (req, res) => {
  try {
    res.json(await advisor.plan(req.body || {}));
  } catch (err) {
    res.status(err.status || 500).json({ error: String(err.message || err) });
  }
});

app.listen(PORT, () => {
  console.log(`Tokenwald app running:`);
  console.log(`  Frontend:  ${BASE_URL}`);
  console.log(`  API:       ${BASE_URL}/api/status`);
  console.log(`  Network:   XRPL Testnet (live transactions, explorer: ${EXPLORER})`);
});
