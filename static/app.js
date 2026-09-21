/* ICU 文案分支预览器 — 前端逻辑 */
(function () {
  "use strict";

  var tpl = document.getElementById("template");
  var hl = document.getElementById("highlight");
  var localeInput = document.getElementById("locale");
  var messagesEl = document.getElementById("messages");
  var varRowsEl = document.getElementById("varRows");
  var mainResultEl = document.getElementById("mainResult");
  var mainCondsEl = document.getElementById("mainConds");
  var statsEl = document.getElementById("stats");
  var nodesEl = document.getElementById("nodes");
  var pathsEl = document.getElementById("paths");
  var toastEl = document.getElementById("toast");

  var scenarioListEl = document.getElementById("scenarioList");
  var regSummaryEl = document.getElementById("regSummary");
  var mergedStatsEl = document.getElementById("mergedStats");
  var mergedPathsEl = document.getElementById("mergedPaths");
  var chkOnlyUncovered = document.getElementById("chkOnlyUncovered");

  var lastResult = null;
  var debounceTimer = null;

  // 场景集：scenarios 为场景定义（持久化到 localStorage），
  // regressionData 为最近一次（或局部重跑后合并的）逐场景结果与合并视图（仅内存）。
  var scenarios = [];
  var regressionData = null;
  var regressionRunning = false;
  var STORAGE_KEY = "icu-previewer-scenarios";

  var DEFAULT_TEMPLATE =
    "{gender, select, male{He} female{She} other{They}} has " +
    "{count, plural, =0{no new messages} one{# new message} other{# new messages}}.";

  /* ---------------- 工具 ---------------- */

  function esc(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function toast(text) {
    toastEl.textContent = text;
    toastEl.classList.add("show");
    setTimeout(function () { toastEl.classList.remove("show"); }, 1600);
  }

  function copyText(text, label) {
    function done() { toast(label || "已复制"); }
    function fallback() {
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); done(); }
      catch (e) { toast("复制失败，请手动复制"); }
      document.body.removeChild(ta);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, fallback);
    } else {
      fallback();
    }
  }

  function parseValue(raw) {
    var t = raw.trim();
    if (t === "true") return true;
    if (t === "false") return false;
    if (t !== "" && !isNaN(Number(t))) return Number(t);
    return raw;
  }

  function typeLabel(v) {
    if (typeof v === "number") return "数字";
    if (typeof v === "boolean") return "布尔";
    return "字符串";
  }

  /* ---------------- 变量行 ---------------- */

  function addVarRow(name, value) {
    var row = document.createElement("div");
    row.className = "var-row";

    var nameInput = document.createElement("input");
    nameInput.className = "var-name";
    nameInput.placeholder = "变量名";
    nameInput.value = name || "";

    var valueInput = document.createElement("input");
    valueInput.className = "var-value";
    valueInput.placeholder = "样例值";
    valueInput.value = value === undefined ? "" : String(value);

    var typeBadge = document.createElement("span");
    typeBadge.className = "var-type";
    typeBadge.textContent = "字符串";

    var del = document.createElement("button");
    del.className = "var-del";
    del.textContent = "×";
    del.title = "删除该变量";
    del.addEventListener("click", function () {
      row.remove();
      scheduleAnalyze();
    });

    function updateType() {
      typeBadge.textContent = typeLabel(parseValue(valueInput.value));
    }
    valueInput.addEventListener("input", function () { updateType(); scheduleAnalyze(); });
    nameInput.addEventListener("input", scheduleAnalyze);
    updateType();

    row.appendChild(nameInput);
    row.appendChild(valueInput);
    row.appendChild(typeBadge);
    row.appendChild(del);
    varRowsEl.appendChild(row);
  }

  function collectVariables() {
    var vars = {};
    var rows = varRowsEl.querySelectorAll(".var-row");
    for (var i = 0; i < rows.length; i++) {
      var name = rows[i].querySelector(".var-name").value.trim();
      var raw = rows[i].querySelector(".var-value").value;
      if (name) vars[name] = parseValue(raw);
    }
    return vars;
  }

  /* ---------------- 模板高亮 ---------------- */

  function renderHighlight(tokens, errors) {
    var text = tpl.value;
    // 汇总所有染色区间：token 在前，error 覆盖其上
    var spans = [];
    (tokens || []).forEach(function (t) {
      spans.push({ start: t.start, end: t.end, cls: "tok-" + t.cls });
    });
    (errors || []).forEach(function (e) {
      if (e.pos === null || e.pos === undefined) return;
      spans.push({ start: e.pos, end: e.pos + (e.length || 1), cls: "tok-error" });
    });
    if (!text) {
      hl.innerHTML = "\n";
      return;
    }
    // 切分边界
    var cuts = { 0: true };
    cuts[text.length] = true;
    spans.forEach(function (s) {
      cuts[Math.max(0, Math.min(text.length, s.start))] = true;
      cuts[Math.max(0, Math.min(text.length, s.end))] = true;
    });
    var points = Object.keys(cuts).map(Number).sort(function (a, b) { return a - b; });
    var html = "";
    for (var i = 0; i < points.length - 1; i++) {
      var a = points[i], b = points[i + 1];
      var cls = null;
      for (var j = 0; j < spans.length; j++) {
        if (spans[j].start <= a && spans[j].end >= b) {
          if (spans[j].cls === "tok-error") { cls = "tok-error"; break; }
          if (!cls) cls = spans[j].cls;
        }
      }
      var piece = esc(text.slice(a, b));
      html += cls ? '<span class="' + cls + '">' + piece + "</span>" : piece;
    }
    hl.innerHTML = html + "\n";
  }

  tpl.addEventListener("scroll", function () {
    hl.scrollTop = tpl.scrollTop;
    hl.scrollLeft = tpl.scrollLeft;
  });

  /* ---------------- 消息列表 ---------------- */

  function renderMessages(result) {
    messagesEl.innerHTML = "";
    var all = [];
    (result.errors || []).forEach(function (e) { all.push({ kind: "error", label: "错误", data: e }); });
    (result.warnings || []).forEach(function (w) { all.push({ kind: "warning", label: "警告", data: w }); });
    (result.infos || []).forEach(function (i) { all.push({ kind: "info", label: "提示", data: i }); });
    all.forEach(function (item) {
      var d = item.data;
      var div = document.createElement("div");
      div.className = "msg msg-" + item.kind;
      var loc = "";
      if (d.line !== null && d.line !== undefined) {
        loc = "第 " + d.line + " 行 " + d.col + " 列：";
      }
      div.innerHTML = '<span class="tag">' + item.label + "</span><span>" +
        esc(loc + d.message) + "</span>";
      if (d.pos !== null && d.pos !== undefined) {
        div.title = "点击定位到出错位置";
        div.addEventListener("click", function () {
          tpl.focus();
          var end = Math.min(tpl.value.length, d.pos + (d.length || 1));
          tpl.setSelectionRange(d.pos, end);
        });
      }
      messagesEl.appendChild(div);
    });
  }

  /* ---------------- 结果渲染 ---------------- */

  function badge(covered, reachable, coverageAvailable) {
    if (!reachable) return '<span class="badge badge-dead">不可达</span>';
    if (!coverageAvailable) return '<span class="badge badge-dead">覆盖未知</span>';
    return covered
      ? '<span class="badge badge-covered">已覆盖</span>'
      : '<span class="badge badge-uncovered">未覆盖</span>';
  }

  function renderResult(result) {
    lastResult = result;

    renderHighlight(result.tokens, result.errors);
    renderMessages(result);

    // 主渲染
    if (result.main) {
      mainResultEl.textContent = result.main.output || "（空）";
      mainCondsEl.innerHTML = "";
      (result.main.conditions || []).forEach(function (c) {
        var chip = document.createElement("span");
        chip.className = "chip";
        chip.textContent = c;
        mainCondsEl.appendChild(chip);
      });
      if (result.main.incomplete) {
        var warn = document.createElement("span");
        warn.className = "chip";
        warn.textContent = "⚠ 分支变量缺失或类型错误，覆盖情况不可判定";
        mainCondsEl.appendChild(warn);
      }
    }

    // 统计
    var st = result.stats || {};
    var statText = "共 " + st.total_paths + " 条路径";
    if (st.truncated) statText += "（仅展示前 " + st.shown_paths + " 条）";
    if (st.coverage_available) {
      statText += "，样例覆盖 " + st.covered_paths + " 条";
    }
    statsEl.textContent = statText;

    // 分支节点
    nodesEl.innerHTML = "";
    if (!result.nodes || !result.nodes.length) {
      nodesEl.innerHTML = '<div class="empty">模板中没有 plural / select 分支节点。</div>';
    }
    (result.nodes || []).forEach(function (node) {
      var card = document.createElement("div");
      card.className = "node-card";
      var kindCls = node.kind === "select" ? "select" : "";
      var html = '<div class="node-head">' +
        '<span class="node-kind ' + kindCls + '">' + esc(node.kind) + "</span>" +
        "<span>变量 " + esc(node.variable) + "</span></div>";
      node.branches.forEach(function (b) {
        var rowCls = "branch-row" + (!b.reachable ? " dead" : (!b.covered ? " uncovered" : ""));
        html += '<div class="' + rowCls + '">' +
          '<span class="branch-sel">' + esc(b.selector) + "</span>" +
          '<span class="branch-cond">' + esc(b.condition) + "</span>" +
          badge(b.covered, b.reachable, st.coverage_available) +
          "</div>";
      });
      card.innerHTML = html;
      nodesEl.appendChild(card);
    });

    // 路径列表
    pathsEl.innerHTML = "";
    if (!result.paths || !result.paths.length) {
      pathsEl.innerHTML = '<div class="empty">没有可枚举的分支路径。</div>';
    }
    (result.paths || []).forEach(function (p) {
      var card = document.createElement("div");
      card.className = "path-card" + (p.covered ? "" : " uncovered");
      card.setAttribute("data-key", p.key || "");
      var head = document.createElement("div");
      head.className = "path-head";
      var idSpan = document.createElement("span");
      idSpan.className = "path-id";
      idSpan.textContent = "#" + p.id;
      head.appendChild(idSpan);
      p.conditions.forEach(function (c) {
        var chip = document.createElement("span");
        chip.className = "chip";
        chip.textContent = c;
        head.appendChild(chip);
      });
      var badgeSpan = document.createElement("span");
      badgeSpan.innerHTML = badge(p.covered, true, st.coverage_available);
      head.appendChild(badgeSpan);
      var copyBtn = document.createElement("button");
      copyBtn.className = "btn btn-small path-copy";
      copyBtn.textContent = "复制";
      copyBtn.addEventListener("click", function () { copyText(p.output, "已复制路径 #" + p.id); });
      head.appendChild(copyBtn);
      var out = document.createElement("div");
      out.className = "path-output";
      out.textContent = p.output;
      card.appendChild(head);
      card.appendChild(out);
      pathsEl.appendChild(card);
    });
  }

  /* ---------------- 分析请求 ---------------- */

  function analyze() {
    syncScenarioStore();
    var payload = {
      template: tpl.value,
      locale: localeInput.value.trim() || "en",
      variables: collectVariables(),
    };
    fetch("/api/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
      .then(function (r) { return r.json(); })
      .then(renderResult)
      .catch(function () {
        messagesEl.innerHTML =
          '<div class="msg msg-error"><span class="tag">错误</span>' +
          "<span>无法连接服务器</span></div>";
      });
  }

  function scheduleAnalyze() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(analyze, 350);
  }

  /* ---------------- 事件绑定 ---------------- */

  tpl.addEventListener("input", scheduleAnalyze);
  localeInput.addEventListener("input", scheduleAnalyze);

  document.getElementById("btnAddVar").addEventListener("click", function () {
    addVarRow("", "");
  });

  document.getElementById("btnExtract").addEventListener("click", function () {
    if (!lastResult || !lastResult.variables_used) { analyze(); return; }
    var existing = {};
    varRowsEl.querySelectorAll(".var-name").forEach(function (inp) {
      existing[inp.value.trim()] = true;
    });
    var added = 0;
    lastResult.variables_used.forEach(function (name) {
      if (!existing[name]) { addVarRow(name, ""); added++; }
    });
    toast(added ? "已添加 " + added + " 个变量" : "模板变量均已在列表中");
    if (added) scheduleAnalyze();
  });

  document.getElementById("btnCopyMain").addEventListener("click", function () {
    if (lastResult && lastResult.main) copyText(lastResult.main.output, "已复制渲染结果");
  });

  document.getElementById("btnCopyAll").addEventListener("click", function () {
    if (!lastResult || !lastResult.paths) return;
    var text = lastResult.paths.map(function (p) {
      return "#" + p.id + " [" + p.conditions.join("; ") + "]\n" + p.output;
    }).join("\n\n");
    copyText(text, "已复制全部路径");
  });

  document.getElementById("btnExport").addEventListener("click", function () {
    if (!lastResult) return;
    var data = {
      tool: "icu-branch-previewer",
      exported_at: new Date().toISOString(),
      template: tpl.value,
      locale: localeInput.value.trim() || "en",
      variables: collectVariables(),
      result: lastResult,
    };
    var blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "icu-branch-preview.json";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(a.href);
    toast("已导出 JSON");
  });

  /* ---------------- 场景集回归 ---------------- */

  function hashTemplate(s) {
    // djb2：用作 localStorage 中按模板区分场景的键
    var h = 5381;
    for (var i = 0; i < s.length; i++) {
      h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    }
    return "t" + (h >>> 0).toString(36) + ":" + s.length;
  }

  function genId() {
    return "s" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
  }

  function storageKey() {
    return STORAGE_KEY + ":" + hashTemplate(tpl.value || "");
  }

  function persistScenarios() {
    try {
      localStorage.setItem(storageKey(), JSON.stringify(scenarios));
    } catch (e) { /* localStorage 不可用时静默降级为仅当前会话 */ }
  }

  function loadScenarios() {
    scenarios = [];
    try {
      var raw = localStorage.getItem(storageKey());
      if (raw) {
        var arr = JSON.parse(raw);
        if (Array.isArray(arr)) scenarios = arr;
      }
    } catch (e) { scenarios = []; }
    regressionData = null;
  }

  function varsSummary(v) {
    var keys = Object.keys(v || {});
    if (!keys.length) return "（无变量）";
    return keys.map(function (k) {
      var val = v[k];
      if (typeof val === "string") val = '"' + val + '"';
      return k + "=" + String(val);
    }).join(", ");
  }

  function escapeAttr(s) {
    return esc(s).replace(/'/g, "&#39;");
  }

  function renderScenarioList() {
    scenarioListEl.innerHTML = "";
    if (!scenarios.length) {
      scenarioListEl.innerHTML =
        '<div class="empty">尚未保存场景。调好 locale 与变量后点击「保存当前为场景」。</div>';
      regSummaryEl.textContent = "";
      return;
    }
    var resultById = {};
    if (regressionData) {
      regressionData.scenarios.forEach(function (s) {
        if (s.id) resultById[s.id] = s;
      });
    }
    scenarios.forEach(function (sc) {
      var row = document.createElement("div");
      row.className = "scenario-row";
      var r = resultById[sc.id];

      var nameWrap = document.createElement("div");
      nameWrap.className = "sc-name-wrap";
      var nameEl = document.createElement("span");
      nameEl.className = "sc-name";
      nameEl.textContent = sc.name;
      nameEl.title = "点击重命名";
      nameWrap.appendChild(nameEl);

      var meta = document.createElement("div");
      meta.className = "sc-meta";
      meta.innerHTML =
        '<span class="chip">locale: ' + escapeAttr(sc.locale) + "</span>" +
        '<span class="sc-vars" title="变量样例">' + escapeAttr(varsSummary(sc.variables)) + "</span>";

      var status = document.createElement("span");
      status.className = "sc-status";
      if (regressionData && r) {
        if (r.error) {
          status.innerHTML = '<span class="badge badge-error">失败</span>';
          status.title = r.error;
        } else {
          var cov = r.stats ? r.stats.covered_paths : 0;
          var tot = r.stats ? r.stats.shown_paths : 0;
          status.innerHTML = '<span class="badge badge-covered">完成</span>' +
            '<span class="sc-cov">' + cov + "/" + tot + "</span>";
        }
      } else if (regressionData && !r) {
        status.innerHTML = '<span class="badge badge-dead">未运行</span>';
      }

      var actions = document.createElement("div");
      actions.className = "sc-actions";

      var loadBtn = document.createElement("button");
      loadBtn.className = "btn btn-small";
      loadBtn.textContent = "载入";
      loadBtn.title = "把该场景的 locale 与变量载入左侧编辑器";
      loadBtn.addEventListener("click", function () { loadScenario(sc.id); });

      var rerunBtn = document.createElement("button");
      rerunBtn.className = "btn btn-small";
      rerunBtn.textContent = "重跑";
      rerunBtn.title = "仅重新分析该场景并刷新合并结果";
      rerunBtn.addEventListener("click", function () { rerunScenario(sc.id); });

      var renameBtn = document.createElement("button");
      renameBtn.className = "btn btn-small";
      renameBtn.textContent = "重命名";
      renameBtn.addEventListener("click", function () { renameScenario(sc.id); });

      var delBtn = document.createElement("button");
      delBtn.className = "btn btn-small sc-del";
      delBtn.textContent = "删除";
      delBtn.addEventListener("click", function () { deleteScenario(sc.id); });

      actions.appendChild(loadBtn);
      actions.appendChild(rerunBtn);
      actions.appendChild(renameBtn);
      actions.appendChild(delBtn);

      row.appendChild(nameWrap);
      row.appendChild(meta);
      row.appendChild(status);
      row.appendChild(actions);

      // 失败场景：点击错误徽标可定位模板中的错误位置
      if (regressionData && r && r.error && (r.errors || []).length) {
        status.style.cursor = "pointer";
        status.addEventListener("click", function () {
          var e = (r.errors || [])[0];
          if (e && e.pos !== null && e.pos !== undefined) {
            tpl.focus();
            tpl.setSelectionRange(e.pos, Math.min(tpl.value.length, e.pos + (e.length || 1)));
          }
        });
      }
      scenarioListEl.appendChild(row);
    });

    var summary = regressionData && regressionData.summary;
    regSummaryEl.textContent = summary
      ? "已运行 " + (summary.succeeded + summary.failed) + "/" + scenarios.length +
        " 个场景（成功 " + summary.succeeded + "，失败 " + summary.failed + "）"
      : "共 " + scenarios.length + " 个场景";
  }

  function loadScenario(id) {
    var sc = scenarios.filter(function (s) { return s.id === id; })[0];
    if (!sc) return;
    localeInput.value = sc.locale;
    varRowsEl.innerHTML = "";
    Object.keys(sc.variables).forEach(function (k) {
      addVarRow(k, sc.variables[k]);
    });
    scheduleAnalyze();
    toast('已载入场景「' + sc.name + '」');
  }

  function renameScenario(id) {
    var sc = scenarios.filter(function (s) { return s.id === id; })[0];
    if (!sc) return;
    var name = window.prompt("场景名称", sc.name);
    if (name === null) return;
    name = name.trim();
    if (name) {
      sc.name = name.slice(0, 80);
      persistScenarios();
      if (regressionData) {
        regressionData.scenarios.forEach(function (r) {
          if (r.id === id) r.name = sc.name;
        });
        rebuildMerged();
      }
      renderScenarioList();
    }
  }

  function deleteScenario(id) {
    var sc = scenarios.filter(function (s) { return s.id === id; })[0];
    if (sc && !window.confirm('删除场景「' + sc.name + '」？')) return;
    scenarios = scenarios.filter(function (s) { return s.id !== id; });
    persistScenarios();
    if (regressionData) {
      regressionData.scenarios = regressionData.scenarios.filter(function (s) {
        return s.id !== id;
      });
      rebuildMerged();
    }
    renderScenarioList();
  }

  document.getElementById("btnSaveScenario").addEventListener("click", function () {
    var name = window.prompt("场景名称",
      (localeInput.value.trim() || "en") + " · " + new Date().toLocaleTimeString());
    if (name === null) return;
    name = name.trim();
    if (!name) name = "场景 " + (scenarios.length + 1);
    scenarios.push({
      id: genId(),
      name: name.slice(0, 80),
      locale: localeInput.value.trim() || "en",
      variables: collectVariables(),
    });
    persistScenarios();
    renderScenarioList();
    toast("已保存场景");
  });

  /* 合并视图：根据逐场景 paths（key → covered）重建路径并集。
     与后端 run_regression 的合并语义保持一致，用于删除/重跑单个场景。 */
  function rebuildMerged() {
    if (!regressionData) return;
    var order = [];
    var map = {};
    var templateData = regressionData._pathIndex || {};
    function getPath(key) {
      if (templateData[key]) return templateData[key];
      // 兜底：从逐场景结果里找不到条件时，只保留 key
      return { key: key, conditions: [key], output: "" };
    }
    regressionData.scenarios.forEach(function (s) {
      if (s.error) return;
      (s.paths || []).forEach(function (p) {
        if (!map[p.key]) {
          var base = getPath(p.key);
          map[p.key] = {
            key: p.key,
            conditions: base.conditions,
            output: p.output || base.output,
            covered: false,
            covered_by: [],
          };
          order.push(p.key);
        }
        if (p.covered) {
          map[p.key].covered = true;
          if (map[p.key].covered_by.indexOf(s.name) < 0) {
            map[p.key].covered_by.push(s.name);
          }
        }
      });
    });
    var merged = order.map(function (k) { return map[k]; });
    regressionData.merged = merged;
    regressionData.summary = {
      scenario_count: scenarios.length,
      succeeded: regressionData.scenarios.filter(function (s) { return !s.error; }).length,
      failed: regressionData.scenarios.filter(function (s) { return !!s.error; }).length,
      total_paths: merged.length,
      covered_paths: merged.filter(function (p) { return p.covered; }).length,
      uncovered_paths: merged.filter(function (p) { return !p.covered; }).length,
    };
  }

  function renderMerged() {
    mergedPathsEl.innerHTML = "";
    if (!regressionData || !regressionData.scenarios.length) {
      mergedStatsEl.textContent = "";
      mergedPathsEl.innerHTML =
        '<div class="empty">点击「运行全部场景」生成合并覆盖视图。</div>';
      return;
    }
    var summary = regressionData.summary || {};
    mergedStatsEl.textContent =
      "共 " + summary.total_paths + " 条路径，已覆盖 " +
      summary.covered_paths + " 条，未覆盖 " + summary.uncovered_paths + " 条";

    var merged = regressionData.merged || [];
    var shown = merged.filter(function (p) {
      return !chkOnlyUncovered.checked || !p.covered;
    });
    if (!shown.length) {
      mergedPathsEl.innerHTML =
        '<div class="empty">' + (chkOnlyUncovered.checked ? "没有未覆盖路径 🎉" : "没有路径。") + "</div>";
      return;
    }
    shown.forEach(function (p) {
      var card = document.createElement("div");
      card.className = "path-card" + (p.covered ? "" : " uncovered clickable");
      card.setAttribute("data-key", p.key);
      var head = document.createElement("div");
      head.className = "path-head";
      var badgeSpan = document.createElement("span");
      badgeSpan.innerHTML = p.covered
        ? '<span class="badge badge-covered">已覆盖</span>'
        : '<span class="badge badge-uncovered">未覆盖</span>';
      head.appendChild(badgeSpan);
      if (p.covered && p.covered_by && p.covered_by.length) {
        var by = document.createElement("span");
        by.className = "sc-covered-by";
        by.textContent = "覆盖来源：" + p.covered_by.join("、");
        head.appendChild(by);
      }
      var copyBtn = document.createElement("button");
      copyBtn.className = "btn btn-small path-copy";
      copyBtn.textContent = "复制";
      copyBtn.addEventListener("click", function () {
        copyText(p.output, "已复制路径渲染结果");
      });
      head.appendChild(copyBtn);

      var conds = document.createElement("div");
      conds.className = "merged-conds";
      (p.conditions || []).forEach(function (c) {
        var chip = document.createElement("span");
        chip.className = "chip";
        chip.textContent = c;
        conds.appendChild(chip);
      });

      var out = document.createElement("div");
      out.className = "path-output";
      out.textContent = p.output;

      card.appendChild(head);
      card.appendChild(conds);
      card.appendChild(out);
      if (!p.covered) {
        card.title = "点击定位到上方「可达分支路径」中的对应触发条件";
        card.addEventListener("click", function () { locatePath(p.key); });
      }
      mergedPathsEl.appendChild(card);
    });
  }

  function locatePath(key) {
    // 1) 在右侧实时预览的路径列表中定位同一条路径
    var target = pathsEl.querySelector('.path-card[data-key="' + key.replace(/"/g, '\\"') + '"]');
    if (target) {
      target.scrollIntoView({ behavior: "smooth", block: "center" });
      target.classList.remove("flash");
      void target.offsetWidth;  // 重置动画
      target.classList.add("flash");
      toast("已定位到对应路径");
      return;
    }
    // 2) 预览中没有（locale 不同）时，展示该路径的触发条件并尝试定位分支节点
    var p = (regressionData.merged || []).filter(function (x) { return x.key === key; })[0];
    if (p && p.conditions && p.conditions.length) {
      var cond = p.conditions[p.conditions.length - 1];
      var selMatch = cond.match(/类别为 "([^"]+)"|= "([^"]+)"|精确匹配/);
      // 尝试高亮分支节点中同名分支行
      var rows = nodesEl.querySelectorAll(".branch-row");
      var matched = null;
      if (selMatch) {
        var want = selMatch[1] || selMatch[2];
        for (var i = 0; i < rows.length; i++) {
          var sel = rows[i].querySelector(".branch-sel");
          if (sel && want && sel.textContent === want) { matched = rows[i]; break; }
        }
      }
      if (!matched && rows.length) matched = rows[rows.length - 1];
      if (matched) {
        matched.scrollIntoView({ behavior: "smooth", block: "center" });
        matched.classList.remove("flash");
        void matched.offsetWidth;
        matched.classList.add("flash");
      }
      toast("触发条件：" + cond);
    }
  }

  chkOnlyUncovered.addEventListener("change", renderMerged);

  function indexPathsByKey(data) {
    var idx = {};
    (data.merged || []).forEach(function (p) { idx[p.key] = p; });
    return idx;
  }

  function runAllScenarios() {
    if (!scenarios.length) {
      toast("请先保存至少一个场景");
      return;
    }
    if (regressionRunning) return;
    regressionRunning = true;
    regSummaryEl.textContent = "分析中…";
    fetch("/api/regression", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        template: tpl.value,
        scenarios: scenarios,
      }),
    })
      .then(function (r) {
        if (!r.ok) return r.json().then(function (j) {
          throw new Error((j.errors && j.errors[0] && j.errors[0].message) || "请求失败");
        });
        return r.json();
      })
      .then(function (data) {
        regressionData = data;
        regressionData._pathIndex = indexPathsByKey(data);
        renderScenarioList();
        renderMerged();
        toast("回归完成：覆盖 " + data.summary.covered_paths + "/" + data.summary.total_paths);
      })
      .catch(function (e) {
        regSummaryEl.textContent = "";
        toast(e.message || "回归请求失败");
      })
      .finally(function () { regressionRunning = false; });
  }

  function rerunScenario(id) {
    var sc = scenarios.filter(function (s) { return s.id === id; })[0];
    if (!sc || regressionRunning) return;
    regressionRunning = true;
    fetch("/api/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ template: tpl.value, locale: sc.locale, variables: sc.variables }),
    })
      .then(function (r) { return r.json(); })
      .then(function (r) {
        // 用单场景结果替换合并视图中该场景的切片，再在前端重建合并
        var entry = {
          id: sc.id,
          name: sc.name,
          locale: sc.locale,
          variables: sc.variables,
          errors: r.errors || [],
          warnings: r.warnings || [],
          main: r.main,
          paths: (r.paths || []).map(function (p) {
            return { key: p.key, covered: !!p.covered, output: p.output };
          }),
          stats: r.stats ? {
            total_paths: r.stats.total_paths,
            shown_paths: r.stats.shown_paths,
            covered_paths: r.stats.covered_paths,
            truncated: r.stats.truncated,
            coverage_available: r.stats.coverage_available,
          } : null,
        };
        // 记录路径条件，供 locale 不同导致主预览缺失时定位
        if (!regressionData) {
          regressionData = { scenarios: [], merged: [], summary: {}, _pathIndex: {} };
        }
        (r.paths || []).forEach(function (p) {
          if (!regressionData._pathIndex[p.key]) {
            regressionData._pathIndex[p.key] = {
              conditions: p.conditions, output: p.output,
            };
          }
        });
        entry.error = r.ok ? null :
          (r.errors || []).map(function (e) { return e.message; }).join("; ") || "模板存在错误";
        var others = regressionData.scenarios.filter(function (s) { return s.id !== id; });
        others.push(entry);
        // 保持场景定义顺序
        regressionData.scenarios = scenarios.map(function (def) {
          return others.filter(function (s) { return s.id === def.id; })[0];
        }).filter(Boolean);
        rebuildMerged();
        renderScenarioList();
        renderMerged();
        toast(entry.error ? '场景「' + sc.name + '」失败（已保留错误）' : '已重跑场景「' + sc.name + '」');
      })
      .catch(function () { toast('场景「' + sc.name + '」请求失败'); })
      .finally(function () { regressionRunning = false; });
  }

  document.getElementById("btnRunRegression").addEventListener("click", runAllScenarios);

  document.getElementById("btnExportRegression").addEventListener("click", function () {
    if (!scenarios.length) { toast("没有可导出的场景"); return; }
    var data = {
      tool: "icu-branch-previewer",
      type: "scenario-regression",
      exported_at: new Date().toISOString(),
      template: tpl.value,
      scenarios: scenarios,
      regression: regressionData ? {
        summary: regressionData.summary,
        scenarios: (regressionData.scenarios || []).map(function (s) {
          return {
            id: s.id, name: s.name, locale: s.locale, variables: s.variables,
            error: s.error || null, errors: s.errors || [],
            stats: s.stats || null, paths: s.paths || [],
          };
        }),
        merged: regressionData.merged || [],
      } : null,
    };
    var blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "icu-regression.json";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(a.href);
    toast("已导出回归 JSON");
  });

  /* ---------------- 初始化 ---------------- */

  var lastTplKey = storageKey();

  function syncScenarioStore() {
    var key = storageKey();
    if (key !== lastTplKey) {
      lastTplKey = key;
      loadScenarios();
      renderScenarioList();
      renderMerged();
    }
  }

  tpl.value = DEFAULT_TEMPLATE;
  addVarRow("gender", "female");
  addVarRow("count", "3");
  lastTplKey = storageKey();
  loadScenarios();
  renderScenarioList();
  renderMerged();
  analyze();
})();