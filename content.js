// content.js
(() => {
    // =========================
    // RH Stocks Tracker (+ Trend Chart Overlay)
    // =========================

    const PANEL_ID = "rhtr-panel";
    const CHART_ID = "rhtr-chart-overlay";

    // Only show on exactly /account/investing (allow trailing slash)
    const isInvestingPage = () =>
        location.origin === "https://robinhood.com" &&
        /^\/account\/investing\/?$/.test(location.pathname);

    const norm = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

    // Parse "$1,234.56" or "($1,234.56)" into integer cents (no float rounding)
    const parseMoneyToCents = (text) => {
        if (!text) return NaN;
        const t = String(text).trim();
        const negByParens = /^\(.*\)$/.test(t);

        const m = t.match(/\$[\d,]+(?:\.\d{1,})?/);
        if (!m) return NaN;

        const raw = m[0].replace("$", "").replace(/,/g, "");
        const parts = raw.split(".");
        const dollars = Number(parts[0] || "0");
        if (!Number.isFinite(dollars)) return NaN;

        const frac = parts[1] || "";
        const cents2 = (frac + "00").slice(0, 2); // exact 2 digits
        const cents = Number(cents2);
        if (!Number.isFinite(cents)) return NaN;

        const total = dollars * 100 + cents;
        return negByParens ? -total : total;
    };

    const centsToMoney = (cents) => {
        const sign = cents < 0 ? "-" : "";
        const abs = Math.abs(cents);
        const dollars = Math.floor(abs / 100);
        const c = abs % 100;
        return `${sign}$${dollars.toLocaleString(undefined)}.${String(c).padStart(2, "0")}`;
    };

    const centsToFixed2 = (cents) => (cents / 100).toFixed(2);

    const lastUpdatedStamp = () => {
        const d = new Date();
        const mm = String(d.getMonth() + 1).padStart(2, "0");
        const dd = String(d.getDate()).padStart(2, "0");
        const yy = String(d.getFullYear()).slice(-2);

        let h = d.getHours();
        const ampm = h >= 12 ? "PM" : "AM";
        h = h % 12;
        if (h === 0) h = 12;

        const hh = String(h).padStart(2, "0");
        const min = String(d.getMinutes()).padStart(2, "0");
        const sec = String(d.getSeconds()).padStart(2, "0");

        return `Updated at ${mm}/${dd}/${yy} ${hh}:${min}:${sec} ${ampm}`;
    };

    const getNowParts = () => {
        const d = new Date();
        const date = d.toLocaleDateString(undefined, {year: "numeric", month: "2-digit", day: "2-digit"});
        const timeHM = d.toLocaleTimeString(undefined, {hour: "2-digit", minute: "2-digit"}); // minutes only
        return {date, timeHM, epochMs: d.getTime()};
    };

    // Arrow direction inference (preferred)
    const inferSignFromArrow = (cell) => {
        const d = cell?.querySelector("svg path")?.getAttribute("d") || "";
        if (/\b9\.5\b/.test(d)) return -1; // down
        if (/\b2\.5\b/.test(d)) return +1; // up
        return null;
    };

    const inferSignFromColor = (cell) => {
        const target = Array.from(cell.querySelectorAll("span")).find((s) => /\$/.test(s.textContent || "")) || cell;
        const c = getComputedStyle(target).color || "";
        const m = c.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
        if (!m) return null;
        const r = +m[1],
            g = +m[2],
            b = +m[3];
        if (g > r + 25 && g > b + 25) return +1;
        if (r > g + 25 && r > b + 25) return -1;
        return null;
    };

    const findTable = () => {
        const header = Array.from(document.querySelectorAll("header")).find((h) => {
            const txt = norm(h.textContent);
            return txt.includes("Total return") && txt.includes("Equity");
        });
        if (!header) return null;

        const headerCols = Array.from(header.children).filter((el) => el.tagName === "DIV");
        const totalReturnIndex = headerCols.findIndex((col) => norm(col.textContent).includes("Total return"));
        const equityIndex = headerCols.findIndex((col) => norm(col.textContent).includes("Equity"));
        if (totalReturnIndex < 0 || equityIndex < 0) return null;

        const root = header.parentElement;
        const rowsContainer = header.nextElementSibling || root;

        return {rowsContainer, colCount: headerCols.length, totalReturnIndex, equityIndex};
    };

    const findRowGrid = (row, colCount) => {
        const candidates = Array.from(row.querySelectorAll("*")).filter((el) => {
            const kids = Array.from(el.children).filter((c) => c.nodeType === 1);
            if (kids.length !== colCount) return false;
            const nonEmpty = kids.filter((k) => norm(k.textContent).length > 0).length;
            return nonEmpty >= Math.min(3, colCount);
        });
        candidates.sort((a, b) => b.querySelectorAll("*").length - a.querySelectorAll("*").length);
        return candidates[0] || null;
    };

    const computeTotals = () => {
        const t = findTable();
        if (!t) return {ok: false, reason: 'Could not locate header labels "Total return" and "Equity".'};

        const {rowsContainer, colCount, totalReturnIndex, equityIndex} = t;
        const rows = Array.from(rowsContainer.querySelectorAll('a[href^="/stocks/"]'));
        if (!rows.length) return {ok: false, reason: "No holding rows found."};

        let profitCents = 0;
        let lossCents = 0;
        let equityCents = 0;

        let parsed = 0;
        let equityParsed = 0;

        for (const row of rows) {
            const grid = findRowGrid(row, colCount);
            if (!grid) continue;

            const cells = Array.from(grid.children).filter((c) => c.nodeType === 1);
            const trCell = cells[totalReturnIndex];
            const eqCell = cells[equityIndex];
            if (!trCell || !eqCell) continue;

            // Total return
            const trMatch = (trCell.textContent || "").match(/\$[\d,]+(?:\.\d{1,})?|\(\$[\d,]+(?:\.\d{1,})?\)/);
            const trText = trMatch?.[0] || "";
            let trAbsCents = parseMoneyToCents(trText);
            if (!Number.isFinite(trAbsCents)) continue;
            trAbsCents = Math.abs(trAbsCents);

            let sign = inferSignFromArrow(trCell);
            if (sign == null) sign = inferSignFromColor(trCell);
            if (sign == null) sign = +1;

            const signed = sign < 0 ? -trAbsCents : trAbsCents;
            if (signed >= 0) profitCents += signed;
            else lossCents += signed;

            // Equity
            const eqMatch = (eqCell.textContent || "").match(/\$[\d,]+(?:\.\d{1,})?|\(\$[\d,]+(?:\.\d{1,})?\)/);
            const eqText = eqMatch?.[0] || "";
            const eqCents = parseMoneyToCents(eqText);
            if (Number.isFinite(eqCents)) {
                equityCents += eqCents;
                equityParsed++;
            }

            parsed++;
        }

        if (equityParsed === 0) {
            return {ok: false, reason: "Equity not parsed yet (page still rendering). Scroll slightly and wait."};
        }

        return {
            ok: true,
            profitCents,
            lossCents,
            netCents: profitCents + lossCents,
            equityCents,
            totalStocks: parsed,
        };
    };

    // ---------- storage ----------
    const saveSnapshot = async (computed) => {
        if (!computed.ok) return {ok: false, reason: computed.reason || "Unable to compute totals."};
        for (const f of ["profitCents", "lossCents", "netCents", "equityCents"]) {
            if (!Number.isFinite(computed[f])) return {ok: false, reason: `Cannot save: ${f} is not a number.`};
        }

        const now = getNowParts();
        const entry = {
            epochMs: now.epochMs,
            date: now.date,
            time: now.timeHM,
            profitCents: computed.profitCents,
            lossCents: computed.lossCents,
            netCents: computed.netCents,
            equityCents: computed.equityCents,
        };

        const {snapshots = []} = await chrome.storage.local.get({snapshots: []});
        snapshots.push(entry);
        await chrome.storage.local.set({snapshots});
        return {ok: true};
    };

    const deleteSnapshot = async (epochMs) => {
        const {snapshots = []} = await chrome.storage.local.get({snapshots: []});
        await chrome.storage.local.set({snapshots: snapshots.filter((s) => s.epochMs !== epochMs)});
    };

    const clearHistory = async () => chrome.storage.local.set({snapshots: []});

    const exportCSV = async () => {
        const {snapshots = []} = await chrome.storage.local.get({snapshots: []});
        const sorted = snapshots.slice().sort((a, b) => a.epochMs - b.epochMs);

        const header = ["Date", "Time", "Profit", "Loss", "Net", "Total Equity"];
        const lines = [header.join(",")];

        for (const s of sorted) {
            lines.push(
                [s.date, s.time, centsToFixed2(s.profitCents), centsToFixed2(s.lossCents), centsToFixed2(s.netCents), centsToFixed2(s.equityCents)].join(
                    ","
                )
            );
        }

        const blob = new Blob([lines.join("\n")], {type: "text/csv;charset=utf-8"});
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `RH_Tracker_${new Date().toISOString().slice(0, 10)}.csv`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
    };

    // ---------- Chart Overlay ----------
    const escapeXML = (s) =>
        String(s ?? "")
            .replaceAll("&", "&amp;")
            .replaceAll("<", "&lt;")
            .replaceAll(">", "&gt;")
            .replaceAll('"', "&quot;")
            .replaceAll("'", "&#39;");

    // Short-level labeling + dynamic-level labeling (no overlap)
    const labelHelpers = (() => {
        const parseDateTimeLabel = (label) => {
            const s = String(label || "").trim();
            const m = s.match(/^(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)\s+(.*)$/);
            if (m) return {datePart: m[1], timePart: m[2]};
            return {datePart: "", timePart: s};
        };

        const isSameDayAll = (labels) => {
            if (!labels.length) return true;
            const first = parseDateTimeLabel(labels[0]).datePart;
            if (!first) return false;
            return labels.every((l) => parseDateTimeLabel(l).datePart === first);
        };

        const shorten = (label, mode, sameDayAll) => {
            const {datePart, timePart} = parseDateTimeLabel(label);
            if (mode === "short") {
                const mmdd = (datePart || "").split("/").slice(0, 2).join("/");
                if (mmdd && timePart) return `${mmdd} ${timePart}`;
                return label;
            }
            if (sameDayAll) return timePart || label;
            const mmdd = (datePart || "").split("/").slice(0, 2).join("/");
            return mmdd || label;
        };

        const pickXTicks = (count, plotW) => {
            if (count <= 0) return [];
            if (count === 1) return [0];

            // Estimate how many labels fit without overlap.
            // ~170px per label is safe for many points.
            const approx = Math.floor(plotW / 170);
            const maxTicks = Math.max(3, Math.min(6, approx)); // cap at 6 labels

            const idx = [];
            for (let i = 0; i < maxTicks; i++) {
                idx.push(Math.round((i * (count - 1)) / (maxTicks - 1)));
            }
            return Array.from(new Set(idx));
        };


        const labelRotation = (tickCount) => {
            if (tickCount >= 5) return -45;
            if (tickCount >= 4) return -30;
            return 0;
        };

        return {isSameDayAll, shorten, pickXTicks, labelRotation};
    })();

    const ensureChartOverlay = () => {
        let overlay = document.getElementById(CHART_ID);
        if (overlay) return overlay;

        overlay = document.createElement("div");
        overlay.id = CHART_ID;

        overlay.style.cssText = [
            "position:fixed",
            "inset:0",
            "z-index:2147483647",
            "background:rgba(0,0,0,0.55)",
            "display:none",
            "align-items:center",
            "justify-content:center",
            "padding:24px",
        ].join(";");

        overlay.innerHTML = `
      <div id="rhtr-chart-card" style="
        width:min(980px, 96vw);
        height:min(700px, 92vh);
        background:rgba(17,24,39,0.96);
        border:1px solid rgba(255,255,255,0.16);
        border-radius:18px;
        box-shadow:0 20px 70px rgba(0,0,0,0.55);
        color:#f9fafb;
        font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial;
        display:flex;
        flex-direction:column;
        overflow:hidden;
      ">
        <div style="
          display:flex;
          align-items:center;
          justify-content:space-between;
          padding:12px 14px;
          border-bottom:1px solid rgba(255,255,255,0.12);
        ">
          <div>
            <div style="font-weight:900;font-size:14px;">RH Stocks Tracker — Net Trend</div>
            <div id="rhtr-chart-sub" style="margin-top:2px;font-size:12px;color:rgba(249,250,251,0.75);">Loading…</div>
          </div>
          <div style="display:flex;gap:8px;align-items:center;">
            <button id="rhtr-chart-png" style="
              cursor:pointer;border-radius:12px;border:1px solid rgba(255,255,255,0.18);
              background:rgba(255,255,255,0.10);color:#f9fafb;font-weight:800;
              padding:8px 10px;font-size:12px;line-height:1;
            ">Export PNG</button>
            <button id="rhtr-chart-close" style="
              cursor:pointer;border-radius:12px;border:1px solid rgba(255,255,255,0.18);
              background:rgba(255,255,255,0.10);color:#f9fafb;font-weight:900;
              padding:8px 10px;font-size:12px;line-height:1;
            ">Close</button>
          </div>
        </div>

        <div style="padding:14px 14px 18px;flex:1;overflow:auto;">
          <div id="rhtr-chart-box"></div>
          <div style="margin-top:10px;font-size:12px;color:rgba(249,250,251,0.72);">
            Save snapshots over time, then open this chart to see how your net return changes.
          </div>
        </div>
      </div>
    `;

        // Tooltip element (HTML overlay for better readability)
        const tip = document.createElement("div");
        tip.id = "rhtr-tip";
        tip.style.cssText = [
            "position:fixed",
            "z-index:2147483649",
            "pointer-events:none",
            "display:none",
            "transform: translateZ(0)",           // keep on top (compositor layer)
            "will-change: transform, left, top",  // smoother + prevents behind rendering
            "background:rgba(0,0,0,0.85)",
            "color:#f9fafb",
            "border:1px solid rgba(255,255,255,0.18)",
            "border-radius:10px",
            "padding:8px 10px",
            "font: 12px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial",
            "box-shadow:0 10px 30px rgba(0,0,0,0.55)",
            "max-width:260px",
        ].join(";");
        overlay.appendChild(tip);


        // Close on background click (not on card)
        overlay.addEventListener("click", (e) => {
            const card = overlay.querySelector("#rhtr-chart-card");
            if (card && !card.contains(e.target)) hideChartOverlay();
        });

        overlay.querySelector("#rhtr-chart-close").addEventListener("click", hideChartOverlay);

        document.addEventListener("keydown", (e) => {
            if (e.key === "Escape") hideChartOverlay();
        });

        overlay.querySelector("#rhtr-chart-png").addEventListener("click", exportChartPNG);

        // Hover handlers for tooltip via event delegation on overlay
        overlay.addEventListener("mousemove", (e) => {
            const t = e.target?.closest?.("[data-rhtr-point]");
            const tipEl = document.getElementById("rhtr-tip");
            if (!tipEl) return;

            if (!t) {
                tipEl.style.display = "none";
                return;
            }

            const payload = t.getAttribute("data-rhtr-point") || "";
            const [date, time, net] = payload.split("|");
            tipEl.innerHTML = `
        <div style="font-weight:900;margin-bottom:4px;">Net: <span style="font-weight:900">${escapeXML(net || "")}</span></div>
        <div><span style="color:rgba(249,250,251,0.75)">Date:</span> ${escapeXML(date || "")}</div>
        <div><span style="color:rgba(249,250,251,0.75)">Time:</span> ${escapeXML(time || "")}</div>
      `.trim();

            // place near cursor with bounds
            const pad = 14;
            const vw = window.innerWidth;
            const vh = window.innerHeight;
            tipEl.style.display = "block";

            // first position
            let x = e.clientX + pad;
            let y = e.clientY + pad;

            // measure after display
            const r = tipEl.getBoundingClientRect();
            if (x + r.width + 8 > vw) x = e.clientX - r.width - pad;
            if (y + r.height + 8 > vh) y = e.clientY - r.height - pad;

            tipEl.style.left = `${Math.max(8, x)}px`;
            tipEl.style.top = `${Math.max(8, y)}px`;
        });

        overlay.addEventListener("mouseleave", () => {
            document.getElementById("rhtr-tip")?.style && (document.getElementById("rhtr-tip").style.display = "none");
        });

        document.documentElement.appendChild(overlay);
        return overlay;
    };

    const showChartOverlay = async () => {
        const overlay = ensureChartOverlay();
        overlay.style.display = "flex";
        await renderChart();
    };

    const hideChartOverlay = () => {
        const overlay = document.getElementById(CHART_ID);
        if (overlay) overlay.style.display = "none";
        const tip = document.getElementById("rhtr-tip");
        if (tip) tip.style.display = "none";
    };

    const buildLineChartSVG = ({title, valuesCents, labels, metas}) => {
        const W = 920;
        const H = 520;

        // Extra top margin to prevent overlap with title/subtitle (your screenshot issue)
        // Extra bottom margin so rotated x labels are not cut
        const PAD_L = 100;
        const PAD_R = 55;
        const PAD_T = 92; // more top space
        const PAD_B = 170; // more bottom space

        const plotW = W - PAD_L - PAD_R;
        const plotH = H - PAD_T - PAD_B;

        const n = valuesCents.length;

        const fmtY = (cents) => centsToFixed2(cents);

        // Empty state
        if (n === 0) {
            return `
        <svg id="rhtr-chart-svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
          <rect x="0" y="0" width="${W}" height="${H}" rx="18" fill="rgba(255,255,255,0.06)" stroke="rgba(255,255,255,0.14)"/>
          <text x="22" y="28" font-size="14" font-weight="900" fill="rgba(249,250,251,0.92)">${escapeXML(title)}</text>
          <text x="${W / 2}" y="${H / 2}" text-anchor="middle" font-size="14" fill="rgba(249,250,251,0.75)">
            No snapshots yet. Click “Save snapshot” to start tracking.
          </text>
        </svg>
      `;
        }

        // Range includes 0 + add 5% padding to min/max (requested)
        const rawMin = Math.min(...valuesCents);
        const rawMax = Math.max(...valuesCents);

        let minV = Math.min(rawMin, 0);
        let maxV = Math.max(rawMax, 0);

        // padding 5% of range (or a tiny minimum padding)
        const baseRange = Math.max(1, maxV - minV);
        const pad = Math.max(1, Math.round(baseRange * 0.05));

        minV -= pad;
        maxV += pad;

        const range = maxV - minV || 1;

        const x = (i) => PAD_L + (i * plotW) / Math.max(1, n - 1);
        const y = (v) => PAD_T + (plotH * (maxV - v)) / range;
        const y0 = y(0);

        // Single-point state
        if (n === 1) {
            const v = valuesCents[0];
            const px = x(0);
            const py = y(v);
            const pointColor = v >= 0 ? "#22c55e" : "#ef4444";
            const strokeColor = v >= 0 ? "rgba(34,197,94,0.65)" : "rgba(239,68,68,0.65)";

            const meta = metas?.[0] || {};
            const payload = `${meta.date || ""}|${meta.time || ""}|${centsToMoney(v)}`;

            return `
        <svg id="rhtr-chart-svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
          <rect x="0" y="0" width="${W}" height="${H}" rx="18" fill="rgba(255,255,255,0.06)" stroke="rgba(255,255,255,0.14)"/>
          <text x="22" y="28" font-size="14" font-weight="900" fill="rgba(249,250,251,0.92)">${escapeXML(title)}</text>

          <line x1="${PAD_L}" y1="${y0}" x2="${W - PAD_R}" y2="${y0}" stroke="rgba(255,255,255,0.18)"/>
          <text x="${PAD_L - 12}" y="${y0 + 4}" font-size="11" text-anchor="end" fill="rgba(249,250,251,0.70)">0.00</text>

          <!-- hoverable point -->
          <g data-rhtr-point="${escapeXML(payload)}" style="cursor:default">
            <circle cx="${px}" cy="${py}" r="7" fill="${pointColor}" stroke="${strokeColor}" stroke-width="3"/>
            <circle cx="${px}" cy="${py}" r="12" fill="transparent"/>
          </g>

          <text x="${PAD_L}" y="${H - 20}" font-size="11" fill="rgba(249,250,251,0.70)">
            ${escapeXML(labels[0] || "")}
          </text>
        </svg>
      `;
        }

        // Points
        const pts = valuesCents.map((v, i) => ({x: x(i), y: y(v), v, i}));
        const linePath = pts.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(" ");

        // Split area above/below baseline
        const buildAreaPaths = (above) => {
            const isAbove = (v) => v >= 0;
            const intersectX = (p1, p2) => {
                const t = (0 - p1.v) / (p2.v - p1.v);
                return p1.x + t * (p2.x - p1.x);
            };

            const segs = [];
            let current = [];

            for (let i = 0; i < pts.length; i++) {
                const p = pts[i];
                const pAbove = isAbove(p.v);

                if ((above && pAbove) || (!above && !pAbove)) current.push(p);

                if (i < pts.length - 1) {
                    const q = pts[i + 1];
                    const qAbove = isAbove(q.v);

                    if (pAbove !== qAbove) {
                        const ix = intersectX(p, q);
                        const ip = {x: ix, y: y0, v: 0};

                        if ((above && pAbove) || (!above && !pAbove)) {
                            current.push(ip);
                            segs.push(current);
                            current = [];
                        } else {
                            current = [ip];
                        }
                    }
                }
            }
            if (current.length) segs.push(current);

            return segs
                .filter((seg) => seg.length >= 2)
                .map((seg) => {
                    const first = seg[0];
                    const last = seg[seg.length - 1];
                    return `M ${first.x} ${y0} ${seg.map((p) => `L ${p.x} ${p.y}`).join(" ")} L ${last.x} ${y0} Z`;
                });
        };

        const areaAbove = buildAreaPaths(true);
        const areaBelow = buildAreaPaths(false);

        // Y ticks
        const yTicks = 4;
        const tickVals = Array.from({length: yTicks + 1}, (_, i) => minV + (range * i) / yTicks);

        // X ticks: short/dynamic
        const mode = n <= 6 ? "short" : "dynamic";
        const sameDayAll = labelHelpers.isSameDayAll(labels);
        const xTickIdx = labelHelpers.pickXTicks(n, plotW);
        const rot = labelHelpers.labelRotation(xTickIdx.length);

        const first = valuesCents[0];
        const last = valuesCents[n - 1];
        const change = last - first;

        return `
      <svg id="rhtr-chart-svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
        <rect x="0" y="0" width="${W}" height="${H}" rx="18" fill="rgba(255,255,255,0.06)" stroke="rgba(255,255,255,0.14)"/>

        <!-- Title + Subtitle (kept above plot with enough padding) -->
        <text x="22" y="28" font-size="14" font-weight="900" fill="rgba(249,250,251,0.92)">${escapeXML(title)}</text>
        <text x="22" y="48" font-size="12" fill="rgba(249,250,251,0.72)">
          Start ${escapeXML(centsToMoney(first))} → Latest ${escapeXML(centsToMoney(last))} • Change ${escapeXML(centsToMoney(change))}
        </text>

        <!-- Grid + Y axis labels -->
        ${tickVals
            .map((tv) => {
                const yy = y(tv);
                return `
              <line x1="${PAD_L}" y1="${yy}" x2="${W - PAD_R}" y2="${yy}" stroke="rgba(255,255,255,0.08)"/>
              <text x="${PAD_L - 12}" y="${yy + 4}" font-size="11" text-anchor="end" fill="rgba(249,250,251,0.70)">${escapeXML(fmtY(tv))}</text>
            `;
            })
            .join("")}

        <!-- 0 baseline -->
        <line x1="${PAD_L}" y1="${y0}" x2="${W - PAD_R}" y2="${y0}" stroke="rgba(255,255,255,0.18)"/>

        <!-- X axis baseline -->
        <line x1="${PAD_L}" y1="${PAD_T + plotH}" x2="${W - PAD_R}" y2="${PAD_T + plotH}" stroke="rgba(255,255,255,0.10)"/>

        <!-- Area fills -->
        ${areaAbove.map((d) => `<path d="${d}" fill="rgba(34,197,94,0.18)" stroke="none"/>`).join("")}
        ${areaBelow.map((d) => `<path d="${d}" fill="rgba(239,68,68,0.18)" stroke="none"/>`).join("")}

        <!-- Neutral line -->
        <path d="${linePath}" fill="none" stroke="rgba(249,250,251,0.85)" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/>

        <!-- Hoverable points: circle with green/red based on sign -->
        ${pts
            .map((p) => {
                const meta = metas?.[p.i] || {};
                const payload = `${meta.date || ""}|${meta.time || ""}|${centsToMoney(p.v)}`;

                const fill = p.v >= 0 ? "#22c55e" : "#ef4444";
                const stroke = p.v >= 0 ? "rgba(34,197,94,0.65)" : "rgba(239,68,68,0.65)";
                return `
              <g data-rhtr-point="${escapeXML(payload)}" style="cursor:default">
                <circle cx="${p.x}" cy="${p.y}" r="5.5" fill="${fill}" stroke="${stroke}" stroke-width="3"/>
                <!-- larger invisible hit-area for easier hover -->
                <circle cx="${p.x}" cy="${p.y}" r="14" fill="transparent"/>
              </g>
            `;
            })
            .join("")}

        <!-- X ticks -->
        ${xTickIdx
            .map((i) => {
                const xx = x(i);
                const lbl = labelHelpers.shorten(labels[i] || "", mode, sameDayAll);
                const rotY = rot !== 0 ? (PAD_T + plotH + 60) : (PAD_T + plotH + 32);
                const tx = rot !== 0 ? ` transform="rotate(${rot} ${xx} ${rotY})"` : "";
                const anchor = rot !== 0 ? "end" : "middle";
                const yText = rotY;


                return `
              <line x1="${xx}" y1="${PAD_T + plotH}" x2="${xx}" y2="${PAD_T + plotH + 7}" stroke="rgba(255,255,255,0.14)"/>
              <text x="${xx}" y="${yText}" font-size="11" text-anchor="${anchor}" fill="rgba(249,250,251,0.70)"${tx}>
                ${escapeXML(lbl)}
              </text>
            `;
            })
            .join("")}
      </svg>
    `;
    };

    const renderChart = async () => {
        const overlay = ensureChartOverlay();
        const sub = overlay.querySelector("#rhtr-chart-sub");
        const box = overlay.querySelector("#rhtr-chart-box");

        const {snapshots = []} = await chrome.storage.local.get({snapshots: []});
        const sorted = snapshots.slice().sort((a, b) => a.epochMs - b.epochMs);

        const labels = sorted.map((s) => `${s.date} ${s.time}`);
        const values = sorted.map((s) => s.netCents);
        const metas = sorted.map((s) => ({date: s.date, time: s.time}));

        if (sorted.length === 0) sub.textContent = "No snapshots saved yet.";
        else if (sorted.length === 1) sub.textContent = "1 snapshot saved. Save one more to see a trend.";
        else sub.textContent = `Snapshots: ${sorted.length}`;

        box.innerHTML = buildLineChartSVG({
            title: "Net (USD) — based on saved snapshots",
            valuesCents: values,
            labels,
            metas,
        });
    };

    const exportChartPNG = async () => {
        const svgEl = document.getElementById("rhtr-chart-svg");
        if (!svgEl) {
            alert("No chart to export.");
            return;
        }

        const svgText = new XMLSerializer().serializeToString(svgEl);
        const svgBlob = new Blob([svgText], {type: "image/svg+xml;charset=utf-8"});
        const url = URL.createObjectURL(svgBlob);

        const img = new Image();
        img.onload = () => {
            const canvas = document.createElement("canvas");
            canvas.width = img.width;
            canvas.height = img.height;
            const ctx = canvas.getContext("2d");

            // Solid dark background so PNG isn’t transparent
            ctx.fillStyle = "#111827";
            ctx.fillRect(0, 0, canvas.width, canvas.height);

            ctx.drawImage(img, 0, 0);

            canvas.toBlob((blob) => {
                if (!blob) return;
                const dlUrl = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = dlUrl;
                a.download = `RH_Stocks_Tracker_Net_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.png`;
                document.body.appendChild(a);
                a.click();
                a.remove();
                URL.revokeObjectURL(dlUrl);
            }, "image/png");

            URL.revokeObjectURL(url);
        };
        img.onerror = () => {
            URL.revokeObjectURL(url);
            alert("Failed to export chart.");
        };
        img.src = url;
    };

    // ---------- UI ----------
    const ensurePanel = () => {
        let panel = document.getElementById(PANEL_ID);
        if (panel) return panel;

        panel = document.createElement("div");
        panel.id = PANEL_ID;

        panel.innerHTML = `
      <div id="rhtr-header">
        <div>
          <div id="rhtr-title">RH Stocks Tracker</div>
          <div id="rhtr-sub">Loading…</div>
        </div>
        <button id="rhtr-min" title="Collapse/expand">–</button>
      </div>

      <div id="rhtr-body">
        <div id="rhtr-grid">
          <div class="rhtr-kv"><div class="rhtr-k">Profit</div><div class="rhtr-v rhtr-pos" id="rhtr-profit">—</div></div>
          <div class="rhtr-kv"><div class="rhtr-k">Loss</div><div class="rhtr-v rhtr-neg" id="rhtr-loss">—</div></div>
          <div class="rhtr-kv"><div class="rhtr-k">Net</div><div class="rhtr-v" id="rhtr-net">—</div></div>
          <div class="rhtr-kv"><div class="rhtr-k">Total Equity</div><div class="rhtr-v" id="rhtr-equity">—</div></div>
        </div>

        <div id="rhtr-actions">
          <button class="rhtr-btn" id="rhtr-save">Save snapshot</button>
          <button class="rhtr-btn" id="rhtr-chart">Trend chart</button>
          <button class="rhtr-btn" id="rhtr-export">Export CSV</button>
          <button class="rhtr-btn" id="rhtr-clear">Clear history</button>
        </div>

        <div id="rhtr-tablewrap">
          <table id="rhtr-table">
            <thead>
              <tr>
                <th style="min-width:80px;">Date</th>
                <th style="min-width:70px;">Time</th>
                <th>Profit</th>
                <th>Loss</th>
                <th>Net</th>
                <th>Total Equity</th>
                <th style="min-width:74px;">Action</th>
              </tr>
            </thead>
            <tbody id="rhtr-tbody"></tbody>
          </table>
        </div>
      </div>

      <div id="rhtr-footer">
        Click “Save snapshot” to store your totals locally in your browser. Use “Export CSV” to download your history.
      </div>
    `;

        document.documentElement.appendChild(panel);

        panel.querySelector("#rhtr-min").addEventListener("click", () => {
            panel.classList.toggle("rhtr-collapsed");
            panel.querySelector("#rhtr-min").textContent = panel.classList.contains("rhtr-collapsed") ? "+" : "–";
        });

        // Delete delegation
        panel.addEventListener("click", async (e) => {
            const btn = e.target?.closest?.("[data-rhtr-delete]");
            if (!btn) return;
            const epochMs = Number(btn.getAttribute("data-rhtr-delete"));
            if (!Number.isFinite(epochMs)) return;
            if (!confirm("Delete this snapshot?")) return;
            await deleteSnapshot(epochMs);
            await renderHistory();
        });

        panel.querySelector("#rhtr-save").addEventListener("click", async () => {
            const computed = computeTotals();
            updateSummaryUI(computed);

            const res = await saveSnapshot(computed);
            if (!res.ok) {
                const sub = document.getElementById("rhtr-sub");
                if (sub) sub.textContent = res.reason;
                return;
            }
            await renderHistory();
        });

        panel.querySelector("#rhtr-chart").addEventListener("click", showChartOverlay);
        panel.querySelector("#rhtr-export").addEventListener("click", exportCSV);

        panel.querySelector("#rhtr-clear").addEventListener("click", async () => {
            if (!confirm("Clear all stored snapshots?")) return;
            await clearHistory();
            await renderHistory();
        });

        return panel;
    };

    const removePanel = () => {
        document.getElementById(PANEL_ID)?.remove();
        document.getElementById(CHART_ID)?.remove();
        document.getElementById("rhtr-tip")?.remove();
    };

    const updateSummaryUI = (result) => {
        const sub = document.getElementById("rhtr-sub");
        const p = document.getElementById("rhtr-profit");
        const l = document.getElementById("rhtr-loss");
        const n = document.getElementById("rhtr-net");
        const e = document.getElementById("rhtr-equity");
        if (!sub || !p || !l || !n || !e) return;

        if (!result.ok) {
            sub.textContent = result.reason || "Unable to compute totals.";
            p.textContent = "—";
            l.textContent = "—";
            n.textContent = "—";
            e.textContent = "—";
            n.className = "rhtr-v";
            return;
        }

        sub.textContent = `Total stocks: ${result.totalStocks} • ${lastUpdatedStamp()}`;
        p.textContent = centsToMoney(result.profitCents);
        l.textContent = centsToMoney(result.lossCents);
        n.textContent = centsToMoney(result.netCents);
        e.textContent = centsToMoney(result.equityCents);
        n.className = "rhtr-v " + (result.netCents >= 0 ? "rhtr-pos" : "rhtr-neg");
    };

    const renderHistory = async () => {
        const panel = document.getElementById(PANEL_ID);
        const tbody = panel?.querySelector("#rhtr-tbody");
        if (!tbody) return;

        const {snapshots = []} = await chrome.storage.local.get({snapshots: []});
        tbody.innerHTML = "";

        const sorted = snapshots.slice().sort((a, b) => b.epochMs - a.epochMs);

        for (const s of sorted) {
            const netClass = s.netCents >= 0 ? "rhtr-pos" : "rhtr-neg";
            const delStyle = [
                "cursor:pointer",
                "border:1px solid rgba(255,255,255,0.25)",
                "background:rgba(248,113,113,0.22)",
                "color:#f9fafb",
                "border-radius:10px",
                "padding:6px 10px",
                "font-size:12px",
                "font-weight:800",
                "line-height:1",
                "display:inline-block",
            ].join(";");

            const tr = document.createElement("tr");
            tr.innerHTML = `
        <td>${s.date}</td>
        <td>${s.time}</td>
        <td class="rhtr-pos">${centsToMoney(s.profitCents)}</td>
        <td class="rhtr-neg">${centsToMoney(s.lossCents)}</td>
        <td class="${netClass}">${centsToMoney(s.netCents)}</td>
        <td>${centsToMoney(s.equityCents)}</td>
        <td style="text-align:right;">
          <button data-rhtr-delete="${s.epochMs}" style="${delStyle}">Delete</button>
        </td>
      `;
            tbody.appendChild(tr);
        }
    };

    // ---------- lifecycle (route-guard) ----------
    let active = false;
    let mo = null;
    let computeInterval = null;

    const start = () => {
        if (active) return;
        active = true;

        ensurePanel();
        renderHistory();

        const runCompute = () => {
            if (!active) return;
            updateSummaryUI(computeTotals());
        };

        runCompute();
        computeInterval = setInterval(runCompute, 3000);

        mo = new MutationObserver(runCompute);
        mo.observe(document.body, {childList: true, subtree: true});
    };

    const stop = () => {
        if (!active) return;
        active = false;

        if (mo) {
            mo.disconnect();
            mo = null;
        }
        if (computeInterval) {
            clearInterval(computeInterval);
            computeInterval = null;
        }
        removePanel();
    };

    const tick = () => {
        if (isInvestingPage()) start();
        else stop();
    };

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", tick, {once: true});
    } else {
        tick();
    }

    window.addEventListener("load", tick, {once: true});
    setInterval(tick, 800);
})();
