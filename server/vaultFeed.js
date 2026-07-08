'use strict';

// Simulated allocated-vault bar-list attestation. Stands in for a real
// custodian bar-list/API feed (e.g. BullionVault API or an LBMA operator's
// attestation report). The shape mirrors what a real allocated-gold
// attestation carries: bar id, weight, purity, vault location/operator and
// last audit date. Swap `bars` for the live feed in production.

const bars = [
  { barId: 'LM-2024-8841', weightGrams: 1000, purity: 0.9999, vaultLocation: 'Zurich', vaultOperator: 'Loomis International', lastAuditDate: '2026-05-12' },
  { barId: 'LM-2024-8842', weightGrams: 1000, purity: 0.9999, vaultLocation: 'Zurich', vaultOperator: 'Loomis International', lastAuditDate: '2026-05-12' },
  { barId: 'MA-2025-0117', weightGrams: 1000, purity: 0.9995, vaultLocation: 'Geneva', vaultOperator: 'Malca-Amit', lastAuditDate: '2026-04-28' },
  { barId: 'MA-2025-0118', weightGrams: 1000, purity: 0.9995, vaultLocation: 'Geneva', vaultOperator: 'Malca-Amit', lastAuditDate: '2026-04-28' },
  { barId: 'BR-2025-3302', weightGrams: 960, purity: 0.9999, vaultLocation: 'London', vaultOperator: "Brink's", lastAuditDate: '2026-06-02' }
];

// Extra bars the custodian attests during the "top-up" moment of the demo.
const topUpBars = [
  { barId: 'BV-2026-1201', weightGrams: 2500, purity: 0.9999, vaultLocation: 'Zurich (BullionVault)', vaultOperator: 'BullionVault', lastAuditDate: '2026-06-20' },
  { barId: 'BV-2026-1202', weightGrams: 2540, purity: 0.9999, vaultLocation: 'Zurich (BullionVault)', vaultOperator: 'BullionVault', lastAuditDate: '2026-06-20' }
];

// Institutions this layer is designed to integrate with. Displayed on the
// landing page as the integration standard, not as signed partners.
const vaultPartners = {
  vaultOperators: [
    { name: 'Loomis International', note: 'LBMA-approved allocated vaulting' },
    { name: 'Malca-Amit', note: 'LBMA-approved allocated vaulting' },
    { name: "Brink's", note: 'LBMA-approved allocated vaulting' },
    { name: 'BullionVault', note: 'API-accessible allocated gold, ~0.12%/yr' }
  ],
  auditors: [
    { name: 'Inspectorate International', note: 'independent reserve attestation' },
    { name: 'Bureau Veritas', note: 'independent reserve attestation' }
  ],
  framing: 'Designed to integrate with LBMA-approved allocated vaults; reserves independently attested.'
};

class VaultFeed {
  constructor() {
    this.bars = [...bars];
    this.toppedUp = false;
    this.scale = 1; // sized for the default 8,000 g demo mint
  }

  // Rescale the simulated attestation to a given mint size so the demo
  // narrative holds at any Advisor-seeded amount: initial reserve ≈ 62% of
  // the mint (blocked), post-top-up ≈ 125% (approved).
  calibrate(mintGrams) {
    const g = Number(mintGrams);
    if (Number.isFinite(g) && g > 0) this.scale = g / 8000;
  }

  getTotalVerifiedReserveGrams() {
    return Math.round(this.bars.reduce((sum, b) => sum + b.weightGrams * b.purity, 0) * this.scale);
  }

  topUp() {
    if (!this.toppedUp) {
      this.bars.push(...topUpBars);
      this.toppedUp = true;
    }
    return this.getTotalVerifiedReserveGrams();
  }

  barCount() {
    return this.bars.length;
  }

  attestationSummary() {
    const operators = [...new Set(this.bars.map((b) => b.vaultOperator))];
    return `${this.bars.length} bars · ${this.getTotalVerifiedReserveGrams().toLocaleString('en-US')} g fine gold · ${operators.join(', ')}`;
  }
}

module.exports = { VaultFeed, vaultPartners };
