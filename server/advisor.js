'use strict';

// Tokenization Advisor — Claude Sonnet 5 generates the strategy decision
// (recommended issuance, phased tranches, SaaS tier, risk flags, and an
// adoption/volatility model). The frontend renders the existing stat cards,
// cap gauge, tranche schedule, and Monte-Carlo fan chart from this output.

const Anthropic = require('@anthropic-ai/sdk');

const MODEL = 'claude-sonnet-5';
const CAP = 5000000; // MiCA Art. 16(2) exemption cap (EUR)

let client = null;
function getClient() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!client) client = new Anthropic();
  return client;
}

const num = (v, d) => (Number.isFinite(+v) ? +v : d);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

async function plan(input = {}) {
  const anthropic = getClient();
  if (!anthropic) {
    const e = new Error('ANTHROPIC_API_KEY is not set on the server. Set it (see README) to model the plan with Claude.');
    e.status = 503;
    throw e;
  }

  const vaultKg = num(input.vaultKg, 250);
  const spot = num(input.spot, 104.2) || 104.2;
  const monthlySales = num(input.monthlySales, 400000);
  const kycPct = num(input.kycPct, 35);
  const jurisdictions = (Array.isArray(input.jurisdictions) ? input.jurisdictions : ['EU / MiCA'])
    .slice(0, 8).map(String);
  const risk = ['conservative', 'balanced', 'aggressive'].includes(input.risk) ? input.risk : 'balanced';

  const user =
`Operation profile for a gold dealer tokenizing vault gold as an XRPL MPT (1 token = 1 g, redeemable), staying under the MiCA Art. 16(2) exemption cap of EUR 5,000,000.
- Vault gold on hand: ${vaultKg} kg (${vaultKg * 1000} g)
- Gold spot: EUR ${spot}/g
- Avg monthly retail gold sales: EUR ${monthlySales}
- Customers already KYC-ready: ${kycPct}%
- Target buyer jurisdictions: ${jurisdictions.join(', ')}
- Risk appetite: ${risk}

Recommend an initial tokenization plan. Hard constraints:
- recommendedGrams * spot must be strictly under EUR 5,000,000
- recommendedGrams <= 60% of vault grams
- recommendedGrams >= 2000
Provide a 3-tranche phased rollout whose pct values sum to 1.0 (e.g. months 0 / 4 / 9). Pick a SaaS tier by projected notional: Starter (< EUR 1.2M, "EUR 490/mo"), Growth (EUR 1.2M-3.2M, "EUR 1,200/mo"), Scale (> EUR 3.2M, "EUR 2,900/mo"). Give realistic risk/compliance flags specific to this profile and its jurisdictions. Give an adoption central estimate (fraction 0.4-1.15 of the tokenized notional reached by month 12) and a volatility spread (0.10-0.45), both reflecting the risk appetite and KYC readiness.

Output ONLY valid JSON (no markdown fences), exactly this shape:
{"recommendedGrams": 5159, "rationale": "2-3 sentence explanation", "tier": {"name": "Starter", "fee": "EUR 490/mo"}, "tranches": [{"name": "Tranche 1 - launch", "month": 0, "pct": 0.4}, {"name": "Tranche 2 - traction", "month": 4, "pct": 0.35}, {"name": "Tranche 3 - scale", "month": 9, "pct": 0.25}], "riskFlags": ["..."], "adoption": 0.8, "volatility": 0.25}`;

  const resp = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1200,
    thinking: { type: 'disabled' },
    system: 'You are a tokenization strategy analyst for a MiCA-scoped gold RWA issuer. Output ONLY valid JSON matching the requested shape exactly — no prose, no markdown fences.',
    messages: [{ role: 'user', content: user }]
  });

  const text = resp.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  const raw = extractJson(text);
  if (!raw) {
    const e2 = new Error('Model did not return valid JSON.');
    e2.status = 502;
    throw e2;
  }

  return {
    plan: sanitize(raw, { vaultKg, spot }),
    model: resp.model,
    inputs: { vaultKg, spot, monthlySales, kycPct, jurisdictions, risk }
  };
}

function extractJson(s) {
  const cleaned = String(s).replace(/```json|```/g, '').trim();
  const candidates = [cleaned];
  const first = cleaned.indexOf('{');
  const last = cleaned.lastIndexOf('}');
  if (first >= 0 && last > first) candidates.push(cleaned.slice(first, last + 1));
  for (const c of candidates) {
    try {
      const v = JSON.parse(c);
      if (v && typeof v === 'object') return v;
    } catch (e) { /* try next */ }
  }
  return null;
}

function sanitize(r, { vaultKg, spot }) {
  const vaultG = vaultKg * 1000;
  const maxByCap = Math.floor((CAP - 1) / spot);
  let recG = Math.round(num(r.recommendedGrams, 2000));
  recG = Math.max(2000, Math.min(recG, Math.floor(vaultG * 0.6), maxByCap));

  const defaults = [
    { name: 'Tranche 1 - launch', month: 0, pct: 0.4 },
    { name: 'Tranche 2 - traction', month: 4, pct: 0.35 },
    { name: 'Tranche 3 - scale', month: 9, pct: 0.25 }
  ];
  let tr = Array.isArray(r.tranches) ? r.tranches.slice(0, 3) : [];
  while (tr.length < 3) tr.push(defaults[tr.length]);
  const sum = tr.reduce((a, t) => a + Math.max(0, num(t && t.pct, 0)), 0) || 1;
  tr = tr.map((t, i) => ({
    name: String((t && t.name) || defaults[i].name),
    month: Math.round(num(t && t.month, defaults[i].month)),
    pct: Math.max(0, num(t && t.pct, defaults[i].pct)) / sum
  }));

  const feeByName = { Starter: 'EUR 490/mo', Growth: 'EUR 1,200/mo', Scale: 'EUR 2,900/mo' };
  const tierName = ['Starter', 'Growth', 'Scale'].includes(r.tier && r.tier.name) ? r.tier.name : 'Starter';
  const tier = { name: tierName, fee: feeByName[tierName] };

  const riskFlags = (Array.isArray(r.riskFlags) ? r.riskFlags : [])
    .map(String).map((s) => s.trim()).filter(Boolean).slice(0, 6);

  return {
    recG,
    tranches: tr,
    tier,
    riskFlags,
    adoption: clamp(num(r.adoption, 0.8), 0.4, 1.15),
    volatility: clamp(num(r.volatility, 0.25), 0.1, 0.45),
    rationale: String(r.rationale || '').slice(0, 600)
  };
}

module.exports = { plan, MODEL };
