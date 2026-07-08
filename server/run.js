'use strict';

const xrpl = require('xrpl');
const { VaultFeed } = require('./vaultFeed');
const { fetchGoldPriceUSDPerGram } = require('./priceFeed');
const kyc = require('./kyc');

const TESTNET_WSS = 'wss://s.altnet.rippletest.net:51233';
const EXPLORER = 'https://testnet.xrpl.org';
const SOURCE_TAG = 20260530;

const TF_MPT_REQUIRE_AUTH = 0x00000004;
const TF_MPT_CAN_TRANSFER = 0x00000020;
const TF_MUTABLE = 0x00000010;

// Default mint size (grams / TWG). Overridden per run by Advisor seeding —
// the frontend passes `mintGrams` (Tranche 1 of the generated plan) and the
// vault feed calibrates so the blocked → top-up → approved narrative holds
// at any size. Clamped to keep faucet-funded demo wallets workable.
const DEFAULT_MINT = 8000;
const MINT_MIN = 1000;
const MINT_MAX = 100000;

const hex = (s) => Buffer.from(s).toString('hex').toUpperCase();
const GOLD_KYC_HEX = hex('gold-kyc');
const VARA_HEX = hex('vara-recognition');

// One live playground run against XRPL Testnet. Step methods emit NDJSON
// events (tx / note / patch / dnft / toast / alert) that the frontend replays.
class Run {
  constructor(baseUrl) {
    this.baseUrl = baseUrl;
    this.client = new xrpl.Client(TESTNET_WSS);
    this.vault = new VaultFeed();
    this.wallets = {}; // issuer, eu, dubai, partner, outsider
    this.mptIssuanceId = null;
    this.nftId = null;
    this.oracleDocId = 1;
    this.complianceVersions = [];
    this.done = new Set();
    this.spot = null;
    this.mintAmount = DEFAULT_MINT;
  }

  async connect() {
    if (!this.client.isConnected()) await this.client.connect();
  }

  async dispose() {
    try { if (this.client.isConnected()) await this.client.disconnect(); } catch (e) {}
  }

  txUrl(hash) { return `${EXPLORER}/transactions/${hash}`; }
  accountUrl(addr) { return `${EXPLORER}/accounts/${addr}`; }

  async submit(wallet, txTemplate, emit, desc, primitive, layer) {
    const tx = { ...txTemplate };
    if (tx.SourceTag === undefined) tx.SourceTag = SOURCE_TAG;
    const prepared = await this.client.autofill(tx);
    const signed = wallet.sign(prepared);
    const result = await this.client.submitAndWait(signed.tx_blob);
    const code = result.result.meta.TransactionResult;
    emit({
      kind: 'tx', desc, primitive, layer, real: true,
      result: code, hash: signed.hash, explorer: this.txUrl(signed.hash)
    });
    return { result, code, hash: signed.hash };
  }

  publishCompliance(patch) {
    const prev = this.complianceVersions[this.complianceVersions.length - 1] || {};
    const next = { ...JSON.parse(JSON.stringify(prev)), ...patch };
    this.complianceVersions.push(next);
    const v = this.complianceVersions.length - 1;
    return { version: v, state: next, uri: `${this.baseUrl}/api/compliance/v${v}` };
  }

  async updateDnft(emit, note, patch) {
    const { version, state, uri } = this.publishCompliance(patch);
    if (this.nftId) {
      await this.submit(
        this.wallets.issuer,
        { TransactionType: 'NFTokenModify', Account: this.wallets.issuer.classicAddress, NFTokenID: this.nftId, URI: hex(uri) },
        emit, `NFTokenModify · ${note} (v${version})`, 'Dynamic NFT (XLS-46)', 'dnft'
      );
    }
    emit({ kind: 'dnft', note, state: { ...state, version: `v${version}`, uri } });
    return version;
  }

  // Publish reserve grams + gold spot to the on-ledger price oracle (XLS-47).
  async publishOracle(emit, label) {
    const grams = this.vault.getTotalVerifiedReserveGrams();
    const price = this.spot || (await fetchGoldPriceUSDPerGram());
    this.spot = price;
    const now = Math.floor(Date.now() / 1000);
    const priceCents = Math.round(price.usdPerGram * 100);

    const { code, hash } = await this.submit(
      this.wallets.issuer,
      {
        TransactionType: 'OracleSet',
        Account: this.wallets.issuer.classicAddress,
        OracleDocumentID: this.oracleDocId,
        Provider: hex('tokenwald-vaultfeed'),
        AssetClass: hex('commodity'),
        LastUpdateTime: now,
        PriceDataSeries: [
          { PriceData: { BaseAsset: 'XAU', QuoteAsset: 'USD', AssetPrice: priceCents.toString(16).toUpperCase(), Scale: 2 } },
          // Scale 1 (value = grams × 10) because the serializer rejects an explicit Scale of 0.
          { PriceData: { BaseAsset: 'TWG', QuoteAsset: 'GRM', AssetPrice: (grams * 10).toString(16).toUpperCase(), Scale: 1 } }
        ]
      },
      emit,
      `${label}: publish reserve ${grams.toLocaleString('en-US')} g + XAU $${price.usdPerGram.toFixed(2)}/g on-ledger`,
      'Price Oracle (XLS-47)', 'reserve'
    );
    return { grams, price, code, hash };
  }

  async issueCredential(emit, subjectWallet, typeHex, typeName, subjectLabel) {
    await this.submit(
      this.wallets.issuer,
      { TransactionType: 'CredentialCreate', Account: this.wallets.issuer.classicAddress, Subject: subjectWallet.classicAddress, CredentialType: typeHex },
      emit, `CredentialCreate "${typeName}" → ${subjectLabel}`, 'Credentials', 'domain'
    );
    await this.submit(
      subjectWallet,
      { TransactionType: 'CredentialAccept', Account: subjectWallet.classicAddress, Issuer: this.wallets.issuer.classicAddress, CredentialType: typeHex },
      emit, `CredentialAccept "${typeName}" (${subjectLabel})`, 'Credentials', 'domain'
    );
  }

  async authorizeHolder(emit, holderWallet, label) {
    await this.submit(
      holderWallet,
      { TransactionType: 'MPTokenAuthorize', Account: holderWallet.classicAddress, MPTokenIssuanceID: this.mptIssuanceId },
      emit, `${label} opts in (MPTokenAuthorize)`, 'MPT', 'domain'
    );
    await this.submit(
      this.wallets.issuer,
      { TransactionType: 'MPTokenAuthorize', Account: this.wallets.issuer.classicAddress, MPTokenIssuanceID: this.mptIssuanceId, Holder: holderWallet.classicAddress },
      emit, `Issuer authorizes ${label}`, 'MPT', 'domain'
    );
  }

  async sendTwg(emit, fromWallet, toWallet, grams, desc) {
    return this.submit(
      fromWallet,
      {
        TransactionType: 'Payment',
        Account: fromWallet.classicAddress,
        Destination: toWallet.classicAddress,
        Amount: { mpt_issuance_id: this.mptIssuanceId, value: String(grams) }
      },
      emit, desc, 'MPT + auth gate', 'domain'
    );
  }

  async runKyc(emit, subjectLabel, name, country) {
    emit({ kind: 'note', desc: `KYC check: ${subjectLabel} · sandbox provider`, primitive: 'KYC (sandbox + live country registry)', result: 'RUNNING', layer: 'ai', real: false });
    const res = await kyc.verify({ subject: subjectLabel, name, country, docNumber: 'TW-2098431' });
    const summary = res.checks.map((c) => `${c.check}: ${c.pass ? 'pass' : 'FAIL'}`).join(' · ');
    emit({
      kind: 'note',
      desc: `KYC ${res.pass ? 'PASSED' : 'FAILED'} for ${subjectLabel} (${res.reference}) — ${summary}`,
      primitive: 'KYC (sandbox provider)', result: res.pass ? 'PASS' : 'FAIL', layer: 'ai', real: false
    });
    if (!res.pass) throw new Error(`KYC failed for ${subjectLabel}`);
    return res;
  }

  // ── steps ────────────────────────────────────────────────────────────

  async step0(emit) {
    await this.connect();
    emit({ kind: 'toast', text: 'Connecting to XRPL Testnet + faucet — real accounts incoming…', tone: 'gold' });
    const [a, b, c] = await Promise.all([this.client.fundWallet(), this.client.fundWallet(), this.client.fundWallet()]);
    this.wallets.issuer = a.wallet; this.wallets.eu = b.wallet; this.wallets.dubai = c.wallet;

    const bal = async (w) => Number(await this.client.getXrpBalance(w.classicAddress));
    const [ib, eb, db] = await Promise.all([bal(a.wallet), bal(b.wallet), bal(c.wallet)]);

    const fundEvent = (label, w, amount) => emit({
      kind: 'tx', desc: `Fund ${label} · ${amount} XRP → ${w.classicAddress}`,
      primitive: 'Faucet (Testnet)', result: 'tesSUCCESS', layer: 'domain', real: true,
      hash: w.classicAddress, explorer: this.accountUrl(w.classicAddress)
    });
    fundEvent('Issuer wallet', a.wallet, ib);
    fundEvent('BuyerEU wallet', b.wallet, eb);
    fundEvent('BuyerDubai wallet', c.wallet, db);

    emit({ kind: 'patch', patch: { balances: { issuer: ib, eu: eb, dubai: db } } });
    emit({ kind: 'toast', text: 'Three REAL Testnet accounts funded — click any entry to view it on testnet.xrpl.org.', tone: 'green' });
  }

  async step1(emit) {
    const grams = this.vault.getTotalVerifiedReserveGrams();
    emit({
      kind: 'note',
      desc: `Custodian bar-list attestation loaded: ${this.vault.attestationSummary()} (simulated vault feed)`,
      primitive: 'Vault feed (simulated attestation)', result: 'LOADED', layer: 'reserve', real: false
    });
    const pub = await this.publishOracle(emit, 'Reserve oracle');
    emit({ kind: 'patch', patch: { feedConnected: true, vault: pub.grams } });

    // Secure-mint pre-flight: intended mint vs attested reserve.
    emit({
      kind: 'note',
      desc: `Secure-mint pre-flight: ${this.mintAmount.toLocaleString('en-US')} TWG requested vs ${grams.toLocaleString('en-US')} g attested → coverage ${Math.round((grams / this.mintAmount) * 100)}% — MINT BLOCKED`,
      primitive: 'Reserve gate (server-enforced)', result: 'BLOCKED', layer: 'reserve', real: false
    });
    emit({ kind: 'toast', text: `Mint blocked: reserve covers only ${Math.round((grams / this.mintAmount) * 100)}% of the requested mint. Proof-of-reserve gates every mint.`, tone: 'red' });

    const newGrams = this.vault.topUp();
    emit({
      kind: 'note',
      desc: `Custodian top-up attested: +${(newGrams - grams).toLocaleString('en-US')} g (BullionVault allocation) → ${newGrams.toLocaleString('en-US')} g total`,
      primitive: 'Vault feed (simulated attestation)', result: 'LOADED', layer: 'reserve', real: false
    });
    await this.publishOracle(emit, 'Reserve oracle update');
    emit({ kind: 'patch', patch: { vault: newGrams } });
    emit({ kind: 'toast', text: `Reserve republished on-ledger: ${newGrams.toLocaleString('en-US')} g. Coverage ${Math.round((newGrams / this.mintAmount) * 100)}% — mint unlocked.`, tone: 'green' });
  }

  async step2(emit) {
    await this.submit(
      this.wallets.issuer,
      {
        TransactionType: 'PermissionedDomainSet',
        Account: this.wallets.issuer.classicAddress,
        AcceptedCredentials: [{ Credential: { Issuer: this.wallets.issuer.classicAddress, CredentialType: GOLD_KYC_HEX } }]
      },
      emit, 'PermissionedDomainSet · twg-gold-eu policy (gold-kyc required)', 'Permissioned Domains (XLS-80)', 'domain'
    );
    await this.runKyc(emit, 'BuyerEU', 'Anna Weber', 'Germany');
    await this.issueCredential(emit, this.wallets.eu, GOLD_KYC_HEX, 'gold-kyc', 'BuyerEU');
    emit({ kind: 'patch', patch: { euCred: true } });
    emit({ kind: 'toast', text: 'Domain declared + BuyerEU KYC-verified and credentialed on-ledger. BuyerDubai holds nothing yet.', tone: 'gold' });
  }

  async step3(emit) {
    const grams = this.vault.getTotalVerifiedReserveGrams();
    if (this.mintAmount > grams) {
      emit({ kind: 'note', desc: `Secure mint REJECTED: ${this.mintAmount} TWG > ${grams} g attested`, primitive: 'Reserve gate', result: 'BLOCKED', layer: 'reserve', real: false });
      throw new Error('secure mint blocked');
    }
    emit({
      kind: 'note',
      desc: `Secure-mint check: ${this.mintAmount.toLocaleString('en-US')} TWG ≤ ${grams.toLocaleString('en-US')} g attested reserve → coverage ${Math.round((grams / this.mintAmount) * 100)}% — APPROVED`,
      primitive: 'Reserve gate (server-enforced)', result: 'PASS', layer: 'reserve', real: false
    });

    const meta = { name: 'Tokenwald Gold', ticker: 'TWG', asset_class: 'rwa', asset_subclass: 'commodity', unit: 'gram', issuer_name: 'Dealer (principal)' };
    const { result } = await this.submit(
      this.wallets.issuer,
      {
        TransactionType: 'MPTokenIssuanceCreate',
        Account: this.wallets.issuer.classicAddress,
        AssetScale: 0,
        MaximumAmount: String(this.mintAmount),
        MPTokenMetadata: hex(JSON.stringify(meta)),
        Flags: TF_MPT_REQUIRE_AUTH | TF_MPT_CAN_TRANSFER
      },
      emit, `MPTokenIssuanceCreate · TWG cap ${this.mintAmount.toLocaleString('en-US')} (1 TWG = 1 g Au), RequireAuth`, 'MPT', 'domain'
    );
    this.mptIssuanceId = result.result.meta.mpt_issuance_id;
    emit({ kind: 'note', desc: `TWG issuance ID: ${this.mptIssuanceId}`, primitive: 'MPT', result: 'PASS', layer: 'domain', real: false });
    emit({ kind: 'patch', patch: { minted: this.mintAmount, holdings: { issuer: this.mintAmount, eu: 0, dubai: 0, partner: 0 } } });
    emit({ kind: 'toast', text: `${this.mintAmount.toLocaleString('en-US')} TWG issuance created — cap enforced at the attested reserve, RequireAuth on.`, tone: 'green' });
  }

  async step4(emit) {
    const v0 = this.publishCompliance({
      asset: 'XAU · 1 TWG = 1 g', issuer: 'Dealer (principal)', domain: 'twg-gold-eu',
      jurisdictions: ['EU / MiCA'], regime: 'MiCA ART — Art. 16(2) exemption (< €5M)',
      kycCredential: 'gold-kyc',
      reserveCoverage: `${Math.round((this.vault.getTotalVerifiedReserveGrams() / this.mintAmount) * 100)}%`,
      reserveOracle: `XLS-47 doc #${this.oracleDocId} (on-ledger)`,
      transferPolicy: 'auth-gated (RequireAuth)', redemption: 'physical @ dealer · XRP settlement (RLUSD rail in production)'
    });
    const { result } = await this.submit(
      this.wallets.issuer,
      { TransactionType: 'NFTokenMint', Account: this.wallets.issuer.classicAddress, NFTokenTaxon: 0, Flags: TF_MUTABLE, URI: hex(v0.uri) },
      emit, 'NFTokenMint · compliance dNFT "Live Token" (tfMutable)', 'Dynamic NFT (XLS-46)', 'dnft'
    );
    this.nftId = result.result.meta.nftoken_id;
    emit({ kind: 'note', desc: `Live Token NFT ID: ${this.nftId}`, primitive: 'Dynamic NFT (XLS-46)', result: 'PASS', layer: 'dnft', real: false });
    emit({ kind: 'dnft', note: 'Live Token minted', state: { ...v0.state, version: 'v0', uri: v0.uri, nftId: this.nftId } });
    emit({ kind: 'toast', text: 'Live Token minted on Testnet — its URI points at the versioned compliance state.', tone: 'gold' });
  }

  async step5(emit) {
    const fail = await this.sendTwg(emit, this.wallets.issuer, this.wallets.dubai, 100, 'Transfer 100 TWG → BuyerDubai (no credential, not authorized)');
    emit({ kind: 'toast', text: `${fail.code} — the ledger itself refused BuyerDubai. Deterministic, not discretionary.`, tone: 'red' });

    await this.authorizeHolder(emit, this.wallets.eu, 'BuyerEU');
    const ok = await this.sendTwg(emit, this.wallets.issuer, this.wallets.eu, 100, 'Transfer 100 TWG → BuyerEU (gold-kyc ✓, authorized)');
    emit({ kind: 'patch', patch: { holdings: { issuer: this.mintAmount - 100, eu: 100, dubai: 0, partner: 0 } } });
    await this.updateDnft(emit, 'Holder added after credential + auth check', {
      lastEvent: { type: 'TRANSFER', to: 'BuyerEU', grams: 100, gate: 'gold-kyc verified + MPT authorized', result: ok.code },
      holders: ['Issuer', 'BuyerEU']
    });
    emit({ kind: 'toast', text: 'Same transfer, opposite outcomes — the compliance gate is on-ledger.', tone: 'green' });
  }

  async step6(emit, body) {
    const rule = (body && body.rule) || { type: 'stop-loss', threshold: 104, grams: 40, id: 'demo' };
    // Cap at 50: BuyerEU holds 100 TWG and step 7 still transfers 50 cross-border.
    const grams = Math.max(1, Math.min(Number(rule.grams) || 40, 50));
    const price = await fetchGoldPriceUSDPerGram();
    this.spot = price;

    const crossed = rule.type === 'take-profit' ? price.usdPerGram >= rule.threshold : price.usdPerGram <= rule.threshold;
    emit({
      kind: 'note',
      desc: `Agent reads ${price.source}: $${price.usdPerGram.toFixed(2)}/g vs ${rule.type} threshold €${rule.threshold}/g${crossed ? ' — threshold crossed' : ' — demo override: executing pre-approved rule for stage'}`,
      primitive: 'Agent (off-ledger decision)', result: 'PROPOSED', layer: 'ai', real: false
    });

    this.redeemedGrams = grams;
    await this.sendTwg(emit, this.wallets.eu, this.wallets.issuer, grams, `Redemption leg 1: BuyerEU returns ${grams} TWG → Issuer`);
    const drops = xrpl.xrpToDrops(2);
    await this.submit(
      this.wallets.issuer,
      { TransactionType: 'Payment', Account: this.wallets.issuer.classicAddress, Destination: this.wallets.eu.classicAddress, Amount: drops },
      emit, `Redemption leg 2: Issuer pays 2 XRP → BuyerEU (RLUSD rail in production; Batch pending on Testnet)`, 'Payment (XRP settlement)', 'domain'
    );
    emit({ kind: 'patch', patch: { holdings: { issuer: this.mintAmount - 100 + grams, eu: 100 - grams, dubai: 0, partner: 0 }, rlusd: { eu: Math.round(grams * price.usdPerGram), dubai: 0 } } });
    await this.updateDnft(emit, 'Automated redemption recorded', {
      lastEvent: {
        type: 'AUTO_REDEEM', grams, spotUSDPerGram: +price.usdPerGram.toFixed(2), rule: `${rule.type} @ ${rule.threshold}`,
        path: 'AI proposed → holder pre-approved → ledger executed → dNFT recorded → reserve verified'
      }
    });
    emit({ kind: 'alert', layer: 'reserve', text: `${grams} g redeemed — reserve vs supply reconciled on the oracle at next publication.` });
    emit({ kind: 'toast', text: 'Redemption settled on Testnet: tokens back, settlement out, dNFT versioned.', tone: 'green' });
  }

  async step7(emit) {
    emit({ kind: 'note', desc: 'Route intent: BuyerEU → BuyerDubai (cross-jurisdiction)', primitive: 'Agent (off-ledger decision)', result: 'FLAGGED', layer: 'ai', real: false });
    await this.updateDnft(emit, 'Cross-jurisdiction routing flagged', {
      crossBorder: { destination: 'UAE / Dubai (VARA)', status: 'vara-recognition-pending' }
    });
    emit({ kind: 'alert', layer: 'ai', text: 'VARA alert → BuyerDubai: recognition filing required before receiving TWG.' });
    emit({ kind: 'alert', layer: 'ai', text: 'DORA alert → Issuer: ICT third-party register update required for UAE custodian link.' });
    emit({ kind: 'toast', text: 'dNFT flags VARA-recognition-pending. VARA + DORA alerts fired — AI proposes, humans file.', tone: 'violet' });

    emit({ kind: 'note', desc: 'BuyerDubai files: VARA recognition application · UBO declaration · custody & redemption policy · AML/CFT summary', primitive: 'Filing (off-ledger)', result: 'SUBMITTED', layer: 'ai', real: false });
    await this.runKyc(emit, 'BuyerDubai', 'Rashid Al Mansoori', 'United Arab Emirates');
    await this.issueCredential(emit, this.wallets.dubai, VARA_HEX, 'vara-recognition', 'BuyerDubai');
    await this.authorizeHolder(emit, this.wallets.dubai, 'BuyerDubai');
    emit({ kind: 'patch', patch: { dubaiCred: true, varaCred: true } });
    await this.updateDnft(emit, 'Dubai policy recorded', {
      crossBorder: {
        destination: 'UAE / Dubai (VARA)', status: 'recognized',
        policy: 'investment-only — not cash-redeemable locally; physical redemption via issuer’s licensed Dubai partner'
      }
    });

    const r = this.redeemedGrams || 40; // grams redeemed in step 6 (≤ 50)
    const t = await this.sendTwg(emit, this.wallets.eu, this.wallets.dubai, 50, 'Transfer 50 TWG BuyerEU → BuyerDubai (vara-recognition ✓)');
    emit({ kind: 'patch', patch: { holdings: { issuer: this.mintAmount - 100 + r, eu: 100 - r - 50, dubai: 50, partner: 0 } } });

    emit({ kind: 'toast', text: 'Funding two more REAL wallets: an outside-domain wallet and the licensed Dubai partner…', tone: 'gold' });
    const [o, p] = await Promise.all([this.client.fundWallet(), this.client.fundWallet()]);
    this.wallets.outsider = o.wallet; this.wallets.partner = p.wallet;
    emit({ kind: 'tx', desc: `Fund outside-domain wallet → ${o.wallet.classicAddress}`, primitive: 'Faucet (Testnet)', result: 'tesSUCCESS', layer: 'domain', real: true, hash: o.wallet.classicAddress, explorer: this.accountUrl(o.wallet.classicAddress) });
    emit({ kind: 'tx', desc: `Fund licensed Dubai partner → ${p.wallet.classicAddress}`, primitive: 'Faucet (Testnet)', result: 'tesSUCCESS', layer: 'domain', real: true, hash: p.wallet.classicAddress, explorer: this.accountUrl(p.wallet.classicAddress) });

    const failRes = await this.sendTwg(emit, this.wallets.dubai, this.wallets.outsider, 25, 'Resale test: BuyerDubai → outside-domain wallet (expected to fail)');
    emit({ kind: 'toast', text: `${failRes.code} — resale outside the domain fails on-ledger. Enforced, not promised.`, tone: 'red' });

    await this.runKyc(emit, 'Dubai partner', 'Gulf Bullion DMCC', 'United Arab Emirates');
    await this.issueCredential(emit, this.wallets.partner, GOLD_KYC_HEX, 'gold-kyc', 'Dubai partner');
    await this.authorizeHolder(emit, this.wallets.partner, 'Dubai partner');
    const okRes = await this.sendTwg(emit, this.wallets.dubai, this.wallets.partner, 25, 'Resale test: BuyerDubai → licensed Dubai partner (in-domain)');
    emit({ kind: 'patch', patch: { holdings: { issuer: this.mintAmount - 100 + r, eu: 100 - r - 50, dubai: 25, partner: 25 } } });

    await this.updateDnft(emit, 'Dubai resale restriction proven on-ledger', {
      lastEvent: { type: 'RESALE_TEST', outsideDomain: failRes.code, licensedPartner: okRes.code }
    });
    emit({ kind: 'toast', text: 'Full lifecycle complete ON TESTNET: mint → gate → automate → cross borders. Click any hash to verify.', tone: 'green' });
  }

  async runStep(i, emit, body) {
    if (this.done.has(i)) throw new Error(`step ${i} already run`);
    for (let k = 0; k < i; k++) if (!this.done.has(k)) throw new Error(`run step ${k} first`);
    // Advisor seeding: size this run's mint before the reserve is published.
    const seeded = body && Math.round(Number(body.mintGrams));
    if (Number.isFinite(seeded) && seeded > 0 && !this.done.has(1)) {
      this.mintAmount = Math.max(MINT_MIN, Math.min(MINT_MAX, seeded));
      this.vault.calibrate(this.mintAmount);
    }
    await this.connect();
    const steps = [this.step0, this.step1, this.step2, this.step3, this.step4, this.step5, this.step6, this.step7];
    await steps[i].call(this, emit, body);
    this.done.add(i);
  }
}

module.exports = { Run, EXPLORER };
