'use strict';

// Jurisdiction Copilot — LLM brainstorm chat.
// Lets a user pick a country and brainstorm that country's laws/regulatory
// posture for tokenizing real-world assets (gold, stablecoins, KYC/AML,
// licensing, custody, cross-border recognition). Powered by Claude Sonnet 5.

const Anthropic = require('@anthropic-ai/sdk');

const MODEL = 'claude-sonnet-5';

let client = null;
function getClient() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  // The SDK reads ANTHROPIC_API_KEY from the environment automatically.
  if (!client) client = new Anthropic();
  return client;
}

const SYSTEM = [
  "You are a tokenization-regulation research assistant for Tokenwald, a compliance-aware gold",
  "tokenization platform on the XRP Ledger (1 token = 1 gram of vault-backed gold, redeemable).",
  "The user gives you a COUNTRY and wants to brainstorm that country's laws and regulatory posture",
  "relevant to tokenizing real-world assets — especially gold / commodity-backed tokens, stablecoins",
  "and asset-referenced tokens, KYC/AML obligations, licensing triggers, custody, cross-border",
  "recognition, and redemption.",
  "Be concrete and practical: name the relevant regulators, regimes, and statutes where you can;",
  "flag licensing triggers, holder-eligibility limits, and filing obligations; call out uncertainty",
  "honestly rather than inventing specifics.",
  "This is general research to brainstorm with, NOT legal advice — remind the user to confirm with",
  "local counsel before relying on anything. Keep answers focused and well-structured; use short",
  "paragraphs or bullet points."
].join(' ');

// { country, messages:[{role:'user'|'assistant', content}] } -> { reply, model }
async function chat({ country, messages } = {}) {
  const anthropic = getClient();
  if (!anthropic) {
    const err = new Error(
      'ANTHROPIC_API_KEY is not set on the server. Set it (see README) to enable the live legal-brainstorm chat.'
    );
    err.status = 503;
    throw err;
  }

  const cleaned = (Array.isArray(messages) ? messages : [])
    .filter(
      (m) =>
        m &&
        (m.role === 'user' || m.role === 'assistant') &&
        typeof m.content === 'string' &&
        m.content.trim()
    )
    .slice(-20) // keep the last ~10 turns
    .map((m) => ({ role: m.role, content: m.content.slice(0, 8000) }));

  if (!cleaned.length || cleaned[0].role !== 'user') {
    const err = new Error('Chat must start with a user message.');
    err.status = 400;
    throw err;
  }

  const c = country && String(country).trim();
  const system = c
    ? SYSTEM +
      `\n\nThe user's country of interest for this conversation is: ${c}. ` +
      'Center your answers on that jurisdiction unless the user asks otherwise.'
    : SYSTEM;

  const resp = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system,
    // Keep the chat snappy; a brainstorm turn doesn't need extended thinking.
    thinking: { type: 'disabled' },
    messages: cleaned
  });

  const reply = resp.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();

  return { reply: reply || '(no response)', model: resp.model };
}

// { preset, text } -> { profile, model }
// Analyzes pasted regulation text into a structured compliance profile.
async function analyze({ text } = {}) {
  const anthropic = getClient();
  if (!anthropic) {
    const err = new Error(
      'ANTHROPIC_API_KEY is not set on the server. Set it (see README) to analyze with Claude.'
    );
    err.status = 503;
    throw err;
  }

  const t = String(text || '').slice(0, 6000);
  if (t.trim().length < 40) {
    const err = new Error('Provide more regulation text (40+ characters) to analyze.');
    err.status = 400;
    throw err;
  }

  const resp = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1500,
    thinking: { type: 'disabled' },
    system: 'You are a crypto-asset regulation analyst. Output ONLY valid JSON, no markdown fences.',
    messages: [
      {
        role: 'user',
        content:
          'Analyze this regulation text for an issuer of redeemable vault-backed gold tokens ' +
          '(1 token = 1 g) on XRPL. Emit JSON with keys: jurisdiction, regulatoryRegime, ' +
          'tokenClassification, holderEligibility, kycCredentialRequirements (array), ' +
          'transferRestrictions, redemptionRestrictions, requiredFilings (array), ' +
          'crossBorderRecognitionSteps (array), riskFlags (array). Text:\n' + t
      }
    ]
  });

  const out = resp.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  const profile = extractJson(out);
  if (!profile) {
    const err = new Error('Model did not return valid JSON.');
    err.status = 502;
    throw err;
  }
  return { profile, model: resp.model };
}

// Robustly pull a JSON object out of the model's reply (handles markdown fences
// or a stray sentence around the object).
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

module.exports = { chat, analyze, MODEL };
