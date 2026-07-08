# Tokenwald — Product Prototype (Fit 4 Start)

Compliance-aware gold tokenization-as-a-service on the XRP Ledger.
Landing page, live playground, jurisdiction copilot, tokenization advisor and
investor dashboards — with the playground executing **real XRPL Testnet
transactions** behind the polished UI.

## Setup

Requires Node.js 18+.

```bash
npm install
npm start
```

Then open **http://localhost:4600**.

### Enabling the Jurisdiction Copilot chat (Claude Sonnet 5)

The Copilot's **"Brainstorm a country's tokenization laws"** chat calls the Anthropic
API (model `claude-sonnet-5`). Put your key in the `.env` file at the project root:

```
ANTHROPIC_API_KEY=sk-ant-api03-your-key-here
```

Then `npm start` — the server auto-loads `.env` (via `dotenv`). Get a key at
**https://console.anthropic.com → Settings → API keys**. `.env` is git-ignored, so
your key never gets committed.

Alternatively, set `ANTHROPIC_API_KEY` as an environment variable before `npm start`
(`export ...` on macOS/Linux, `$env:ANTHROPIC_API_KEY = "..."` in PowerShell).

Without the key, the rest of the app runs normally and the chat returns a clear
"key not set" message instead of a reply.

- With the server running, the Dealer Console badge reads **LIVE · XRPL TESTNET**
  and every playground step submits real transactions. Each ledger entry links
  to https://testnet.xrpl.org — click any hash to verify it on-chain.
- If you open `public/index.html` without the server, the playground falls back
  to its built-in simulation (badge reads SIMULATION · TESTNET-PARITY).
- A full live run takes a few minutes: every transaction waits for real
  Testnet ledger validation. Fresh wallets are created each run; use
  "Restart run" to reset.

## What runs where

| Layer | Status |
| --- | --- |
| Wallets + faucet funding | Real (XRPL Testnet faucet) |
| Proof-of-reserve publication | **Real** — reserve grams + gold spot published on-ledger via the native Price Oracle (XLS-47 `OracleSet`) |
| Secure Mint | **Real enforcement logic** — the server refuses `MPTokenIssuanceCreate` unless attested reserve covers the mint; the demo shows a blocked over-mint, a custodian top-up, then an approved mint |
| Permissioned domain | Real (`PermissionedDomainSet`, XLS-80) |
| Credentials (gold-kyc, vara-recognition) | Real (`CredentialCreate` / `CredentialAccept`) |
| Gold token TWG | Real MPT (`MPTokenIssuanceCreate` with RequireAuth, 1 TWG = 1 g) |
| Compliance gate / resale restriction | Real — transfers to unauthorized wallets fail on-ledger with `tecNO_AUTH` |
| Live Token (compliance dNFT) | Real (`NFTokenMint` with `tfMutable`; every compliance event is a real `NFTokenModify`, versioned state served at `/api/compliance/vN`) |
| Gold spot price | Real (api.gold-api.com, keyless; labeled mock fallback if unreachable) |
| **Vault feed & partner names** | **Simulated** — the bar-list attestation in `server/vaultFeed.js` is illustrative data standing in for a real vault bar-list/API (e.g. BullionVault or an LBMA operator's attestation). The named institutions (Loomis International, Malca-Amit, Brink's, BullionVault; auditors Inspectorate International, Bureau Veritas) are the integration standard the layer is built against, **not signed partners** |
| KYC | Sandbox provider: identity-document checksum + **live country-registry check (api.worldbank.org)** + demo sanctions list + simulated liveness. Swap in a production provider (Sumsub / Didit / Onfido) behind `server/kyc.js`'s `verify()` once API keys exist |
| Redemption atomicity | Two sequential legs — Batch (XLS-56) is not live on Testnet yet; XRP settles the cash leg (RLUSD rail in production) |
| Copilot brainstorm chat | **Real** — Claude Sonnet 5 via the Anthropic API (`server/copilot.js`), requires `ANTHROPIC_API_KEY` |
| Tokenization Advisor plan | **Real (on demand)** — "Model this plan with Claude Sonnet 5" (`server/advisor.js`) generates the recommended issuance, tranche schedule, SaaS tier, risk flags and adoption/volatility model that drive the cards and projection chart. Falls back to a live in-browser estimate until you run it; requires `ANTHROPIC_API_KEY` |
| Copilot regulation analysis | **Real** — "Analyze & draft compliance profile" sends pasted regulation text to Claude Sonnet 5 (`server/copilot.js`), which returns the structured profile; falls back to a labelled offline analysis if the key is unset or the model is unreachable |
| Dashboards market feed | Simulated / in-browser |

## Project layout

```
public/            The product UI (landing, playground, copilot, advisor, dashboards)
server/
  index.js         Express server: static frontend + streaming step API
  run.js           Live XRPL Testnet run: all 8 playground steps as NDJSON event streams
  vaultFeed.js     Simulated allocated-vault bar-list attestation + vault-partner config
  kyc.js           KYC provider (sandbox, pluggable for production providers)
  priceFeed.js     Gold spot price (keyless live API + labeled mock fallback)
  copilot.js       Jurisdiction Copilot brainstorm chat (Claude Sonnet 5, Anthropic API)
  advisor.js       Tokenization Advisor plan generator (Claude Sonnet 5, Anthropic API)
```

## API

- `GET  /api/status` — live-mode probe (network, explorer, vault partners)
- `POST /api/step/0..7` — execute a playground step on Testnet, streaming NDJSON events
- `POST /api/reset` — discard the run, start fresh wallets
- `GET  /api/compliance/vN` — versioned Live-Token compliance state (the dNFT's URI target)
- `GET  /api/price` — current gold spot
- `POST /api/kyc/verify` — KYC check `{ subject, name, country, docNumber }`
- `POST /api/copilot/chat` — Copilot brainstorm chat `{ country, messages }` → `{ reply }` (Claude Sonnet 5; needs `ANTHROPIC_API_KEY`)
- `POST /api/copilot/analyze` — Regulation → compliance profile `{ preset, text }` → `{ profile, model }` (Claude Sonnet 5; needs `ANTHROPIC_API_KEY`)
- `POST /api/advisor/plan` — Advisor plan `{ vaultKg, spot, monthlySales, kycPct, jurisdictions, risk }` → `{ plan, model, inputs }` (Claude Sonnet 5; needs `ANTHROPIC_API_KEY`)
```
