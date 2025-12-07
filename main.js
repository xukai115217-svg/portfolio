// main.js

// ========= 配置 =========
const TWELVE_DATA_KEY = "eac5e5832df94c789a5adadb864956e9"; // TwelveData API Key
const TRADE_STORAGE_KEY = "portfolio_trades_v2";

// ========= 全局状态 =========
const appState = {
  baseHoldings: [], // data.json + 实时价格 + 初始估算
  holdings: [],     // 应用交易之后的最终持仓
  trades: [],       // 本地交易记录
  failedCount: 0,
  chart: null
};

// ========= 小工具 =========
const sleep = (ms) => new Promise(res => setTimeout(res, ms));

function formatMoney(value) {
  if (!isFinite(value)) return "--";
  return value.toLocaleString("zh-CN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

function formatPct(value) {
  if (!isFinite(value)) return "0.00%";
  return value.toFixed(2) + "%";
}

function nowTimeString() {
  const d = new Date();
  return d.toLocaleTimeString("zh-CN", { hour12: false });
}

// ========= 行情获取 =========

// TwelveData（美股）
async function fetchPriceFromTwelveData(symbol) {
  const url = `https://api.twelvedata.com/price?symbol=${encodeURIComponent(symbol)}&apikey=${TWELVE_DATA_KEY}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error("TwelveData HTTP " + resp.status);
  const data = await resp.json();
  if (data && data.price) {
    return Number(data.price);
  }
  throw new Error(`TwelveData 价格获取失败: ${symbol} -> ${JSON.stringify(data)}`);
}

// Yahoo Finance（港股）+ allorigins 代理解决 CORS
async function fetchPriceFromYahooHK(symbol) {
  const yahooUrl = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbol)}.HK`;
  const proxyUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(yahooUrl)}`;
  const resp = await fetch(proxyUrl);
  if (!resp.ok) throw new Error("Yahoo HK HTTP " + resp.status);
  const data = await resp.json();
  const quote = data?.quoteResponse?.result?.[0];
  if (!quote || quote.regularMarketPrice == null) {
    throw new Error(`Yahoo HK 价格获取失败: ${symbol}`);
  }
  return Number(quote.regularMarketPrice);
}

// 根据 market 决定用哪个数据源
async function getPrice(symbol, market) {
  if (market === "HK") {
    // symbol 形如 "0700"
    return fetchPriceFromYahooHK(symbol);
  }
  // 默认视作 US 等 TwelveData 支持的
  return fetchPriceFromTwelveData(symbol);
}

// ========= 读取 data.json =========

async function loadRawHoldings() {
  const resp = await fetch("data.json?t=" + Date.now());
  if (!resp.ok) throw new Error("加载 data.json 失败");
  const json = await resp.json();
  return json;
}

// 用实时价格丰富 data.json，并把 value 转成 “估算数量”
async function enrichHoldingsWithPrice(rawList) {
  const enriched = [];
  let failed = 0;

  for (const item of rawList) {
    try {
      const price = await getPrice(item.symbol, item.market);
      const qty = item.value ? Number((item.value / price).toFixed(2)) : 0;

      enriched.push({
        ...item,
        price,
        qty,
        cost: price // 初始估算：成本 = 当前价格（后续由交易修正）
      });

      // 稍微 sleep 一下，避免触发 TwelveData 速率限制
      await sleep(150);
    } catch (e) {
      console.warn("价格获取失败:", item.symbol, e);
      failed++;
    }
  }

  return { holdings: enriched, failed };
}

// ========= 本地交易记录（localStorage）=========

function loadTrades() {
  try {
    const raw = localStorage.getItem(TRADE_STORAGE_KEY);
    if (!raw) return [];
    const list = JSON.parse(raw);
    if (!Array.isArray(list)) return [];
    return list;
  } catch {
    return [];
  }
}

function saveTrades(trades) {
  localStorage.setItem(TRADE_STORAGE_KEY, JSON.stringify(trades));
}

// 对基础持仓应用交易：计算最终数量 & 加权成本
function applyTrades(baseHoldings, trades) {
  const map = new Map();

  // 先把基础持仓放进 map
  for (const h of baseHoldings) {
    map.set(h.symbol.toUpperCase(), {
      ...h,
      symbol: h.symbol.toUpperCase(),
      qty: h.qty || 0,
      cost: h.cost || h.price || 0
    });
  }

  // 应用每一笔交易
  for (const t of trades) {
    const symbol = (t.symbol || "").toUpperCase();
    if (!symbol) continue;

    let h = map.get(symbol);
    if (!h) {
      // 如果 data.json 里没有，但用户有交易，就新建一个虚拟标的
      h = {
        symbol,
        name: symbol,
        market: "US",
        category: "other",
        price: Number(t.price) || 0,
        qty: 0,
        cost: Number(t.price) || 0,
        value: 0
      };
      map.set(symbol, h);
    }

    const tradeQty = Number(t.qty);
    const tradePrice = Number(t.price);
    if (!isFinite(tradeQty) || !isFinite(tradePrice) || tradeQty === 0) continue;

    if (tradeQty > 0) {
      // 买入：加权平均成本
      const oldQty = h.qty;
      const oldCost = h.cost;
      const totalCostBefore = oldQty * oldCost;
      const totalCostAfter = totalCostBefore + tradeQty * tradePrice;
      const newQty = oldQty + tradeQty;
      h.qty = newQty;
      h.cost = newQty > 0 ? totalCostAfter / newQty : 0;
    } else {
      // 卖出：减少数量，不改变成本
      const newQty = h.qty + tradeQty; // tradeQty 为负
      h.qty = newQty;
      if (h.qty <= 0) {
        // 持仓清空，成本置 0（也可以保留原成本，看你喜好）
        h.qty = 0;
        h.cost = 0;
      }
    }
  }

  // 重新根据价格计算市值
  const result = [];
  for (const h of map.values()) {
    const marketValue = h.qty * (h.price || 0);
    result.push({
      ...h,
      marketValue
    });
  }

  return result;
}

// ========= 计算汇总 =========

function calcTotals(holdings) {
  let totalValue = 0;
  let totalCost = 0;

  for (const h of holdings) {
    const price = h.price || 0;
    const qty = h.qty || 0;
    const cost = h.cost || 0;

    const marketValue = price * qty;
    totalValue += marketValue;
    totalCost += cost * qty;
  }

  const pnl = totalValue - totalCost;
  const pnlPct = totalCost > 0 ? (pnl / totalCost) * 100 : 0;

  return { totalValue, totalCost, pnl, pnlPct };
}

// ========= 渲染 UI =========

function updateSummaryCards(holdings, failedCount) {
  const { totalValue, totalCost, pnl, pnlPct } = calcTotals(holdings);

  const totalValueEl = document.getElementById("total-value");
  const totalCostEl = document.getElementById("total-cost");
  const totalPnlEl = document.getElementById("total-pnl");
  const totalPnlPctEl = document.getElementById("total-pnl-pct");
  const holdingCountEl = document.getElementById("holding-count");
  const failedCountEl = document.getElementById("failed-count");
  const lastUpdateEl = document.getElementById("last-update");

  if (totalValueEl) totalValueEl.textContent = formatMoney(totalValue);
  if (totalCostEl) totalCostEl.textContent = formatMoney(totalCost);

  if (totalPnlEl) {
    totalPnlEl.textContent = (pnl >= 0 ? "+" : "") + formatMoney(pnl);
    totalPnlEl.classList.remove("positive", "negative");
    if (pnl > 0) totalPnlEl.classList.add("positive");
    else if (pnl < 0) totalPnlEl.classList.add("negative");
  }

  if (totalPnlPctEl) {
    totalPnlPctEl.textContent = (pnl >= 0 ? "+" : "") + formatPct(pnlPct);
  }

  if (holdingCountEl) holdingCountEl.textContent = holdings.length.toString();
  if (failedCountEl) failedCountEl.textContent =
    `${failedCount} 个标的价格获取失败，未计入`;

  if (lastUpdateEl) {
    lastUpdateEl.textContent = `已更新 · ${nowTimeString()}`;
  }
}

function renderTable(holdings) {
  const tbody = document.getElementById("position-table-body");
  if (!tbody) return;
  tbody.innerHTML = "";

  const sorted = [...holdings].sort((a, b) => (b.marketValue || 0) - (a.marketValue || 0));

  for (const h of sorted) {
    const tr = document.createElement("tr");

    const price = h.price || 0;
    const qty = h.qty || 0;
    const cost = h.cost || 0;
    const mv = price * qty;
    const costValue = cost * qty;
    const pnl = mv - costValue;
    const pnlPct = costValue > 0 ? (pnl / costValue) * 100 : 0;

    // 标的
    const tdSymbol = document.createElement("td");
    tdSymbol.className = "symbol-cell";
    const codeSpan = document.createElement("span");
    codeSpan.className = "symbol-code";
    codeSpan.textContent = h.symbol;
    const nameSpan = document.createElement("span");
    nameSpan.className = "symbol-name";
    nameSpan.textContent = h.name || "";
    tdSymbol.appendChild(codeSpan);
    if (h.name) tdSymbol.appendChild(nameSpan);

    // 数量
    const tdQty = document.createElement("td");
    tdQty.textContent = qty.toFixed(2);

    // 成本价
    const tdCost = document.createElement("td");
    tdCost.textContent = formatMoney(cost);

    // 现价
    const tdPrice = document.createElement("td");
    tdPrice.textContent = formatMoney(price);

    // 市值
    const tdMV = document.createElement("td");
    tdMV.textContent = formatMoney(mv);

    // 盈亏
    const tdPnl = document.createElement("td");
    const pnlClass = pnl > 0 ? "pnl-positive" : pnl < 0 ? "pnl-negative" : "pnl-zero";
    tdPnl.className = pnlClass;
    tdPnl.textContent = (pnl >= 0 ? "+" : "") + formatMoney(pnl);

    // 盈亏%
    const tdPnlPct = document.createElement("td");
    tdPnlPct.className = pnlClass;
    tdPnlPct.textContent = (pnl >= 0 ? "+" : "") + formatPct(pnlPct);

    tr.appendChild(tdSymbol);
    tr.appendChild(tdQty);
    tr.appendChild(tdCost);
    tr.appendChild(tdPrice);
    tr.appendChild(tdMV);
    tr.appendChild(tdPnl);
    tr.appendChild(tdPnlPct);

    tbody.appendChild(tr);
  }
}

// 绘制仓位分布饼图（按 category 聚合）
function renderChart(holdings) {
  const ctx = document.getElementById("allocation-chart");
  if (!ctx) return;

  // 聚合：core / tech / satellite / other
  const groupMap = new Map();
  for (const h of holdings) {
    const cat = h.category || "other";
    const key = cat.toLowerCase();
    const mv = h.marketValue || h.qty * (h.price || 0);
    groupMap.set(key, (groupMap.get(key) || 0) + mv);
  }

  const labelsMap = {
    core: "核心",
    tech: "科技",
    satellite: "卫星",
    other: "其他"
  };

  const keys = ["core", "tech", "satellite", "other"].filter(k => groupMap.get(k) > 0);
  if (keys.length === 0) {
    keys.push("other");
    groupMap.set("other", 1);
  }

  const data = keys.map(k => groupMap.get(k));
  const labels = keys.map(k => labelsMap[k] || k);

  const total = data.reduce((a, b) => a + b, 0);
  const pctLabels = data.map(v => (total > 0 ? ((v / total) * 100).toFixed(1) + "%" : "0%"));

  const colors = [
    "rgba(34,197,94,0.9)",   // core
    "rgba(56,189,248,0.9)",  // tech
    "rgba(248,113,113,0.95)",// satellite
    "rgba(148,163,184,0.9)"  // other
  ];

  if (appState.chart) {
    appState.chart.destroy();
  }

  appState.chart = new Chart(ctx, {
    type: "doughnut",
    data: {
      labels,
      datasets: [{
        data,
        backgroundColor: colors.slice(0, labels.length),
        borderColor: "#020617",
        borderWidth: 2,
        hoverBorderWidth: 2,
        hoverBorderColor: "#e5e7eb"
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          position: "bottom",
          labels: {
            color: "#9ca3af",
            boxWidth: 14,
            padding: 12,
            font: { size: 12 }
          }
        },
        tooltip: {
          callbacks: {
            label: function(context) {
              const label = context.label || "";
              const v = context.parsed || 0;
              const percent = total > 0 ? (v / total) * 100 : 0;
              return `${label}: ${formatMoney(v)} · ${percent.toFixed(1)}%`;
            }
          }
        }
      },
      cutout: "55%"
    }
  });

  const chartSub = document.getElementById("chart-subtext");
  if (chartSub) {
    chartSub.textContent = `已统计 ${holdings.length} 个标的 · 总市值 ${formatMoney(total)}`;
  }
}

// ========= 交易录入 =========

function setupTradeForm() {
  const symbolInput = document.getElementById("trade-symbol");
  const priceInput = document.getElementById("trade-price");
  const qtyInput = document.getElementById("trade-qty");
  const btnSubmit = document.getElementById("btn-submit-trade");
  const btnReset = document.getElementById("btn-reset-data");

  if (btnSubmit) {
    btnSubmit.addEventListener("click", () => {
      const symbol = (symbolInput.value || "").trim();
      const price = Number(priceInput.value);
      const qty = Number(qtyInput.value);

      if (!symbol) {
        alert("请输入股票代码（symbol）");
        return;
      }
      if (!isFinite(price) || price <= 0) {
        alert("请输入有效的价格");
        return;
      }
      if (!isFinite(qty) || qty === 0) {
        alert("数量必须非 0（买入为正，卖出为负）");
        return;
      }

      const trade = {
        symbol: symbol.toUpperCase(),
        price,
        qty,
        ts: Date.now()
      };

      appState.trades.push(trade);
      saveTrades(appState.trades);

      // 重新应用交易并刷新界面
      appState.holdings = applyTrades(appState.baseHoldings, appState.trades);
      updateSummaryCards(appState.holdings, appState.failedCount);
      renderTable(appState.holdings);
      renderChart(appState.holdings);

      // 清空数量 & 价格，保留代码方便继续加仓
      priceInput.value = "";
      qtyInput.value = "";
    });
  }

  if (btnReset) {
    btnReset.addEventListener("click", async () => {
      if (!confirm("确定要重置为 data.json 估算吗？这会清空本地交易记录。")) return;
      localStorage.removeItem(TRADE_STORAGE_KEY);
      appState.trades = [];
      await bootstrap(true); // 重新加载
    });
  }
}

// ========= 主流程 =========

async function bootstrap(fromReset = false) {
  const lastUpdateEl = document.getElementById("last-update");
  if (lastUpdateEl) lastUpdateEl.textContent = fromReset ? "重新估算中..." : "更新中...";

  try {
    const rawList = await loadRawHoldings();
    const { holdings, failed } = await enrichHoldingsWithPrice(rawList);
    appState.baseHoldings = holdings;
    appState.failedCount = failed;

    // 读取本地交易并应用
    appState.trades = loadTrades();
    appState.holdings = applyTrades(appState.baseHoldings, appState.trades);

    updateSummaryCards(appState.holdings, appState.failedCount);
    renderTable(appState.holdings);
    renderChart(appState.holdings);
  } catch (e) {
    console.error(e);
    alert("加载或计算持仓失败，请稍后再试。");
    if (lastUpdateEl) lastUpdateEl.textContent = "加载失败";
  }
}

// ========= 初始化 =========

document.addEventListener("DOMContentLoaded", () => {
  bootstrap(false);
  setupTradeForm();
});
