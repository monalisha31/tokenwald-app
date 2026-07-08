'use strict';

const GRAMS_PER_TROY_OUNCE = 31.1034768;

let mockPriceUSDPerGram = 105; // fallback if the API is unreachable

// Gold spot from a free, keyless API, converted to USD per gram. GoldAPI.io /
// Metals-API can be swapped in with a key; api.gold-api.com needs none.
async function fetchGoldPriceUSDPerGram() {
  try {
    const res = await fetch('https://api.gold-api.com/price/XAU', { signal: AbortSignal.timeout(6000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return { source: 'api.gold-api.com (live)', usdPerGram: data.price / GRAMS_PER_TROY_OUNCE, live: true };
  } catch (err) {
    mockPriceUSDPerGram += 0.5;
    return { source: 'mock (API unreachable)', usdPerGram: mockPriceUSDPerGram, live: false };
  }
}

module.exports = { fetchGoldPriceUSDPerGram };
