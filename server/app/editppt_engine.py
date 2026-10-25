"""把外部 skill `image-to-editable-ppt`（⭐2627, MIT）的精细重建能力接入平台。

「图片转可编辑」**只有这一条路**（2026-09-21 起）：内置引擎（`pipeline._editable_worker`
的 vision_absolute 本地渲染）已按要求下线，不再回退。
  · 本模块：分钟级/页 —— 驱动第三方 CLI 的状态机
    （prepare → 逐页/并发 dispatch → page worker（Harness headless，默认）→ record → finalize），
    产物自带 validation.json（zip/关系/必需文字/资产来源全查）

实测对照（同一页，详见 skill §9.5）：文本框 14→45、文字覆盖 80%→100%、位置中位偏差 0.024→0.010。

设计要点：
  1. 平台只做**编排**，页面重建一律交给 headless agent（Harness 默认，Hermes 可选；
     其契约要求"父代理不得写页面产物"）
  2. 内容真源：有真源（slides/美化原稿）就写标准 `text_hints.json` 的 text 字段；
     没有真源时依次尝试 skill 的 PaddleOCR hints、本机 RapidOCR（离线），失败如实报错
  3. 用 skill 的 `run next --json` 驱动状态机，页面允许多个 worker 并发（默认 2，可配）
  4. 全程只读外部输入，失败如实上报（不伪造成功），失败页保留 run 目录供排查
"""
from __future__ import annotations

import json
import os
import posixpath
import re
import shlex
import shutil
import subprocess
import threading
import time
import traceback
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any, Callable, Dict, List, Optional

from . import config, db, providers

DEFAULT_CLI = os.path.expanduser("~/.editppt-venv/bin/editppt")
DEFAULT_SKILL_DIR = os.path.expanduser(
    "~/Documents/skills-repos/image-to-editable-ppt-skill/skills/image-to-editable-ppt")
# Harness（DeepSeek Harness）用户级技能目录：headless agent 从这里加载 skill。
DEFAULT_AGENTS_SKILL_DIR = os.path.expanduser("~/.agents/skills/image-to-editable-ppt")
HERMES_CANDIDATES = [
    os.path.expanduser("~/Library/Application Support/cn.org.hermesagent.desktop/runtime/desktop-bin/hermes"),
    "/usr/local/bin/hermes", "/opt/homebrew/bin/hermes",
]
# 默认用 Harness 的 headless profile 执行 page worker（2026-10-17 起），Hermes 保留为可选。
DEFAULT_AGENT = "harness"
HARNESS_CANDIDATES = [
    os.path.expanduser("~/.npm-global/bin/dsh"),
    "/opt/homebrew/bin/dsh", "/usr/local/bin/dsh",
]
PAGE_WORKER_TIMEOUT = 1200
DEFAULT_MAX_CONCURRENT_PAGES = 2     # NAS 2 核 1.9G：默认 2 路；可用设置覆盖     # 单页重建上限 20 分钟（实测约 5–13 分钟）
SETUP_TIMEOUT = 180

# 取消令牌：key = 项目 id。用户在界面上点「停止」后，正在跑的 page worker 会被终止，
# run 目录与已完成页全部保留 → 之后可以「断点续跑」。
CANCEL: Dict[str, bool] = {}


def request_cancel(key: str) -> None:
    CANCEL[key] = True


def clear_cancel(key: str) -> None:
    CANCEL.pop(key, None)


def is_cancelled(key: str) -> bool:
    return bool(CANCEL.get(key, False))


def cli_path() -> str:
    return db.setting_get("editppt.cli") or DEFAULT_CLI


def skill_dir() -> str:
    return db.setting_get("editppt.skill_dir") or DEFAULT_SKILL_DIR


def hermes_path() -> str:
    configured = db.setting_get("editppt.hermes")
    if configured:
        return configured
    for cand in HERMES_CANDIDATES:
        if os.path.exists(cand):
            return cand
    return "hermes"


def _setting(key: str, default: str = "") -> str:
    """settings 读取容错：测试/库未初始化时不让编排直接崩。"""
    try:
        return db.setting_get(key) or default
    except Exception:                                          # noqa: BLE001
        return default


def agent_kind() -> str:
    """page worker 由谁执行：`harness`（DeepSeek Harness headless，默认）或 `hermes`。"""
    value = (_setting("editppt.agent") or os.environ.get("EDITPPT_AGENT") or DEFAULT_AGENT).strip().lower()
    return value if value in ("harness", "hermes") else DEFAULT_AGENT


def harness_path() -> str:
    configured = db.setting_get("editppt.harness")
    if configured:
        return configured
    found = shutil.which("dsh")
    if found:
        return found
    for cand in HARNESS_CANDIDATES:
        if os.path.exists(cand):
            return cand
    return "dsh"


def harness_profile() -> str:
    return _setting("editppt.harness_profile") or "headless"


def agents_skill_dir() -> str:
    """Harness 从用户级技能目录加载 skill；可用设置覆盖（换机器/换安装位置）。"""
    return _setting("editppt.agents_skill_dir") or DEFAULT_AGENTS_SKILL_DIR


def page_worker_timeout() -> int:
    try:
        return max(120, int(_setting("editppt.page_timeout") or PAGE_WORKER_TIMEOUT))
    except (TypeError, ValueError):
        return PAGE_WORKER_TIMEOUT


def early_exit_seconds() -> int:
    """页面产物已通过校验且稳定 N 秒后，主动结束仍在收尾的 agent 进程（0=关闭）。"""
    try:
        value = int(_setting("editppt.early_exit_seconds") or 8)
    except (TypeError, ValueError):
        value = 8
    return max(0, min(120, value))


def max_concurrent_pages() -> int:
    """并发 page worker 数（skill 的 page_jobs.json.max_concurrent_pages 默认 6，这里按机器保守收敛）。"""
    try:
        value = int(_setting("editppt.max_concurrent_pages") or DEFAULT_MAX_CONCURRENT_PAGES)
    except (TypeError, ValueError):
        value = DEFAULT_MAX_CONCURRENT_PAGES
    return max(1, min(8, value))


DEFAULT_REMOTE_WORKDIR = "/opt/editppt-workers"
SSH_OPTS = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "-o", "StrictHostKeyChecking=accept-new"]
RSYNC_SSH = "ssh -o BatchMode=yes -o ConnectTimeout=15 -o StrictHostKeyChecking=accept-new"


def remote_workers() -> List[Dict[str, Any]]:
    """辅助 worker 机（settings `editppt.remote_workers`，JSON 数组）。

    每项：{"host": "root@192.168.110.13", "slots": 2,
           "workdir": "/opt/editppt-workers",
           "dsh": "dsh", "profile": "headless",
           "skill_dir": "/root/.agents/skills/image-to-editable-ppt",
           "editppt_cli": "/root/.editppt-venv/bin/editppt"}
    解析失败或为空 → []（单机本地兜底不受影响）。
    """
    raw = _setting("editppt.remote_workers")
    if not raw:
        return []
    try:
        items = json.loads(raw)
    except ValueError:
        return []
    out: List[Dict[str, Any]] = []
    for item in items if isinstance(items, list) else []:
        if not isinstance(item, dict) or not str(item.get("host") or "").strip():
            continue
        try:
            slots = max(1, min(8, int(item.get("slots") or 1)))
        except (TypeError, ValueError):
            slots = 1
        out.append(dict(
            host=str(item["host"]).strip(), slots=slots,
            workdir=str(item.get("workdir") or DEFAULT_REMOTE_WORKDIR),
            dsh=str(item.get("dsh") or "dsh"),
            profile=str(item.get("profile") or harness_profile()),
            skill_dir=str(item.get("skill_dir") or agents_skill_dir()),
            editppt_cli=str(item.get("editppt_cli") or "editppt"),
        ))
    return out


def worker_slots() -> List[Dict[str, Any]]:
    """本机 + 辅助机展开成派发槽位；本机在前、远端按槽位交替插入（避免只用本机）。"""
    nodes = [dict(kind="local", slots=max_concurrent_pages())]
    nodes += [dict(kind="remote", **worker) for worker in remote_workers()]
    depth = max((node["slots"] for node in nodes), default=0)
    slots: List[Dict[str, Any]] = []
    for index in range(depth):
        for node in nodes:
            if index < node["slots"]:
                slots.append(node)
    return slots


def ocr_mode() -> str:
    """无文字真源时的 OCR 兜底：auto（默认，RapidOCR）| off | rapidocr。"""
    value = (_setting("editppt.ocr") or os.environ.get("EDITPPT_OCR") or "auto").strip().lower()
    return value if value in ("auto", "off", "rapidocr") else "auto"


def ocr_python() -> str:
    """OCR 适配器跑在 editppt 的 venv 里（那边有 numpy/PIL，且可装 RapidOCR）。"""
    return os.path.join(os.path.dirname(cli_path()), "python3")


STATE_LOCK = threading.Lock()       # page_jobs.json 的读改写必须串行


def _env() -> Dict[str, str]:
    env = dict(os.environ)
    env["PATH"] = os.path.dirname(cli_path()) + os.pathsep + env.get("PATH", "")
    env.setdefault("PYTHONIOENCODING", "utf-8")
    return env


def install_hint() -> str:
    """部署脚本后台自动安装 agent 链时，给「为什么还不可用」补一句人话。

    只读 `data/logs/agent-install.status`（由 tools/install_agent.sh 写），
    不改可用性判定本身：装没装好仍以三件套的实际存在为准。
    """
    path = os.path.join(config.DATA_DIR, "logs", "agent-install.status")
    try:
        with open(path, "r", encoding="utf-8") as fh:
            text = fh.read()
    except OSError:
        return ""
    if "overall=running" in text:
        return "；正在后台自动安装 agent 链（首次约 2–4 分钟，日志 data/logs/agent-install.log）"
    if "overall=partial" in text:
        return "；后台自动安装未完成，可运行 make install-agent 重试（日志 data/logs/agent-install.log）"
    return ""


def available() -> Dict[str, Any]:
    """引擎是否可用（不联网、不跑模型，只看本机装没装）。"""
    cli, skill = cli_path(), skill_dir()
    agent = agent_kind()
    hint = install_hint()
    info: Dict[str, Any] = dict(engine="editppt", cli=cli, skill_dir=skill, agent=agent)
    if not os.path.exists(cli):
        return dict(info, ok=False, reason="未安装 editppt CLI（%s）；安装方式见 skill §9.5" % cli + hint)
    if not os.path.isdir(skill):
        return dict(info, ok=False, reason="未找到 skill 目录（%s）" % skill + hint)
    if not os.path.exists(os.path.join(skill, "SKILL.md")):
        return dict(info, ok=False, reason="skill 目录缺少 SKILL.md（%s）" % skill)
    if agent == "harness":
        harness = harness_path()
        harness_ok = bool(os.path.exists(harness) or shutil.which(harness))
        info.update(harness=harness, harness_profile=harness_profile(), agents_skill_dir=agents_skill_dir())
        if not harness_ok:
            return dict(info, ok=False, reason="未找到 DeepSeek Harness CLI（dsh，无法派 page worker）：%s" % harness)
        discoverable = agents_skill_dir()
        if not os.path.exists(os.path.join(discoverable, "SKILL.md")):
            return dict(info, ok=False, reason="Harness 技能目录里没有 image-to-editable-ppt（%s）；"
                                              "把 skill 放到 ~/.agents/skills/ 后重试" % discoverable)
        return dict(info, ok=True, reason="可用（Harness headless 执行 page worker）")
    hermes = hermes_path()
    info["hermes"] = hermes
    if not (os.path.exists(hermes) or shutil.which("hermes")):
        return dict(info, ok=False, reason="未找到 hermes CLI（无法派 page worker）")
    return dict(info, ok=True, reason="可用（Hermes 执行 page worker）")


def _run(args: List[str], cwd: Optional[str] = None, timeout: int = SETUP_TIMEOUT) -> Dict[str, Any]:
    try:
        proc = subprocess.run([cli_path()] + args, cwd=cwd, env=_env(), timeout=timeout,
                              capture_output=True, text=True)
        return dict(ok=proc.returncode == 0, code=proc.returncode,
                    out=(proc.stdout or "")[-4000:], err=(proc.stderr or "")[-2000:])
    except subprocess.TimeoutExpired:
        return dict(ok=False, code=-1, out="", err="超时（%s 秒）" % timeout)
    except OSError as exc:
        return dict(ok=False, code=-1, out="", err="%s: %s" % (type(exc).__name__, exc))


def build_hints(blocks: List[Dict[str, Any]], ink_lines: List[Dict[str, Any]],
                img_w: int, img_h: int) -> Dict[str, Any]:
    """把「我们的视觉文字」+「它的墨迹几何/字号分组」合成 page worker 可用的提示。

    文字一律来自识别结果（不改写、不补位）；几何优先用墨迹测量，缺失才用归一化坐标换算；
    size_group 取自墨迹测量的分组（同级文字字号应当一致）。
    """
    groups = {}
    for line in ink_lines or []:
        box = line.get("box_px") or []
        if len(box) == 4:
            groups[tuple(round(v) for v in box)] = line.get("size_group")

    def nearest_group(box: List[int]) -> Optional[str]:
        if not groups:
            return None
        cx, cy = box[0] + box[2] / 2.0, box[1] + box[3] / 2.0
        best, best_d = None, 1e18
        for (gx, gy, gw, gh), grp in groups.items():
            dx, dy = cx - (gx + gw / 2.0), cy - (gy + gh / 2.0)
            d = dx * dx + dy * dy
            if d < best_d:
                best, best_d = grp, d
        return best if best_d <= (img_w * 0.06) ** 2 else None      # 距离过远就不硬套

    lines = []
    for b in blocks or []:
        box = [round(b["x"] * img_w), round(b["y"] * img_h), round(b["w"] * img_w), round(b["h"] * img_h)]
        ink_box = _match_ink_box(box, groups)
        pt = b.get("font_size_pt") or 0
        lines.append(dict(text=b["text"], role=b.get("role") or "body",
                          box_px=[round(v) for v in ink_box] if ink_box else box,
                          font_pt=pt, font_pt_if_cjk=pt, font_pt_if_latin=pt,
                          size_group=nearest_group(box)))
    # 直接写 skill 的标准 text_hints.json（它只认这个文件；旧 hermes_text_hints.json 已废弃）
    return dict(schema_version=1, backend="slidecraft-vision",
                source=dict(width_px=img_w, height_px=img_h),
                provider="slidecraft-vision（等价于 PaddleOCR-VL 的内容感知提示）",
                note="文字内容必须与本文件一致，不得改写/编造；box_px 为源图像素；"
                     "同级 size_group 的文本请使用同一字号。",
                lines=lines)


def _match_ink_box(box: List[int], groups: Dict[tuple, Any]) -> Optional[List[int]]:
    """给视觉框找最近的一条墨迹测量框（中心距 < 框高的一半才算同一行）。"""
    if not groups:
        return None
    cx, cy = box[0] + box[2] / 2.0, box[1] + box[3] / 2.0
    best, best_d = None, 1e18
    for (gx, gy, gw, gh) in groups:
        dx, dy = cx - (gx + gw / 2.0), cy - (gy + gh / 2.0)
        d = dx * dx + dy * dy
        if d < best_d:
            best, best_d = [gx, gy, gw, gh], d
    return best if best_d <= (max(24, box[3]) * 1.2) ** 2 else None


def _page_dirs(run_dir: str) -> List[str]:
    """页面目录的**绝对路径**，按 page_NNN 排序。

    注意：`os.listdir` 给的是目录名，必须 join 回父目录——只返回名字会让上层拼出相对路径，
    在服务进程里（CWD 与 run 目录无关）直接 FileNotFoundError。2026-09-21 实际踩过。
    """
    pages = os.path.join(run_dir, "pages")
    if not os.path.isdir(pages):
        return []
    return sorted(os.path.join(pages, d) for d in os.listdir(pages) if d.startswith("page_"))


def _page_status(run_dir: str, page_id: str) -> str:
    """读它状态机里某页的状态（page_jobs.json）。读不到就返回空串。"""
    try:
        jobs = json.load(open(os.path.join(run_dir, "page_jobs.json"), encoding="utf-8"))
    except (OSError, ValueError):
        return ""
    for page in jobs.get("pages") or []:
        if page.get("page_id") == page_id:
            return str(page.get("status") or "")
    return ""


def _page_recorded(run_dir: str, page_id: str) -> bool:
    """该页是否已通过校验并被 record（断点续跑时跳过它）。"""
    return _page_status(run_dir, page_id) in ("recorded", "accepted", "complete")


def _stored_page_nos(run_dir: str) -> List[int]:
    """读现场记录的页清单（prepare 时写入）。读不到就返回空列表。"""
    if not run_dir:
        return []
    try:
        data = json.load(open(os.path.join(run_dir, "deckforge_pages.json"), encoding="utf-8"))
        return [int(x) for x in data] if isinstance(data, list) else []
    except (OSError, ValueError, TypeError):
        return []


def run_status(project_id: str) -> Dict[str, Any]:
    """高精度转换的现场状态（给界面看）：已记录/总页数、每页状态、是否可续跑。"""
    run = _latest_incomplete_run(project_id) or _latest_run(project_id)
    if not run:
        return dict(has_run=False, resumable=False, recorded=0, total=0, pages=[], page_nos=[],
                    note="还没有高精度转换记录")
    pages: List[Dict[str, Any]] = []
    try:
        jobs = json.load(open(os.path.join(run, "page_jobs.json"), encoding="utf-8"))
        for p in jobs.get("pages") or []:
            pages.append(dict(page_id=p.get("page_id"), status=p.get("status")))
    except (OSError, ValueError):
        pass
    done = [p for p in pages if p["status"] in ("recorded", "accepted", "complete")]
    if pages and len(done) == len(pages):
        note = "已全部完成，可重新转换以组装 deck"
    elif 0 < len(done) < len(pages):
        note = "可继续上次进度（已完成 %d/%d 页）" % (len(done), len(pages))
    elif pages and len(done) == 0:
        note = "上次转换没跑完（已完成 0/%d 页），可继续转换重试" % len(pages)
    else:
        note = ""
    return dict(has_run=True, run_dir=run, run_name=os.path.basename(run), pages=pages,
                page_nos=_stored_page_nos(run), recorded=len(done), total=len(pages),
                resumable=bool(pages) and len(done) < len(pages),
                cancelled=is_cancelled(project_id), note=note)


def _run_roots(project_id: str) -> List[str]:
    """该项目的 run 目录，按目录 mtime 升序。

    run 目录名是 `p_xxx-run_<随机 uid>`，**不能按名字排序**（随机串的字典序和时间无关），
    否则「最近一次 run」可能选中更早的那份现场（实测会导致续跑接到旧 run 上）。
    """
    root = os.path.join(config.FILES_DIR, "editppt")
    if not os.path.isdir(root):
        return []
    paths = [os.path.join(root, d) for d in os.listdir(root) if d.startswith(project_id + "-")]
    return sorted(paths, key=lambda p: os.path.getmtime(p))


def _latest_run(project_id: str) -> str:
    """该项目最近一次的 run 目录（不分是否完成）。"""
    paths = _run_roots(project_id)
    if not paths:
        return ""
    base = paths[-1]
    return _latest_run_dir(base) or base


def _latest_incomplete_run(project_id: str) -> str:
    """找该项目最近一次「未全部完成」的 run 目录（供断点续跑）。

    run 目录名形如 `p_xxx-run_<随机 uid>`，其下还有 prepare 自建的一层；按 mtime 取最新一层。
    0 页完成的 run 也算未完成：服务重启会杀死 page worker，此时已 prepare 的现场
    （页图/文字真源）仍可复用，续跑只需把 dispatched 页重置后重新派发。
    """
    for base in reversed(_run_roots(project_id)):
        run = _latest_run_dir(base) or base
        jobs_path = os.path.join(run, "page_jobs.json")
        if not os.path.exists(jobs_path):
            continue
        try:
            jobs = json.load(open(jobs_path, encoding="utf-8"))
        except (OSError, ValueError):
            continue
        done = [p for p in jobs.get("pages") or [] if p.get("status") in ("recorded", "accepted", "complete")]
        total = len(jobs.get("pages") or [])
        if 0 < total and len(done) < total:                    # 有页没完成（含 0 页完成的中断现场）→ 可续跑
            return run
    return ""


def _log_page_error(page_dir: str, stage: str, exc: BaseException) -> None:
    """把逐页失败写进现场（生产上排查靠它，别只留一句人话）。"""
    try:
        with open(os.path.join(page_dir, "engine_error_%s.log" % stage), "w", encoding="utf-8") as fh:
            fh.write("%s: %s\n\n" % (type(exc).__name__, exc))
            traceback.print_exc(file=fh)
    except OSError:
        pass


def _validation_passed(page_dir: str, retries: int = 3, wait: float = 4.0) -> Dict[str, Any]:
    """读 validation.json 判断该页是否通过校验 —— **必须带重试**。

    2026-09-21 实测踩到：page worker 是 agent，它可能在退出前后仍在写这个文件；平台在
    worker 进程刚退出的那一瞬读到的还是旧的 `passed=false`，据此把整单判 failed
    （真实现场：几秒后文件已变成 `passed=true`，但作业已经报「N/M 页未通过校验」）。
    所以一次读到的结果不能定生死：未通过就等几秒再读，最多 retries 次。
    """
    last: Dict[str, Any] = dict(passed=False, reason="未生成 validation.json")
    for attempt in range(max(1, retries)):
        path = os.path.join(page_dir, "validation.json")
        if os.path.exists(path):
            try:
                data = json.load(open(path, encoding="utf-8"))
                if isinstance(data, dict):
                    last = data
                    if data.get("passed"):
                        return data
                else:
                    last = dict(passed=False, reason="validation.json 结构异常")
            except (OSError, ValueError) as exc:
                last = dict(passed=False, reason="validation.json 读取失败：%s" % exc)
        if attempt < retries - 1:
            time.sleep(wait)
    return last


def _worker_prompt(run_dir: str, page_id: str, page_dir: str) -> str:
    """给 page worker 的包装提示。

    skill 自己的 `worker-prompt.md` 是页面工作指令；这里补三件它不知道的事：
    ① Harness 下必须先加载 skill；② 本平台的**文字真源**文件；③ 平台负责 record/finalize。
    """
    truth_path = os.path.join(page_dir, "truth_text.txt")
    hints_path = os.path.join(page_dir, "text_hints.json")
    hints_have_text = False
    if os.path.exists(hints_path):
        try:
            hints = json.load(open(hints_path, encoding="utf-8"))
            hints_have_text = any((line.get("text") or "").strip() for line in hints.get("lines") or [])
        except (OSError, ValueError):
            hints_have_text = False
    if os.path.exists(truth_path):
        truth = ("%s —— **本页文字真源（逐字采用）**：页面上的可编辑文字必须与它完全一致，"
                 "不得改写、不得编造、不得增删；`text_hints.json` 只用于几何/字号，文字以本文件为准。\n"
                 % truth_path)
    elif hints_have_text:
        truth = ("%s —— **本页文字真源（逐字采用）**：`lines[].text` 必须原样出现在页面上，"
                 "不得改写、不得编造、不得增删；`box_px` 为源图像素，`font_pt_if_cjk/font_pt_if_latin` "
                 "为字号，同级 `size_group` 必须用同一字号；hints 漏掉的行按源图补齐。\n" % hints_path)
    else:
        truth = ("本页没有文字真源文件（OCR 未配置或失败）：hints 只有几何，请按源图逐字读取文字，"
                 "不得编造；完成后在返回里说明文字来源。\n")
    load = ""
    if agent_kind() == "harness":
        load = ("0. 先用 `skill` 工具加载 **image-to-editable-ppt**（加载 SKILL.md 即可），"
                "再按 skill 的阅读路由只读本页需要的章节，**不要通读全部 references**。\n\n")
    return (
        "你正在执行 image-to-editable-ppt skill 的 **page worker（单页重建）** 任务，请严格按该 skill 执行。\n\n"
        + load +
        "1. 页面工作指令（必读，按需读）：%s/worker-prompt.md\n"
        "2. 参考文件（按 page-decision-tree 的阅读路由只读相关章节；文件较大时用 read 的 offset/limit 或 grep 定位，"
        "不要整份通读、不要重复读）：%s/references/manifest-schema.md、page-decision-tree.md、cli-helper.md\n"
        "3. 内容真源（重要）：%s"
        "3.5 元素拆分按 skill 的 page-decision-tree 执行：文字→原生文本框；照片/插画/图标/logo→资产表分离透明 PNG；"
        "卡片/线条/箭头/表格→原生形状/表格；背景→native 或 imagegen clean base；manifest 必写 "
        "visual_inventory、background_strategy、asset_provenance、quality_checks；**禁止把整页 source.png 当底图**。\n"
        "4. 交付物：%s/manifest.json，然后 `editppt page build %s`，再 `editppt page validate %s` 通过；"
        "**不要执行 run record / run finalize**（平台负责）。\n"
        "5. token 预算纪律（硬要求，务必遵守）：\n"
        "   - 每个文件只读一次；已读过的不要重复 read/cat/grep。\n"
        "   - 优先用 read(offset/limit)/grep 定位，不要用 bash cat/wc/ls 反复查看文件。\n"
        "   - 独立工具调用尽量放在同一回合并行发出；不要启动后台任务或子代理。\n"
        "   - manifest 写好后只 build 一次、validate 一次；只有 validate 报错才针对错误字段修复，禁止整页重写/重复验证。\n"
        "   - 不要读与当前页无关的文件；不要为了「确认」重复执行同一命令。\n"
        "6. 完成后用一两句话说明 validate 结果即可。\n"
        % (page_dir, skill_dir(), truth, page_dir, page_dir, page_dir))


def _page_outputs_stamp(page_dir: str) -> tuple:
    files = ("manifest.json", "page_result.json", "validation.json", "page.pptx", "preview.png")
    return tuple((name, os.path.getmtime(os.path.join(page_dir, name)))
                 for name in files if os.path.isfile(os.path.join(page_dir, name)))


def _ssh_run(node: Dict[str, Any], script: str, timeout: int = 120) -> Dict[str, Any]:
    """在辅助机执行一段 bash（脚本走 stdin，避免引号转义地狱）。"""
    try:
        proc = subprocess.run(["ssh"] + SSH_OPTS + [node["host"], "bash", "-s"],
                              input=script, capture_output=True, text=True, timeout=timeout)
        return dict(ok=proc.returncode == 0, out=(proc.stdout or "")[-2000:], err=(proc.stderr or "")[-2000:])
    except (OSError, subprocess.TimeoutExpired) as exc:
        return dict(ok=False, out="", err="%s: %s" % (type(exc).__name__, exc))


def _rsync_run(args: List[str], timeout: int = 900) -> Dict[str, Any]:
    try:
        proc = subprocess.run(["rsync", "-a"] + args, capture_output=True, text=True, timeout=timeout)
        return dict(ok=proc.returncode == 0, out=(proc.stdout or "")[-1000:], err=(proc.stderr or "")[-1000:])
    except (OSError, subprocess.TimeoutExpired) as exc:
        return dict(ok=False, out="", err="%s: %s" % (type(exc).__name__, exc))


def _remote_run_base(node: Dict[str, Any], run_dir: str) -> str:
    run_dir = run_dir.rstrip("/")
    return posixpath.join(node["workdir"], os.path.basename(os.path.dirname(run_dir)), os.path.basename(run_dir))


def _remote_page_dir(node: Dict[str, Any], run_dir: str, page_dir: str) -> str:
    return posixpath.join(_remote_run_base(node, run_dir), "pages", os.path.basename(page_dir.rstrip("/")))


def _rewrite_remote_prompt(text: str, run_dir: str, page_dir: str, remote_page: str,
                           node: Dict[str, Any]) -> str:
    """把 worker prompt 里的本机绝对路径改写成辅助机路径（普通字符串替换，路径都是真实存在的前缀）。"""
    remote_run = posixpath.dirname(posixpath.dirname(remote_page))
    text = text.replace(page_dir.rstrip("/"), remote_page)
    text = text.replace(run_dir.rstrip("/"), remote_run)
    for local_skill in (skill_dir(), agents_skill_dir()):
        if local_skill:
            text = text.replace(local_skill.rstrip("/"), node["skill_dir"])
    return text


def _rewrite_pulled_paths(page_dir: str, remote_page: str) -> None:
    """远端产物常带绝对路径（manifest 里的字体/资产、validation 里的 pptx）→ 回收后改回本机路径。"""
    local = page_dir.rstrip("/")
    for name in ("manifest.json", "validation.json", "page_result.json", "imagegen-jobs.json"):
        path = os.path.join(page_dir, name)
        if not os.path.isfile(path):
            continue
        try:
            text = open(path, encoding="utf-8").read()
        except OSError:
            continue
        if remote_page in text:
            try:
                open(path, "w", encoding="utf-8").write(text.replace(remote_page, local))
            except OSError:
                pass


def _pull_remote_page(node: Dict[str, Any], remote_page: str, page_dir: str) -> Dict[str, Any]:
    return _rsync_run(["-e", RSYNC_SSH,
                       "--exclude", "worker-prompt.md",
                       "--exclude", "platform-prompt.txt",
                       "--exclude", "source.png",
                       "--exclude", "text_hints.png",
                       "--exclude", "agent.log",
                       "%s:%s/" % (node["host"], remote_page), page_dir.rstrip("/") + "/"])


def _remote_agent_tail(node: Dict[str, Any], remote_page: str) -> str:
    res = _ssh_run(node, "tail -n 30 %s 2>/dev/null || true\n"
                   % shlex.quote(posixpath.join(remote_page, "agent.log")), timeout=30)
    return (res.get("out") or "")[-1500:]


def _remote_state(node: Dict[str, Any], remote_page: str, pid: int) -> Dict[str, Any]:
    """一次 ssh 查两件事：进程还活着吗 / page_result.json 的 mtime（用于提前收尾）。"""
    script = ("if kill -0 %d 2>/dev/null; then echo ALIVE; else echo DEAD; fi\n"
              "stat -c %%Y %s 2>/dev/null || echo -\n"
              % (pid, shlex.quote(posixpath.join(remote_page, "page_result.json"))))
    res = _ssh_run(node, script, timeout=30)
    lines = (res.get("out") or "").strip().splitlines()
    alive = bool(lines) and lines[0].strip() == "ALIVE"
    mtime = 0
    if len(lines) > 1:
        try:
            mtime = int(lines[1].strip())
        except ValueError:
            mtime = 0
    return dict(ok=res["ok"], alive=alive, mtime=mtime)


def _run_remote_page_worker(node: Dict[str, Any], page_dir: str, page_id: str,
                            cancel_key: str = "") -> Dict[str, Any]:
    """在辅助机上跑一个 headless page worker：同步页面目录 → 远端 dsh → 回收产物。

    远端只负责「重建这一页」；校验/record/finalize 仍全部在本机完成。
    远端 agent 用 setsid 脱离 ssh 会话跑（输出写 agent.log），本机轮询进程/产物：
    - 产物稳定 early_exit_seconds 后提前收尾（与本地一致）
    - 超时/取消时杀远端进程；超时也回收已有产物（record 仍会做权威校验）
    """
    run_dir = os.path.dirname(os.path.dirname(page_dir))
    remote_page = _remote_page_dir(node, run_dir, page_dir)
    started = time.time()
    prep = _ssh_run(node, "mkdir -p %s\n" % shlex.quote(remote_page))
    if not prep["ok"]:
        return dict(ok=False, tail="远端目录创建失败：%s" % prep["err"])
    # 注意：这里必须用**平台包装提示**（_worker_prompt），不能直接跑 skill 的 worker-prompt.md——
    # 否则远端会丢掉「先加载 skill / 文字真源 / token 纪律」这些平台约束（实测远端页 token 会高 3–6 倍）。
    try:
        text = _worker_prompt(run_dir, page_id, page_dir)
    except Exception as exc:                                # noqa: BLE001
        return dict(ok=False, tail="生成 worker prompt 失败：%s: %s" % (type(exc).__name__, exc))
    tmp_prompt = os.path.join(page_dir, ".platform-prompt.remote.md")
    with open(tmp_prompt, "w", encoding="utf-8") as target:
        target.write(_rewrite_remote_prompt(text, run_dir, page_dir, remote_page, node))
    try:
        push = _rsync_run(["-e", RSYNC_SSH, page_dir.rstrip("/") + "/",
                           "%s:%s/" % (node["host"], remote_page)])
    finally:
        try:
            os.unlink(tmp_prompt)
        except OSError:
            pass
    if not push["ok"]:
        return dict(ok=False, tail="页面目录同步到远端失败：%s" % push["err"])
    rename = _ssh_run(node, "mv %s %s\n" % (
        shlex.quote(posixpath.join(remote_page, ".platform-prompt.remote.md")),
        shlex.quote(posixpath.join(remote_page, "platform-prompt.txt"))))
    if not rename["ok"]:
        return dict(ok=False, tail="远端平台提示改名失败：%s" % rename["err"])

    cli_dir = posixpath.dirname(node["editppt_cli"])
    script = (
        "set -e\n"
        "export PATH=%s:$PATH\n"
        "cd %s\n"
        "rm -f agent.log\n"
        "setsid nohup %s --profile %s \"$(cat platform-prompt.txt)\" > agent.log 2>&1 < /dev/null &\n"
        "echo $!\n"
        % (shlex.quote(cli_dir), shlex.quote(remote_page),
           shlex.quote(node["dsh"]), shlex.quote(node["profile"])))
    start = _ssh_run(node, script, timeout=30)
    try:
        pid = int((start.get("out") or "").strip().splitlines()[-1])
    except (ValueError, IndexError):
        return dict(ok=False, tail="远端 worker 启动失败：%s" % (start.get("out") or start.get("err")))

    def kill_remote() -> None:
        _ssh_run(node, "pkill -f %s || true\n" % shlex.quote(remote_page), timeout=20)

    timeout = page_worker_timeout()
    early = early_exit_seconds()
    stable_mtime = 0
    stable_since: Optional[float] = None
    cancelled = False
    timed_out = False
    probe_failures = 0
    while True:
        if cancel_key and is_cancelled(cancel_key):
            cancelled = True
            kill_remote()
            break
        if time.time() - started > timeout:
            timed_out = True
            kill_remote()
            break
        state = _remote_state(node, remote_page, pid)
        if not state["ok"]:
            probe_failures += 1
            if probe_failures >= 5:                      # ssh 连续失败：不再等满超时
                kill_remote()
                break
        else:
            probe_failures = 0
            if not state["alive"]:
                break
            if early and state["mtime"]:
                if state["mtime"] != stable_mtime:
                    stable_mtime, stable_since = state["mtime"], time.time()
                elif stable_since is not None and time.time() - stable_since >= early:
                    kill_remote()
                    break
        time.sleep(3)

    tail = _remote_agent_tail(node, remote_page)
    if cancelled:
        return dict(ok=False, cancelled=True, tail=tail or "已按用户要求停止（远端现场保留）")
    pull = _pull_remote_page(node, remote_page, page_dir)
    if not pull["ok"]:
        return dict(ok=False, tail="远端产物回收失败：%s（远端目录 %s 保留）" % (pull["err"], remote_page))
    _rewrite_pulled_paths(page_dir, remote_page)
    try:
        json.dump(dict(host=node["host"], remote_dir=remote_page,
                       seconds=round(time.time() - started, 1)),
                  open(os.path.join(page_dir, "worker_node.json"), "w"), ensure_ascii=False)
    except OSError:
        pass
    if timed_out:
        try:
            open(os.path.join(page_dir, "remote_worker_error.txt"), "w", encoding="utf-8").write(tail)
        except OSError:
            pass
        return dict(ok=False, tail="远端 page worker 超时（%d 秒）；已回收现有产物" % timeout)
    ok = os.path.isfile(os.path.join(page_dir, "page_result.json"))
    return dict(ok=ok, tail=tail or "远端 page worker 完成")


def _run_page_worker(page_dir: str, page_id: str, cancel_key: str = "",
                     node: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """派一个 headless agent 当 page worker 重建这一页（默认 DeepSeek Harness，可选 Hermes）。

    用 Popen + 轮询（而不是 `subprocess.run`）是为了能**中途取消**：用户点「停止」后
    最多 1 秒内终止子进程，现场（已完成页 + 该页状态）全部保留，便于断点续跑。
    `node` 为 `worker_slots()` 里的槽位：kind=remote 时走辅助机（同步页面目录 → 远端 dsh → 回收）。
    """
    if node and node.get("kind") == "remote":
        return _run_remote_page_worker(node, page_dir, page_id, cancel_key)
    run_dir = os.path.dirname(os.path.dirname(page_dir))
    prompt = _worker_prompt(run_dir, page_id, page_dir)
    agent = agent_kind()
    if agent == "harness":
        # cwd 决定 headless agent 的 workspace（workspace-write 只允许写 run 目录），
        # 页面产物都在 run_dir/pages/page_NNN/ 下，正好在可写范围内。
        cmd = [harness_path(), "--profile", harness_profile(), prompt]
        cwd: Optional[str] = run_dir
    else:
        cmd = [hermes_path(), "-z", prompt, "--skills", "image-to-editable-ppt", "--yolo"]
        cwd = None
    started = time.time()
    try:
        proc = subprocess.Popen(cmd, env=_env(), cwd=cwd, stdout=subprocess.PIPE,
                                stderr=subprocess.STDOUT, text=True)
    except OSError as exc:
        return dict(ok=False, tail="%s: %s" % (type(exc).__name__, exc))
    timeout = page_worker_timeout()
    early = early_exit_seconds()
    stable_since = None
    stable_stamp = None
    try:
        while proc.poll() is None:
            if cancel_key and is_cancelled(cancel_key):
                proc.terminate()
                try:
                    proc.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    proc.kill()
                return dict(ok=False, cancelled=True, tail="已按用户要求停止（现场保留，可继续）")
            if time.time() - started > timeout:
                proc.terminate()
                try:
                    proc.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    proc.kill()
                return dict(ok=False, tail="page worker 超时（%d 秒）" % timeout)
            # agent 已把产物写完且校验通过，但仍在生成收尾消息：稳定 N 秒就主动结束
            if early and os.path.isfile(os.path.join(page_dir, "page_result.json")):
                stamp = _page_outputs_stamp(page_dir)
                if stamp != stable_stamp:
                    stable_stamp, stable_since = stamp, time.time()
                elif stable_since is not None and time.time() - stable_since >= early:
                    proc.terminate()
                    try:
                        proc.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        proc.kill()
                    return dict(ok=True, tail="early-exit：产物与校验已稳定 %d 秒，主动结束收尾进程" % early)
            time.sleep(1)
        out = proc.stdout.read() if proc.stdout else ""
        tail = (out or "")[-1500:]
        return dict(ok=proc.returncode == 0, tail=tail or ("page worker 退出码 %s" % proc.returncode))
    finally:
        if proc.poll() is None:
            proc.kill()


def convert(project_id: str, page_nos: List[int],
            on_event: Optional[Callable[[Dict[str, Any]], None]] = None,
            resume: bool = False, resume_run_dir: str = "", cancel_key: str = "",
            source_rows: Optional[List[Dict[str, Any]]] = None) -> Dict[str, Any]:
    """把项目的指定页（必须是已渲染出页面图的页）用第三方引擎转成可编辑 deck。

    返回 dict(ok, deck, run_dir, pages, failures, note)。**同步阻塞**，调用方负责放到线程里。
    """
    def notify(**kw) -> None:
        if on_event:
            try:
                on_event(kw)
            except Exception:                                  # noqa: BLE001 —— 进度回调不能影响主流程
                pass

    state = available()
    if not state.get("ok"):
        return dict(ok=False, error=state.get("reason"), run_dir="")

    # 续跑时**以现场记录的页清单为准**：run 里的 page_001..N 是按 prepare 时的顺序映射的，
    # 若调用方这次勾选的页不同，index 对不上就会张冠李戴。
    stored = _stored_page_nos(resume_run_dir or _latest_incomplete_run(project_id)) if (
        resume or resume_run_dir) else []
    if stored:
        page_nos = stored

    rows = [dict(r) for r in db.q(
        "SELECT * FROM slides WHERE project_id=? AND page_no IN (%s) ORDER BY page_no"
        % ",".join("?" * len(page_nos)), (project_id, *page_nos))] if page_nos else []
    if source_rows is not None and not resume:
        rows = [dict(r) for r in source_rows]
    if not rows:
        return dict(ok=False, error="没有找到要转换的页面", run_dir="")

    resume_dir = resume_run_dir or (_latest_incomplete_run(project_id) if resume else '')
    manifest = os.path.join(resume_dir, 'deckforge_snapshot.json')
    if resume_dir:
        if os.path.isfile(manifest):
            with open(manifest, encoding='utf-8') as source:
                rows = json.load(source)
    elif all(row.get('current_version_id') and row.get('id') for row in rows):
        frozen_dir = os.path.join(config.FILES_DIR, 'editppt', db.uid('input'))
        os.makedirs(frozen_dir, exist_ok=False)
        for row in rows:
            if not row.get('current_version_id'):
                return dict(ok=False, error='当前页没有版本记录，无法绑定转换', run_dir='')
            row['export_version_number'] = next((i for i, v in enumerate(db.q(
                'SELECT id FROM slide_versions WHERE slide_id=? ORDER BY rowid', (row['id'],)), 1)
                if v['id'] == row['current_version_id']), None)
            path = row.get('image_path') or ''
            if not os.path.isfile(path):
                return dict(ok=False, error='转换输入图片缺失', run_dir='')
            dest = os.path.join(frozen_dir, str(row['page_no']) + os.path.splitext(path)[1])
            shutil.copyfile(path, dest)
            row['image_path'] = dest

    images: List[str] = []
    for r in rows:
        path = r.get("image_path") or ""
        if not path or not os.path.exists(path):
            return dict(ok=False, run_dir="", error="第 %s 页没有页面图，先「图片转可编辑」导入或先生成图片版"
                        % r.get("page_no"))
        images.append(path)

    run_root = os.path.join(config.FILES_DIR, "editppt")
    os.makedirs(run_root, exist_ok=True)
    resume_dir = resume_run_dir or (_latest_incomplete_run(project_id) if resume else "")
    if resume_dir and os.path.isdir(resume_dir):
        run_dir = resume_dir                                   # 断点续跑：复用现场，不重新 prepare
        notify(stage="resume", message="继续上次未完成的转换：%s" % os.path.basename(run_dir), done=0,
               total=len(rows))
    else:
        run_dir = os.path.join(run_root, "%s-%s" % (project_id, db.uid("run")))
        notify(stage="prepare", message="准备转换任务（%d 页）" % len(images), done=0, total=len(rows))
        prep = _run(["prepare"] + images + ["--out-root", run_dir], timeout=SETUP_TIMEOUT + 120 * len(images))
        if not prep["ok"]:
            return dict(ok=False, run_dir=run_dir, error="prepare 失败：%s" % (prep["err"] or prep["out"])[-400:])
        run_dir = _latest_run_dir(run_dir) or run_dir
        try:                                                   # 记下这次转的是哪些页（续跑要按同一顺序映射）
            json.dump(list(page_nos), open(os.path.join(run_dir, "deckforge_pages.json"), "w"))
        except OSError:
            pass
    if not resume_dir and all(row.get('current_version_id') and row.get('id') for row in rows):
        with open(os.path.join(run_dir, 'deckforge_snapshot.json'), 'w', encoding='utf-8') as target:
            json.dump(rows, target, ensure_ascii=False)
    return _run_pages(project_id, run_dir, rows, notify, cancel_key)


def _status_json(run_dir: str) -> Dict[str, Any]:
    res = _run(["run", "status", run_dir, "--json"])
    try:
        return json.loads(res.get("out") or "{}")
    except ValueError:
        return {}


def _next_json(run_dir: str) -> Dict[str, Any]:
    """用 skill 自己的状态机决策下一步（run next --json），而不是我们猜。"""
    res = _run(["run", "next", run_dir, "--json"])
    try:
        payload = json.loads(res.get("out") or "{}")
    except ValueError:
        payload = {}
    if not payload:
        payload = dict(stage="error", reason=(res.get("err") or res.get("out") or "run next 输出无法解析")[-300:])
    return payload


REQUIRED_PAGE_OUTPUTS = {
    "page_manifest": "manifest.json",
    "imagegen_jobs": "imagegen-jobs.json",
    "page_pptx": "page.pptx",
    "preview": "preview.png",
    "contact_sheet": "split_assets_contact.png",
    "validation": "validation.json",
    "page_result": "page_result.json",
}


def _ensure_page_result(page_dir: str) -> bool:
    """worker 忘了写 page_result.json 时补一份纯路径清单（不改页面内容）。

    record 只靠它定位产物；所有产物齐全且 validation 已通过时，缺这一份属于
    agent 收尾遗漏。平台补写不会伪造任何页面内容，并只做路径清单。
    """
    path = os.path.join(page_dir, "page_result.json")
    if os.path.isfile(path):
        return True
    required = [name for key, name in REQUIRED_PAGE_OUTPUTS.items() if key != "page_result"]
    if not all(os.path.isfile(os.path.join(page_dir, name)) for name in required):
        return False
    try:
        json.dump({key: name for key, name in REQUIRED_PAGE_OUTPUTS.items()},
                  open(path, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
        return True
    except OSError:
        return False


def _record_page(project_id: str, run_dir: str, page_id: str, page_dir: str,
                 page_no: Any, recorded: List[Any], notify: Callable[..., None],
                 agent_tail: str, total: int = 0) -> Dict[str, Any]:
    """校验 → record（状态写入串行）→ 记账；返回 {ok,error}。"""
    check = _validation_passed(page_dir)
    if not check.get("passed"):
        return dict(ok=False, stage="rebuild",
                    error=str(check.get("reason") or check.get("errors") or "校验未通过")[:300],
                    agent_tail=agent_tail[-200:])
    if not _ensure_page_result(page_dir):
        return dict(ok=False, stage="record", error="页面产物不齐（缺 page_result.json 或其他必需文件）")
    with STATE_LOCK:
        rec = _run(["run", "record", run_dir, "--page", page_id, "--agent-id", "deckforge-%s" % page_no])
        if not rec["ok"]:                                   # worker 刚退出、页面产物还在落盘时重试一次
            time.sleep(5)
            rec = _run(["run", "record", run_dir, "--page", page_id, "--agent-id", "deckforge-%s" % page_no])
        if not rec["ok"]:
            return dict(ok=False, stage="record", error=(rec["err"] or rec["out"])[-300:])
        recorded.append(page_no)
        db.log_usage(project_id, page_no, "editable_hi", "editppt-skill", "manifest+build", "-", 0.0,
                     0, True, "第三方 skill 高精度重建（agent 逐页写 manifest）%s" % agent_tail[:80].replace("\n", " "))
    notify(stage="page_done", page=page_no, status="done",
           message="第 %s 页已重建并通过校验" % page_no, done=len(recorded), total=total)
    return dict(ok=True)


def _run_pages(project_id: str, run_dir: str, rows: List[Dict[str, Any]],
               notify: Callable[..., None], cancel_key: str = "") -> Dict[str, Any]:
    """用 skill 的 run next 状态机驱动：并发 dispatch/record → finalize → 发布产物。

    页面按 prepare 顺序与 `rows` 对齐（page_001..N）。多个 page worker 可并发；
    page_jobs.json 的读改写统一走 STATE_LOCK，worker 进程本身互不共享状态。
    """
    dirs = _page_dirs(run_dir)
    if not dirs:
        return dict(ok=False, run_dir=run_dir, error="prepare 没有生成任何页面目录")
    page_id_to_row = {os.path.basename(d): rows[i] for i, d in enumerate(dirs) if i < len(rows)}
    page_dir_by_id = {os.path.basename(d): d for d in dirs}
    pages = [r["page_no"] for r in rows]

    status = _status_json(run_dir)
    recorded: List[Any] = []
    for state_name in ("recorded", "accepted"):
        for page_id in (status.get("pages") or {}).get(state_name) or []:
            row = page_id_to_row.get(page_id)
            if row is not None:
                recorded.append(row["page_no"])
    # 上次被取消/中断留下的 dispatched 页：没有活跃 worker，先重置为 pending（现场保留）。
    # reset 对 dispatched 页要求匹配 --agent-id + --confirm-lost，否则会静默失败。
    try:
        jobs_state = json.load(open(os.path.join(run_dir, "page_jobs.json"), encoding="utf-8"))
    except (OSError, ValueError):
        jobs_state = {"pages": []}
    for item in jobs_state.get("pages") or []:
        if item.get("status") != "dispatched":
            continue
        agent_id = str((item.get("dispatch") or {}).get("agent_id") or "")
        with STATE_LOCK:
            _run(["run", "reset", run_dir, "--page", item.get("page_id"),
                  "--agent-id", agent_id, "--confirm-lost"])

    failures: List[Dict[str, Any]] = []
    cancelled = False
    slots = worker_slots()
    workers = len(slots) or 1
    notify(stage="prepare", message="已就绪：%d 页（并发 %d）" % (len(dirs), workers),
           done=len(recorded), total=len(dirs))

    while True:
        if cancel_key and is_cancelled(cancel_key):
            cancelled = True
            break
        nxt = _next_json(run_dir)
        stage = nxt.get("stage")
        if stage == "finalize":
            break
        if stage == "configure_backend":
            with STATE_LOCK:
                _run(["run", "backend", run_dir])
            continue
        if stage not in ("dispatch_pages", "rebuild_page_locally"):
            if stage == "wait":
                failures.append(dict(stage="wait",
                                     error="仍有未完成页面（可能被其它进程占用）：%s"
                                           % (nxt.get("active_or_unfinished_pages") or "")))
            else:
                failures.append(dict(stage=stage or "unknown",
                                     error=str(nxt.get("reason") or nxt)[:300]))
            break

        selected = [p for p in (nxt.get("suggested_pages") or []) if p in page_id_to_row][:workers]
        batch: List[tuple] = []
        for index, page_id in enumerate(selected):
            node = slots[index] if index < len(slots) else dict(kind="local")
            if cancel_key and is_cancelled(cancel_key):
                cancelled = True
                break
            page_dir = page_dir_by_id[page_id]
            row = page_id_to_row[page_id]
            page_no = row.get("page_no")
            notify(stage="page", page=page_no, status="running",
                   message="正在重建第 %s 页（并发 %d，已完成 %d/%d）"
                           % (page_no, workers, len(recorded), len(dirs)),
                   done=len(recorded), total=len(dirs))
            try:
                _prepare_page(run_dir, page_dir, row, notify)
            except Exception as exc:                        # noqa: BLE001
                _log_page_error(page_dir, "hints", exc)
                failures.append(dict(page_no=page_no, stage="hints",
                                     error="%s: %s" % (type(exc).__name__, exc)))
                notify(stage="page_failed", page=page_no, status="failed",
                       message="第 %s 页无法获取文字真源：%s" % (page_no, exc), done=len(recorded), total=len(dirs))
                continue
            with STATE_LOCK:
                disp = _run(["run", "dispatch", run_dir, "--page", page_id,
                             "--agent-id", "deckforge-%s" % page_no,
                             "--prompt-file", os.path.join(page_dir, "worker-prompt.md")])
            if not disp["ok"]:
                failures.append(dict(page_no=page_no, stage="dispatch",
                                     error=(disp["err"] or disp["out"])[-300:]))
                notify(stage="page_failed", page=page_no, status="failed",
                       message="第 %s 页派发失败" % page_no, done=len(recorded), total=len(dirs))
                continue
            batch.append((page_id, page_dir, row, node))
        if cancelled:
            break
        if not batch:
            failures.append(dict(stage="dispatch", error="没有可派发的页面"))
            break

        def run_one(item: tuple) -> tuple:
            page_id, page_dir, row, node = item
            result = _run_page_worker(page_dir, page_id, cancel_key or "", node)
            # 辅助机不可用/失败时回退本机重试一次（远端没留下可校验产物才回退，避免重复跑已有产物的页）
            if (node and node.get("kind") == "remote" and not result.get("ok")
                    and not result.get("cancelled")
                    and not os.path.isfile(os.path.join(page_dir, "page_result.json"))):
                result = _run_page_worker(page_dir, page_id, cancel_key or "", dict(kind="local"))
                result["tail"] = "[远端失败已回退本机] " + str(result.get("tail") or "")
            return page_id, page_dir, row, result

        with ThreadPoolExecutor(max_workers=min(len(batch), workers)) as pool:
            futures = [pool.submit(run_one, item) for item in batch]
            for future in as_completed(futures):
                page_id, page_dir, row, agent = future.result()
                page_no = row.get("page_no")
                if agent.get("cancelled"):
                    cancelled = True
                    failures.append(dict(page_no=page_no, stage="cancelled",
                                         error="已停止（现场保留，可继续）"))
                    continue
                result = _record_page(project_id, run_dir, page_id, page_dir, page_no,
                                      recorded, notify, agent.get("tail") or "", total=len(dirs))
                if not result.get("ok"):
                    failures.append(dict(page_no=page_no, stage=result.get("stage"),
                                         error=result.get("error"),
                                         agent_tail=result.get("agent_tail") or ""))
                    notify(stage="page_failed", page=page_no, status="failed",
                           message="第 %s 页失败：%s" % (page_no, result.get("error")),
                           done=len(recorded), total=len(dirs))
        if cancelled:
            break

    # 失败/取消**不再一票否决**：已完成并记录的页保住，如实报出剩余页，可继续（断点续跑）
    if cancelled:                                              # 用户主动停止：保留现场，不当失败处理
        return dict(ok=False, cancelled=True, run_dir=run_dir, pages=pages,
                    recorded=recorded, failures=failures, partial=True,
                    error="已停止：已完成 %d/%d 页（现场保留，可点「继续转换」接着跑）" % (len(recorded), len(dirs)))
    if len(recorded) < len(dirs):
        return dict(ok=False, partial=True, run_dir=run_dir, pages=pages,
                    recorded=recorded, failures=failures,
                    error="%d/%d 页未通过校验（已完成 %d 页已保留现场，可点「继续转换」重试剩余页）：%s"
                          % (len(dirs) - len(recorded), len(dirs), len(recorded), run_dir))
    if cancel_key and is_cancelled(cancel_key):                # 全部记录的临界点被取消
        return dict(ok=False, cancelled=True, run_dir=run_dir, pages=pages, recorded=recorded,
                    failures=failures, partial=True,
                    error="已停止（所有页已完成，可直接重新转换以组装 deck）")

    notify(stage="finalize", message="组装最终 deck", done=len(dirs), total=len(dirs))
    with STATE_LOCK:
        fin = _run(["run", "finalize", run_dir], timeout=SETUP_TIMEOUT)
    if not fin["ok"]:
        return dict(ok=False, run_dir=run_dir, pages=pages,
                    failures=[dict(stage="finalize", error=fin["err"][-300:])],
                    error="finalize 失败：%s" % (fin["err"] or fin["out"])[-300:])
    decks = [os.path.join(run_dir, "final", f) for f in sorted(os.listdir(os.path.join(run_dir, "final")))
             if f.endswith(".pptx")]
    if not decks:
        return dict(ok=False, run_dir=run_dir, pages=pages, error="finalize 未产出 pptx")
    # 产物**发布到 exports/**，而不是留在 run 工作目录里：
    # 否则 run 目录永远不能清理（导出会指向工作目录），这是实际踩到的设计问题。
    published = _publish_deck(decks[-1])
    return dict(ok=True, deck=published, run_dir=run_dir, source_deck=decks[-1],
                pages=pages, failures=[])


def convert_items(project_id: str, items: List[Dict[str, Any]],
                  on_event: Optional[Callable[[Dict[str, Any]], None]] = None,
                  cancel_key: str = "", validate_text: bool = False) -> Dict[str, Any]:
    """把**任意来源的页面图**交给 skill 精细重建（美化流程用）。

    `items`: [{page_no, image_path, texts?}]。`texts` 是原稿文字真源（逐字采用）；
    给了就在每一页写 `truth_text.txt`，并在 finalize 后做「不编造/不改写」校验。
    返回 dict(ok, deck, run_dir, pages, failures, warnings)；同步阻塞，调用方放线程里。
    """
    def notify(**kw) -> None:
        if on_event:
            try:
                on_event(kw)
            except Exception:                                  # noqa: BLE001 —— 进度回调不能影响主流程
                pass

    state = available()
    if not state.get("ok"):
        return dict(ok=False, error=state.get("reason"), run_dir="")

    rows: List[Dict[str, Any]] = []
    images: List[str] = []
    for item in items:
        page_no = item.get("page_no")
        path = item.get("image_path") or ""
        if not path or not os.path.isfile(path):
            return dict(ok=False, run_dir="", error="第 %s 页没有页面图，无法转换" % page_no)
        rows.append(dict(page_no=page_no, image_path=path,
                         truth_texts=item.get("texts") if item.get("texts") is not None else []))
        images.append(path)
    if not rows:
        return dict(ok=False, run_dir="", error="没有要转换的页面")

    run_root = os.path.join(config.FILES_DIR, "editppt")
    os.makedirs(run_root, exist_ok=True)
    run_dir = os.path.join(run_root, "%s-%s" % (project_id, db.uid("run")))
    notify(stage="prepare", message="准备精细重建（%d 页）" % len(images), done=0, total=len(rows))
    prep = _run(["prepare"] + images + ["--out-root", run_dir], timeout=SETUP_TIMEOUT + 120 * len(images))
    if not prep["ok"]:
        return dict(ok=False, run_dir=run_dir, error="prepare 失败：%s" % (prep["err"] or prep["out"])[-400:])
    run_dir = _latest_run_dir(run_dir) or run_dir
    try:
        json.dump([row["page_no"] for row in rows], open(os.path.join(run_dir, "deckforge_pages.json"), "w"))
    except OSError:
        pass

    result = _run_pages(project_id, run_dir, rows, notify, cancel_key)
    if result.get("ok") and validate_text:
        check = _validate_deck_text(result["deck"], rows, result.get("run_dir") or "")
        result["warnings"] = check.get("warnings", [])
        if not check.get("ok"):
            return dict(ok=False, run_dir=run_dir, pages=result.get("pages") or [],
                        deck=result.get("deck"), warnings=check.get("warnings", []),
                        failures=[dict(stage="validate", error=check.get("error", ""))],
                        error=check.get("error", "精细重建产物未通过文字校验"))
    return result


def _deck_text(path: str) -> tuple:
    """读 pptx 的所有文字（含组合与表格单元格）与幻灯片数。"""
    from pptx import Presentation
    prs = Presentation(path)
    texts: List[str] = []

    def visit(shapes) -> None:
        for shape in shapes:
            if getattr(shape, "shape_type", None) == 6:        # 组合形状
                visit(shape.shapes)
                continue
            if getattr(shape, "has_text_frame", False) and shape.text.strip():
                texts.append(shape.text)
            if getattr(shape, "has_table", False):
                for row in shape.table.rows:
                    for cell in row.cells:
                        if cell.text.strip() and not cell.is_spanned:
                            texts.append(cell.text)

    for slide in prs.slides:
        visit(slide.shapes)
    return prs, texts


def _validate_deck_text(deck: str, rows: List[Dict[str, Any]],
                        run_dir: str = "") -> Dict[str, Any]:
    """finalize 后的文字/图片硬校验：不编造、不改写、不伪造整页图片。

    文字按「字符多重集」比对（允许换行/拆框带来的切分差异，不允许增删字）。
    整页图片：与 skill 的 page 校验同口径——`source.png` 或 user-provided 整页图
    不允许压在可编辑文字上；imagegen clean base / asset-sheet 背景允许作为背景层。
    """
    from collections import Counter

    try:
        prs, actual_texts = _deck_text(deck)
    except Exception as exc:                                    # noqa: BLE001
        return dict(ok=False, error="产物无法解析：%s: %s" % (type(exc).__name__, exc), warnings=[])

    page_rows = sorted(rows, key=lambda r: r.get("page_no") or 0)
    if len(prs.slides) != len(page_rows):
        return dict(ok=False, error="产物页数不一致（%d 页，输入 %d 页）"
                    % (len(prs.slides), len(page_rows)), warnings=[])

    # 整页图：允许 imagegen clean base 当背景；禁止 source.png / user-provided 整页图冒充可编辑
    def _page_manifest(index: int) -> Dict[str, Any]:
        if not run_dir:
            return {}
        for pattern in ("pages/page_%03d/manifest.json" % index,
                        "pages/page_%d/manifest.json" % index):
            path = os.path.join(run_dir, pattern)
            if os.path.isfile(path):
                try:
                    return json.load(open(path, encoding="utf-8"))
                except (OSError, ValueError):
                    return {}
        return {}

    for index, slide in enumerate(prs.slides, 1):
        full_slide = False
        for shape in slide.shapes:
            if getattr(shape, "shape_type", None) == 13 and \
                    (shape.width or 0) >= prs.slide_width * .95 and (shape.height or 0) >= prs.slide_height * .95:
                full_slide = True
                break
        if not full_slide:
            continue
        manifest = _page_manifest(index)
        provenance = {str(item.get("path") or ""): str(item.get("source_type") or "")
                      for item in manifest.get("asset_provenance") or [] if isinstance(item, dict)}
        full_images = []
        for item in manifest.get("images") or []:
            box = item.get("box_px") or []
            source = manifest.get("source") or {}
            if len(box) == 4 and source.get("width_px") and source.get("height_px") and \
                    float(box[2]) >= float(source["width_px"]) * .95 and \
                    float(box[3]) >= float(source["height_px"]) * .95:
                full_images.append(item)
        if not manifest:
            # 没有 manifest 可查时保守：整页图 + 没有任何可编辑文字才判失败
            has_text = any(getattr(sh, "has_text_frame", False) and sh.text.strip() for sh in slide.shapes)
            if not has_text:
                return dict(ok=False, error="第 %d 页只有整页图片，没有可编辑内容" % index, warnings=[])
            continue
        for item in full_images:
            path = str(item.get("path") or "")
            source_type = provenance.get(path, "")
            if os.path.basename(path) == "source.png" or source_type in ("user-provided", "user-approved-rasterization"):
                return dict(ok=False, error="第 %d 页用了整页源图/user-provided 图片冒充可编辑" % index, warnings=[])
    

    truth = "".join(str(t) for row in page_rows for t in (row.get("truth_texts") or []))
    norm = lambda value: re.sub(r"\s+", "", value)              # noqa: E731
    truth_norm = norm(truth)
    actual_norm = norm("".join(actual_texts))
    if not truth_norm:
        return dict(ok=True, warnings=[])
    if not actual_norm:
        return dict(ok=False, error="产物没有任何可编辑文字（真源有 %d 字）" % len(truth_norm), warnings=[])

    truth_chars, actual_chars = Counter(truth_norm), Counter(actual_norm)
    invented = actual_chars - truth_chars
    missing = truth_chars - actual_chars
    if invented:
        sample = "".join(list(invented.elements())[:12])
        return dict(ok=False, error="产物出现真源里没有的文字（可能是编造/改写）：%s…" % sample, warnings=[])
    missing_ratio = sum(missing.values()) / max(1, len(truth_norm))
    warnings = []
    if missing_ratio > 0.35:
        return dict(ok=False, error="产物缺失 %.0f%% 的真源文字（超过 35%% 上限）" % (missing_ratio * 100),
                    warnings=warnings)
    if missing_ratio > 0:
        warnings.append("产物缺少 %.0f%% 的真源文字（可能被当成图片资产；请按页核对）" % (missing_ratio * 100))
    return dict(ok=True, warnings=warnings)


def _publish_deck(deck: str) -> str:
    """把最终 deck 复制到 exports/ 并返回新路径（复制失败则退回原路径，不假装成功）。"""
    try:
        out_dir = os.path.join(config.FILES_DIR, "exports")
        os.makedirs(out_dir, exist_ok=True)
        stem = os.path.splitext(os.path.basename(deck))[0]
        name = "%s_editppt_%s.pptx" % (re.sub(r"[^\w\u4e00-\u9fff-]", "_", stem),
                                       db.uid("e"))
        dest = os.path.join(out_dir, name)
        shutil.copyfile(deck, dest)
        return dest
    except OSError:
        return deck


def _latest_run_dir(parent: str) -> Optional[str]:
    """`prepare --out-root X` 会在 X 下再建一层 run 目录，这里取最新的一层（没有就返回 X）。"""
    if not os.path.isdir(parent):
        return None
    subs = [os.path.join(parent, d) for d in os.listdir(parent) if os.path.isdir(os.path.join(parent, d))]
    return sorted(subs)[-1] if subs else parent


def _hints_text_count(page_dir: str) -> int:
    path = os.path.join(page_dir, "text_hints.json")
    try:
        hints = json.load(open(path, encoding="utf-8"))
    except (OSError, ValueError):
        return 0
    return sum(1 for line in hints.get("lines") or [] if (line.get("text") or "").strip())


def _run_ocr(page_dir: str) -> Dict[str, Any]:
    """离线 OCR 兜底（RapidOCR）：没有真源、也没有视觉识别时，给 text_hints.json 补文本。"""
    if ocr_mode() == "off":
        return dict(ok=False, reason="OCR 已关闭（editppt.ocr=off）")
    script = os.path.join(config.ROOT, "server", "pptx", "editppt_ocr.py")
    if not os.path.isfile(script):
        return dict(ok=False, reason="缺少 OCR 适配器：%s" % script)
    python = ocr_python()
    if not os.path.isfile(python):
        return dict(ok=False, reason="找不到 editppt venv 的 python3：%s" % python)
    try:
        proc = subprocess.run([python, script, str(page_dir), "--skill-root", skill_dir()],
                              env=_env(), capture_output=True, text=True, timeout=300)
    except (OSError, subprocess.TimeoutExpired) as exc:
        return dict(ok=False, reason="%s: %s" % (type(exc).__name__, exc))
    payload: Dict[str, Any] = {}
    for line in reversed((proc.stdout or "").strip().splitlines()):
        try:
            payload = json.loads(line)
            break
        except ValueError:
            continue
    if proc.returncode != 0 or not payload.get("ok"):
        return dict(ok=False, reason=(payload.get("reason") or (proc.stderr or proc.stdout) or "OCR 失败")[-300:])
    return payload


def _prepare_page(run_dir: str, page_dir: str, row: Dict[str, Any],
                  notify: Callable[..., None]) -> None:
    """生成 worker prompt、墨迹测量、以及内容真源（缺一不可）。

    真源优先级：
      1. `truth_texts`（美化：原稿逐字文本）→ truth_text.txt
      2. 视觉识别（生成流程：native_scene/vision 或 Qwen-VL）→ 写标准 text_hints.json 的 text
      3. skill 自己的 hints 已带文本（配置了 PaddleOCR token）→ 直接用
      4. 离线 RapidOCR 适配器补文本（server/pptx/editppt_ocr.py）
      5. 都没有 → 如实失败，提示配置 OCR，而不是让 worker 猜文字
    """
    prompt_script = os.path.join(skill_dir(), "scripts", "build-page-worker-prompt.py")
    subprocess.run([os.path.join(os.path.dirname(cli_path()), "python3"),
                    prompt_script, run_dir, "--page", os.path.basename(page_dir),
                    "--out", os.path.join(page_dir, "worker-prompt.md")],
                   env=_env(), check=True, capture_output=True, text=True, timeout=120)
    _run(["page", "hints", page_dir])                            # 它的墨迹测量（几何 + size_group）

    truth_texts = row.get("truth_texts")
    if truth_texts is not None:
        texts = [str(item).strip() for item in truth_texts if str(item).strip()]
        with open(os.path.join(page_dir, "truth_text.txt"), "w", encoding="utf-8") as target:
            target.write("\n".join(texts))
        json.dump(dict(page_no=row.get("page_no"), texts=texts),
                  open(os.path.join(page_dir, "truth_text.json"), "w", encoding="utf-8"),
                  ensure_ascii=False, indent=1)
        notify(stage="hints", message="第 %s 页文字真源已就绪（%d 条）" % (row.get("page_no"), len(texts)))
        return

    img = row.get("image_path") or ""
    scene = json.loads(row.get("native_scene_json") or "{}") if row.get("native_scene_json") else {}
    vision = (scene.get("vision") or {})
    blocks = scene.get("blocks") or []
    vision_error = ""
    if not blocks or not vision:
        try:
            res = providers.analyze_slide_with_qwen(img)
        except Exception as exc:                                # noqa: BLE001 —— 视觉不可用不致命，交给 OCR
            res = dict(ok=False, message="%s: %s" % (type(exc).__name__, exc))
        if res.get("ok"):
            from .pipeline import blocks_from_vision
            blocks = blocks_from_vision(res["scene"], int(row.get("width") or 0), int(row.get("height") or 0))
        else:
            vision_error = str(res.get("message") or res.get("reason") or "视觉识别不可用")[:160]
    if blocks:
        hints_path = os.path.join(page_dir, "text_hints.json")
        ink = []
        if os.path.exists(hints_path):
            try:
                ink = (json.load(open(hints_path, encoding="utf-8")).get("lines") or [])
            except (OSError, ValueError):
                ink = []
        payload = build_hints(blocks, ink, int(row.get("width") or 1600), int(row.get("height") or 900))
        json.dump(payload, open(hints_path, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
        notify(stage="hints", message="第 %s 页文字真源已就绪（%d 条）" % (row.get("page_no"), len(blocks)))
        return

    if _hints_text_count(page_dir):
        notify(stage="hints", message="第 %s 页使用 skill 的 OCR hints（%d 行带文字）"
               % (row.get("page_no"), _hints_text_count(page_dir)))
        return

    ocr = _run_ocr(page_dir)
    if ocr.get("ok") and ocr.get("lines"):
        notify(stage="hints", message="第 %s 页离线 OCR 已就绪（%d 行）"
               % (row.get("page_no"), int(ocr.get("lines") or 0)))
        return
    raise RuntimeError("无法获取文字真源：%s；OCR 兜底也不可用（%s）。"
                       "请配置 PaddleOCR token（editppt config --paddle-ocr-token）"
                       "或安装 RapidOCR 后重试"
                       % (vision_error or "没有视觉识别结果", ocr.get("reason") or "未知原因"))
