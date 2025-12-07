// ==========================
// 持仓面板 v2.0 - 防限速版 main.js
// ==========================

// ------- 配置 -------
const TWELVE_DATA_KEY = "eac5e5832df94c789a5adadb864956e9";
const TRADE_STORAGE_KEY = "portfolio_trades_v2";
const MAX_TWELVE_PER_MIN = 8;  // 免费版限制：8 请求/分钟

// 工具函数
const sleep = (ms) => new Promise(res => setTimeout(res, ms));

function formatMoney(v) {
  return isFinite(v)
    ? v.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : "--";
}

function formatPct(v) {
  return isFinite(v) ? (v * 100).toFixed(2) + "%" : "--";
}


// ==========================
// 价格获取（HK → Yahoo | US → TwelveData）
// ==========================

async function fetchPriceHK(symbol) {
  const yahooUrl = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${symbol}.HK`;
  const url = `https://api.allorigins.win/raw?url=${encodeURIComponent(yahooUrl)}`;
  try {
    const res = await fetch(url);
    const json = await res.json();
    const price = json?.quoteResponse?.result?.[0]?.regularMarketPrice;
    if (!price) throw new Error("HK price empty");
    return Number(price);
  } catch (e) {
    console.warn(`HK 价格获取失败: ${symbol}`, e);
    return null;
  }
}

async function fetchPriceUS(symbol) {
  const url = `https://api.twelvedata.com/price?symbol=${symbol}&apikey=${TWELVE_DATA_KEY}`;
  try {
    const res = await fetch(url);
    const json = await res.json();
    if (json?.price) return Number(json.price);
    throw new Error(json?.message || "US price error");
  } catch (e) {
    console.warn(`US 价格获取失败: ${symbol}`, e);
    return null;
  }
}


// ==========================
// 自动分批请求 US 股票价格（不会触发限速）
// ==========================

async function fetchUSPricesInBatches(symbols) {
  const results = {};
  const batches = [];

  // 按 8 个 symbol / 批分组
  for (let i = 0; i < symbols.length; i += MAX_TWELVE_PER_MIN) {
    batches.push(symbols.slice(i, i + MAX_TWELVE_PER_MIN));
  }

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];

    console.log(`⚡ 正在获取第 ${i + 1}/${batches.length} 批 US 价格:`, batch);

    // 批内并行请求
    const prices = await Promise.all(batch.map(fetchPriceUS));

    batch.forEach((symbol, idx) => {
      results[symbol] = prices[idx];
    });

    // 如果不是最后一批 → 等待 65 秒
    if (i < batches.length - 1) {
      console.log("⏳ 等待 65 秒以避免 TwelveData 限速...");
      await sleep(65000);
    }
  }

  return results;
}


// ==========================
// 加载 data.json
// ==========================

async function loadRawHoldings() {
  const res = await fetch("data.json?t=" + Date.now());
  return res.json();
}


// ==========================
// 主逻辑：获取价格 + 构建基础持仓
// ==========================

async function loadHoldingsWithPrice(raw) {
  const hkSymbols = raw.filter(x => x.market === "HK").map(x => x.symbol);
  const usSymbols = raw.filter(x => x.market === "US").map(x => x.symbol);

  let failed = 0;

  // -------- HK 股票（不占额度）--------
  const hkPrices = {};
  for (const s of hkSymbols) {
    const p = await fetchPriceHK(s);
    if (p) hkPrices[s] = p;
    else failed++;
  }

  // -------- US 股票（自动分批）--------
  const usPrices = await fetchUSPricesInBatches(usSymbols);

  // 组装持仓
  const holdings = raw.map(item => {
    const price = item.market === "HK" ? hkPrices[item.symbol] : usPrices[item.symbol];
    if (!price) {
      failed++;
      return null;
    }

    const qty = Number((item.value / price).toFixed(2));

    return {
      ...item,
      price,
      qty,
      cost: price
    };
  }).filter(Boolean);

  return { holdings, failed };
}


// ==========================
// 本地交易记录
// ==========================

function loadTrades() {
  try {
    return JSON.parse(localStorage.getItem(TRADE_STORAGE_KEY)) || [];
  } catch {
    return [];
  }
}

function saveTrades(list) {
  localStorage.setItem(TRADE_STORAGE_KEY, JSON.stringify(list));
}

// 应用交易记录：买卖成本加权计算
function applyTrades(base, trades) {
  const map = new Map();

  base.forEach(h => {
    map.set(h.symbol.toUpperCase(), { ...h });
  });

  trades.forEach(t => {
    const key = t.symbol.toUpperCase();
    const h = map.get(key);
    if (!h) return;

    const qty = Number(t.qty);
    const price = Number(t.price);
    if (!qty || !price) return;

    if (qty > 0) {
      // 买入 → 加权成本
      const totalCost = h.cost * h.qty + qty * price;
      h.qty += qty;
      h.cost = totalCost / h.qty;
    } else {
      // 卖出
      h.qty += qty; // qty 为负
      if (h.qty < 0) h.qty = 0;
    }

    map.set(key, h);
  });

  return [...map.values()];
}


// ==========================
// 渲染表格 + 总览
// ==========================

function render(holdings) {
  const body = document.getElementById("position-table-body");
  body.innerHTML = "";

  let totalValue = 0;
  let totalCost = 0;

  holdings.forEach(h => {
    const value = h.qty * h.price;
    const costValue = h.qty * h.cost;
    const pnl = value - costValue;
    const pnlPct = pnl / costValue;

    totalValue += value;
    totalCost += costValue;

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${h.symbol}</td>
      <td>${h.qty}</td>
      <td>${formatMoney(h.cost)}</td>
      <td>${formatMoney(h.price)}</td>
      <td>${formatMoney(value)}</td>
      <td>${formatMoney(pnl)}</td>
      <td>${formatPct(pnlPct)}</td>
    `;
    body.appendChild(tr);
  });

  // 总览
  document.getElementById("total-value").textContent = formatMoney(totalValue);
  document.getElementById("total-cost").textContent = formatMoney(totalCost);
  document.getElementById("total-pnl").textContent = formatMoney(totalValue - totalCost);
  document.getElementById("total-pnl-pct").textContent =
    totalCost > 0 ? formatPct((totalValue - totalCost) / totalCost) : "0.00%";

  document.getElementById("holding-count").textContent = holdings.length;
}


// ==========================
// 入口函数：加载 + 渲染
// ==========================

async function bootstrap() {
  document.getElementById("last-update").textContent = "加载中…";

  const raw = await loadRawHoldings();
  const trades = loadTrades();

  const { holdings, failed } = await loadHoldingsWithPrice(raw);

  const finalHoldings = applyTrades(holdings, trades);

  render(finalHoldings);

  document.getElementById("failed-count").textContent =
    `${failed} 个标的价格获取失败`;
  document.getElementById("last-update").textContent = new Date().toLocaleString();
}

bootstrap();


// ==========================
// 交易输入事件
// ==========================

document.getElementById("btn-submit-trade").onclick = () => {
  const symbol = document.getElementById("trade-symbol").value.trim();
  const price = Number(document.getElementById("trade-price").value);
  const qty = Number(document.getElementById("trade-qty").value);

  if (!symbol || !price || !qty) {
    alert("请输入完整交易信息");
    return;
  }

  const trades = loadTrades();
  trades.push({ symbol, price, qty });
  saveTrades(trades);

  alert("交易记录已保存，刷新即可更新持仓");
};

document.getElementById("btn-reset-data").onclick = () => {
  localStorage.removeItem(TRADE_STORAGE_KEY);
  alert("已重置为 data.json 初始估算，刷新即可");
};
