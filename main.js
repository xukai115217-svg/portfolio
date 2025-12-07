// =========================
//   CONFIG
// =========================
const TWELVE_KEY = "eac5e5832df94c789a5adadb864956e9";
const TRADE_KEY = "portfolio_trades_v2";

// 每批最大并发行情数量（避免 429 错误）
const BATCH_SIZE = 6;

// =========================
//   Helper Functions
// =========================
const sleep = ms => new Promise(r => setTimeout(r, ms));

function formatMoney(v) {
  if (!isFinite(v)) return "--";
  return v.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatPct(v) {
  if (!isFinite(v)) return "0.00%";
  return (v * 100).toFixed(2) + "%";
}

// =========================
//  Fetch Prices
// =========================

async function fetchUSPrice(symbol) {
  const url = `https://api.twelvedata.com/price?symbol=${symbol}&apikey=${TWELVE_KEY}`;
  const r = await fetch(url);
  const j = await r.json();
  if (j && j.price) return Number(j.price);
  throw new Error("TwelveData 价格失败");
}

async function fetchHKPrice(symbol) {
  const yahoo = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${symbol}.HK`;
  const proxy = `https://api.allorigins.win/raw?url=${encodeURIComponent(yahoo)}`;
  const r = await fetch(proxy);
  const j = await r.json();
  const q = j?.quoteResponse?.result?.[0];
  if (q?.regularMarketPrice != null) return Number(q.regularMarketPrice);
  throw new Error("Yahoo HK 失败");
}

async function getPrice(item) {
  if (item.market === "HK") return fetchHKPrice(item.symbol);
  return fetchUSPrice(item.symbol);
}

// =========================
//  Load Base Holdings from data.json
// =========================

async function loadBaseHoldings() {
  const r = await fetch("data.json?t=" + Date.now());
  const list = await r.json();

  return list.map(i => ({
    symbol: i.symbol.toUpperCase(),
    name: i.name || i.symbol,
    market: i.market || "US",
    category: i.category || "other",
    qty: Number(i.qty || 0),       // 使用你提供的真实数量
    cost: Number(i.cost || 0)      // 使用你提供的真实成本价
  }));
}

// =========================
//   Batched Price Loading
// =========================

async function loadPricesInBatches(holdings) {
  const result = [];
  let failed = 0;

  const progress = document.getElementById("last-update");

  for (let i = 0; i < holdings.length; i += BATCH_SIZE) {
    const batch = holdings.slice(i, i + BATCH_SIZE);

    progress.innerText = `加载价格中… ${i}/${holdings.length}`;

    const promises = batch.map(async h => {
      try {
        const p = await getPrice(h);
        return { ...h, price: p };
      } catch (e) {
        console.log("价格失败", h.symbol);
        failed++;
        return { ...h, price: null };
      }
    });

    const partial = await Promise.all(promises);
    result.push(...partial);

    await sleep(1500); // 每批等待 1.5 秒，避免 API 限制
  }

  progress.innerText = "已刷新";

  return { enriched: result, failed };
}

// =========================
//  Trades: Save / Load
// =========================

function loadTrades() {
  try {
    return JSON.parse(localStorage.getItem(TRADE_KEY) || "[]");
  } catch {
    return [];
  }
}

function saveTrades(list) {
  localStorage.setItem(TRADE_KEY, JSON.stringify(list));
}

// =========================
//  Apply Trades to Holdings
// =========================

function applyTrades(holdings, trades) {
  const map = new Map();
  holdings.forEach(h => map.set(h.symbol, { ...h }));

  for (const t of trades) {
    const s = t.symbol.toUpperCase();
    const h = map.get(s);
    if (!h) continue;

    const qty = Number(t.qty);
    const price = Number(t.price);

    if (qty > 0) {
      // 买入 → 加权平均成本
      const totalBefore = h.cost * h.qty;
      const totalAfter  = totalBefore + qty * price;
      const newQty      = h.qty + qty;
      h.cost = newQty > 0 ? totalAfter / newQty : h.cost;
      h.qty = newQty;
    } else if (qty < 0) {
      // 卖出 → 数量减少，不改变成本
      h.qty = Math.max(h.qty + qty, 0);
    }

    map.set(s, h);
  }

  return Array.from(map.values());
}

// =========================
//   Render UI
// =========================

function renderTable(list) {
  const tbody = document.getElementById("position-table-body");
  tbody.innerHTML = "";

  let totalValue = 0, totalCost = 0;

  list.forEach(i => {
    if (!i.price || i.qty <= 0) return;

    const marketValue = i.price * i.qty;
    const costValue = i.cost * i.qty;
    const pnl = marketValue - costValue;
    const pnlPct = pnl / costValue;

    totalValue += marketValue;
    totalCost += costValue;

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${i.symbol}<br><span style="color:#888">${i.name}</span></td>
      <td>${i.qty}</td>
      <td>${formatMoney(i.cost)}</td>
      <td>${formatMoney(i.price)}</td>
      <td>${formatMoney(marketValue)}</td>
      <td style="color:${pnl>=0?'#4ade80':'#f87171'}">${formatMoney(pnl)}</td>
      <td>${formatPct(pnlPct)}</td>
    `;
    tbody.appendChild(tr);
  });

  document.getElementById("total-value").innerText = formatMoney(totalValue);
  document.getElementById("total-cost").innerText = formatMoney(totalCost);
  document.getElementById("total-pnl").innerText = formatMoney(totalValue - totalCost);
  document.getElementById("total-pnl-pct").innerText = formatPct((totalValue - totalCost) / totalCost);
}

// =========================
//   Pie Chart
// =========================

let chart;

function renderChart(list) {
  const ctx = document.getElementById("allocation-chart").getContext("2d");

  const labels = list.map(i => i.symbol);
  const values = list.map(i => i.price ? i.price * i.qty : 0);

  if (chart) chart.destroy();

  chart = new Chart(ctx, {
    type: "doughnut",
    data: {
      labels,
      datasets: [{
        data: values,
        backgroundColor: ["#60a5fa", "#34d399", "#fbbf24", "#f87171", "#a78bfa",
                          "#4ade80", "#2dd4bf", "#fb7185"],
        borderWidth: 1
      }]
    }
  });

  document.getElementById("chart-subtext").innerText = `共 ${values.length} 个标的`;
}

// =========================
//   MAIN WORKFLOW
// =========================

async function refresh() {
  const progress = document.getElementById("last-update");
  progress.innerText = "加载中…";

  const base = await loadBaseHoldings();
  const { enriched, failed } = await loadPricesInBatches(base);

  let final = enriched.filter(i => i.price != null);

  const trades = loadTrades();
  final = applyTrades(final, trades);

  renderTable(final);
  renderChart(final);

  document.getElementById("holding-count").innerText = final.length;
  document.getElementById("failed-count").innerText = `${failed} 个标的获取失败`;
}

document.getElementById("btn-submit-trade").onclick = () => {
  const symbol = document.getElementById("trade-symbol").value.trim().toUpperCase();
  const price = Number(document.getElementById("trade-price").value);
  const qty = Number(document.getElementById("trade-qty").value);

  if (!symbol || !isFinite(price) || !isFinite(qty)) return alert("请完整填写交易信息");

  const list = loadTrades();
  list.push({ symbol, price, qty });
  saveTrades(list);

  alert("已记录交易，刷新后可见结果");
};

document.getElementById("btn-reset-data").onclick = () => {
  localStorage.removeItem(TRADE_KEY);
  alert("已清除交易记录！");
  refresh();
};

// 初始化
refresh();

