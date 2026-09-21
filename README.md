# ICU 文案分支预览器（ICU MessageFormat Branch Previewer）

一个 Flask 网页工具：粘贴 ICU MessageFormat 模板、填写变量样例，即可
解析嵌套的 `plural` / `select` / `selectordinal` 语法，按语言环境（locale）
渲染所有可达分支并列出每个分支的触发条件。

## 功能

- **全分支预览**：枚举模板的所有可达分支路径（含嵌套），逐条渲染并标注触发条件
  （如 `count = 0（精确匹配）`、`count 的复数类别为 "one"（示例：count = 1）`）。
- **CLDR 复数规则**：按语言环境计算复数类别（cardinal 基于 Babel/CLDR 数据，
  ordinal 内置常见语言规则），同一变量在多个分支间保证路径自洽。
- **行内错误提示**：括号不配对、未知格式类型、缺少 `other` 分支、重复选择器、
  非法复数类别、变量类型错误（如 plural 变量给了字符串）等，均在编辑器中
  以红色波浪线标出，并在下方列出带行列号的说明，点击可定位。
- **未覆盖分支标记**：对照当前变量样例，标记每个分支 / 每条路径为
  「已覆盖 / 未覆盖 / 不可达」（不可达 = 该复数类别在当前语言环境下不存在，
  或被 `=N` 显式分支抢占）。
- **场景集回归**：为当前模板保存多组带名称的 locale 与变量样例（保存在浏览器
  本地），一键批量调用分析接口并合并每条可达路径的覆盖状态。面板显示总路径数、
  已覆盖 / 未覆盖数量与覆盖率进度条；点击未覆盖项可定位到对应路径的触发条件；
  支持单个场景重跑、删除与「载入编辑器」，并可导出包含场景定义与汇总结果的 JSON。
  单个场景失败时保留错误信息并继续运行其余场景。
- **变量管理**：从模板一键提取变量；数值 / 布尔自动识别。
- **复制与导出**：复制单条或全部渲染结果；一键导出包含模板、变量与完整
  分析结果的 JSON 文件；场景集可单独导出为回归报告 JSON。

## 快速开始

### 方式一：Docker Compose（推荐）

```bash
docker compose up --build
```

### 方式二：Docker

```bash
docker build -t icu-branch-previewer .
docker run --rm -p 5000:5000 icu-branch-previewer
```

### 方式三：本地运行

```bash
pip install -r requirements.txt
python app.py            # 或：gunicorn --bind 0.0.0.0:5000 app:app
```

### 访问

启动后在浏览器打开：**http://localhost:5000**

端口可通过环境变量 `PORT` 修改（Compose 中需同步调整 `ports` 映射）。

## 使用说明

1. 在左侧粘贴 ICU MessageFormat 模板，例如：

   ```
   {gender, select, male{He} female{She} other{They}} has {count, plural, =0{no new messages} one{# new message} other{# new messages}}.
   ```

2. 选择语言环境（如 `en`、`zh-Hans`、`ru`、`ar`），并填写变量样例
   （或点「从模板提取变量」）。
3. 右侧实时展示：
   - **样例渲染结果**：当前变量取值下的输出及其命中的分支条件；
   - **分支节点**：每个 plural/select 的全部分支、触发条件与覆盖状态；
   - **可达分支路径**：所有分支组合的渲染结果，未覆盖的以橙色标记。
4. 点击「复制」复制结果，点击「导出 JSON」下载完整分析。

### 场景集回归

页面底部的「场景集回归」面板用于多组样例的批量回归：

1. 在左侧调好 locale 与变量后，点 **＋ 保存当前为场景**，并为场景命名
   （名称可随时就地修改，场景按模板内容保存在浏览器 `localStorage`，
   切换模板时自动加载该模板对应的场景集）。
2. 重复步骤 1 保存多组场景（如 `en` 的 0/1/其他、`ru` 的 few/many 等）。
3. 点 **▶ 运行全部场景**：后端逐个调用分析逻辑并返回合并结果；
   单个场景失败（模板错误、变量类型错误等）会在行内标红显示错误，
   其余场景继续运行，不影响合并。
4. 右侧「合并路径覆盖」显示总路径数、已覆盖 / 未覆盖数量、覆盖率进度条，
   以及每条路径由哪个场景覆盖；**点击任意未覆盖路径**会滚动定位到上方
   「可达分支路径」中的对应卡片并高亮（其触发条件以 chips 展示）。
5. 每个场景支持 **载入**（把 locale/变量填回编辑器）、**重跑**（仅重跑
   该场景并更新合并）、**删除**。
6. 点 **导出场景 JSON** 下载 `icu-scenarios.json`，包含模板、全部场景定义、
   每个场景的通过 / 失败状态与错误、路径覆盖汇总与每条路径在各场景下的输出。

> 单次运行最多 50 个场景；路径合并以模板中分支节点的路由序列为稳定 key，
> 因此不同 locale 下枚举到的路径会取并集。

## HTTP API

`POST /api/preview`

```json
{
  "template": "{count, plural, one{# item} other{# items}}",
  "locale": "en",
  "variables": {"count": 3}
}
```

响应包含 `errors / warnings / infos`（带行列号）、`main`（样例渲染）、
`nodes`（分支结构与覆盖状态）、`paths`（全部可达路径，含稳定标识 `key`）、
`stats`（路径总数、覆盖数、是否截断）以及编辑器高亮用的 `tokens`。

`POST /api/scenarios/run` — 场景集批量回归（单场景失败不中断整批）：

```json
{
  "template": "{g, select, male{He} other{They}} {n, plural, one{#} other{#s}}",
  "scenarios": [
    {"id": "s1", "name": "男-1", "locale": "en", "variables": {"g": "male", "n": 1}},
    {"id": "s2", "name": "其他-2", "locale": "en", "variables": {"g": "x", "n": 2}}
  ]
}
```

响应包含 `summary`（场景通过 / 失败数，路径总数、已覆盖 / 未覆盖数）、
`scenarios`（每个场景的 `status`、`error` 与完整 analyze `result`）以及
`paths`（跨场景合并后的路径，含 `key`、`conditions`、`covered`、
`covered_by` 与各场景输出 `outputs`）。请求体非法或场景数超过 50 返回 400。

## 支持的语法

| 语法 | 示例 |
| --- | --- |
| 简单变量 | `{name}` |
| 数字格式化 | `{n, number}`、`{n, number, percent}` |
| 复数 | `{n, plural, =0{none} one{# item} other{# items}}` |
| 序数 | `{pos, selectordinal, one{#st} two{#nd} few{#rd} other{#th}}` |
| 选择 | `{g, select, male{He} female{She} other{They}}` |
| 偏移 | `{n, plural, offset:1 one{you} other{you and # others}}` |
| 转义 | `''` 输出单引号；`'{`、`'}`、`'#` 输出字面符号 |
| 嵌套 | 以上语法可任意嵌套 |

说明：`date` / `time` / `spellout` / `duration` 类型在预览中原样输出变量值；
路径枚举上限为 300 条（超出会标记 `truncated`）。

## 项目结构

```
├── app.py               # Flask 入口（/、/api/preview、/api/scenarios/run）
├── icu.py               # ICU 解析器、渲染器、分支枚举、覆盖分析与场景集合并
├── templates/index.html # 单页界面（含场景集回归面板）
├── static/app.js        # 前端逻辑（高亮、实时分析、场景集、复制、导出）
├── static/style.css
├── tests/test_icu.py    # ICU 解析/渲染/场景集单元测试
├── tests/test_app.py    # Flask 接口测试
├── requirements.txt
├── Dockerfile
└── docker-compose.yml
```

## 测试

```bash
pip install pytest
python -m pytest tests/ -q
```
