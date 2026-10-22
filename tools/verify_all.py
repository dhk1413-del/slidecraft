# -*- coding: utf-8 -*-
"""一键验收：跑齐所有离线回归 + 前端构建（可选线上只读冒烟）。

用法：
    .venv/bin/python tools/verify_all.py            # 全绿才算过（回归 + 构建）
    .venv/bin/python tools/verify_all.py --live     # 额外探一次线上服务（只读）
    .venv/bin/python tools/verify_all.py --no-build # 只跑后端回归

约定：每个回归脚本自带 `通过 N 项，失败 M 项` 汇总行；本脚本只做编排与总账，
不重复实现断言（避免第二套真相）。退出码非 0 表示有失败项。
"""
import os
import subprocess
import sys
import tempfile
import urllib.request

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
VENV = os.path.join(ROOT, ".venv/bin/python")
BASE = "http://127.0.0.1:8641"

# 顺序即推荐阅读顺序：先本特征，再更宽的回归
TOOLS = [
    ("test_beautify_v2", "美化 v2（离线真源/缓存/零 key/不伪造成功）"),
    ("test_page_import", "图片转可编辑（三源渲染/缓存自愈/slides 幂等）"),
    ("test_source_pages", "原稿缩略图（缓存命中/降级/自愈）"),
    ("test_db_update", "db.update 列自适应（exports 无 updated_at 也能更新）"),
    ("test_project_delete", "删除项目（守卫/记录与磁盘清理/账本保留/越界保护）"),
    ("test_provider_usage", "供应商面板用量（New API 计费/币种折算/快照增量/缓存/脱敏）"),
    ("test_editppt_engine", "精细重建引擎接入（可用性/提示合成/失败聚合）"),
    ("test_editppt_validation_race", "精细重建·校验读取时序（重试窗口/不假绿）"),
    ("test_vision_layout", "视觉识别→版面块映射（单位自适应/脏块丢弃/图表抽取）"),
    ("test_native_status", "slides 的 native_status 汇报口径（别把从未构建报成待重建）"),
    ("test_outline_sync", "编辑大纲 → 内容梳理 内容同步（标题/摘要/原文落库/修订号只 bump 一次）"),
    ("test_slide_delete", "内容梳理删除此页/撤销（页码重排/快照还原/至少留 1 页）"),
    ("test_native_render", "原生可编辑渲染器（不伪造内容）"),
    ("test_vision_parse", "视觉解析（宽容解析/图表归一化）"),
    ("test_vision_config", "视觉模型配置（GuaiHub 中转 key 兜底/百炼优先/脱敏）"),
    ("test_dashscope_image", "百炼生图适配器（模型族分流）"),
    ("test_image_retry", "生图重试与链路切换（瞬态重试/代理↔直连/401 不重试）"),
    ("test_slide_notes", "讲稿备注模块"),
    ("test_style_builder", "风格构建（上传模板/参考图 → 证据分层 → 令牌合成 → 落盘后在风格库可见）"),
    ("test_install_agent", "agent 链自动安装（Harness/CLI/skill 判定、尽力而为、可跳过、状态落盘）"),
]


def run_tool(name: str) -> tuple:
    path = os.path.join(ROOT, "tools", "%s.py" % name)
    if not os.path.isfile(path):
        return False, "脚本缺失"
    proc = subprocess.run([VENV, path], capture_output=True, text=True, cwd=ROOT)
    tail = [l.strip() for l in proc.stdout.splitlines() if l.startswith("通过")]
    detail = tail[-1] if tail else (proc.stderr or proc.stdout).strip().splitlines()[-1][:80]
    return proc.returncode == 0, detail


def run_build() -> tuple:
    web = os.path.join(ROOT, "web")
    if not os.path.isdir(os.path.join(web, "node_modules")):
        return False, "web/node_modules 缺失"
    # 验收构建不覆盖正在托管的 web/dist。
    with tempfile.TemporaryDirectory(prefix="deckforge-build-") as out_dir:
        proc = subprocess.run(["npm", "run", "build", "--", "--outDir", out_dir],
                              capture_output=True, text=True, cwd=web)
    out = ((proc.stdout or "") + (proc.stderr or "")).strip().splitlines()
    return proc.returncode == 0, (out[-1] if out else "")[:70]


def live_smoke() -> tuple:
    """只读冒烟：不写库、不调模型、不花钱。"""
    try:
        with urllib.request.urlopen(BASE + "/api/health", timeout=5) as r:
            import json
            health = json.loads(r.read().decode())
        with urllib.request.urlopen(BASE + "/api/style-packs", timeout=5) as r:
            import json
            packs = json.loads(r.read().decode())["items"]
        with urllib.request.urlopen(BASE + "/api/projects", timeout=5) as r:
            import json
            projects = json.loads(r.read().decode())["items"]
        return True, "ok=%s · 风格包 %d 套 · 项目 %d 个" % (health.get("ok"), len(packs), len(projects))
    except Exception as exc:  # 服务没起 / 端口不通都算冒烟失败，但不影响回归结论
        return False, "线上不可达：%s" % exc


def main() -> int:
    args = set(sys.argv[1:])
    with_build = "--no-build" not in args
    with_live = "--live" in args

    if not os.path.exists(VENV):
        print("⚠️ 未找到 .venv：先执行一次 `bash server/start-lan.sh`（会自动建虚拟环境并安装 Python 依赖），再跑自检。")
    if not os.path.exists(os.path.join(ROOT, "server/pptx/node_modules/pptxgenjs")):
        print("⚠️ 未找到 server/pptx/node_modules（PptxGenJS）：原生可编辑导出相关用例会失败。先执行一次 `bash server/start-lan.sh` 自动安装，再跑自检。")
    if not os.path.isdir(os.path.join(ROOT, "web/node_modules")):
        print("⚠️ 未找到 web/node_modules：前端构建这一步会被跳过/失败。先执行 `cd web && npm install`，再跑自检。")

    rows = []
    for name, desc in TOOLS:
        ok, detail = run_tool(name)
        rows.append((name, ok, detail))
        print("  %s %-22s %s" % ("✅" if ok else "❌", name, detail))

    if with_build:
        ok, detail = run_build()
        rows.append(("web build", ok, detail))
        print("  %s %-22s %s" % ("✅" if ok else "❌", "web build", detail))

    if with_live:
        ok, detail = live_smoke()
        rows.append(("线上只读冒烟", ok, detail))
        print("  %s %-22s %s" % ("✅" if ok else "❌", "线上只读冒烟", detail))

    failed = [name for name, ok, _ in rows if not ok]
    print("\n%d 项检查：%d 通过 / %d 失败%s"
          % (len(rows), len(rows) - len(failed), len(failed),
             "" if not failed else "（失败：" + ", ".join(failed) + "）"))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
