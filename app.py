"""ICU 文案分支预览器 — Flask 入口。"""
import os

from flask import Flask, jsonify, render_template, request

from icu import MAX_SCENARIOS, analyze, run_regression

app = Flask(__name__)
app.config["JSON_AS_ASCII"] = False  # 响应中保留中文


@app.get("/")
def index():
    return render_template("index.html")


@app.post("/api/preview")
def preview():
    data = request.get_json(force=True, silent=True) or {}
    template = data.get("template", "")
    locale = data.get("locale", "en")
    variables = data.get("variables", {})
    if not isinstance(template, str):
        return jsonify({"ok": False, "errors": [{
            "message": "template 必须是字符串", "pos": 0, "length": 1,
            "line": 1, "col": 1, "severity": "error"}]}), 400
    if not isinstance(variables, dict):
        variables = {}
    return jsonify(analyze(template, locale, variables))


@app.post("/api/regression")
def regression():
    """场景集批量回归：对多组带名称的 (locale, variables) 批量分析并合并覆盖。

    请求体：{"template": "...", "scenarios": [{"id", "name", "locale", "variables"}, ...]}
    单个场景失败会在 scenarios[i].error 中保留错误，不影响其他场景。
    """
    data = request.get_json(force=True, silent=True) or {}
    template = data.get("template", "")
    scenarios = data.get("scenarios", [])
    if not isinstance(template, str):
        return jsonify({"ok": False, "errors": [{
            "message": "template 必须是字符串", "pos": 0, "length": 1,
            "line": 1, "col": 1, "severity": "error"}]}), 400
    if not isinstance(scenarios, list):
        return jsonify({"ok": False, "errors": [{
            "message": "scenarios 必须是数组", "pos": 0, "length": 1,
            "line": 1, "col": 1, "severity": "error"}]}), 400
    if not scenarios:
        return jsonify({"ok": False, "errors": [{
            "message": "scenarios 不能为空", "pos": 0, "length": 1,
            "line": 1, "col": 1, "severity": "error"}]}), 400
    if len(scenarios) > MAX_SCENARIOS:
        return jsonify({"ok": False, "errors": [{
            "message": f"场景数量超过上限 {MAX_SCENARIOS}", "pos": 0,
            "length": 1, "line": 1, "col": 1, "severity": "error"}]}), 400
    return jsonify(run_regression(template, scenarios))


@app.get("/api/health")
def health():
    return jsonify({"status": "ok"})


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "5000"))
    app.run(host="0.0.0.0", port=port, debug=False)
