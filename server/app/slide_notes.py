# -*- coding: utf-8 -*-
"""PPT 备注模块：上传已有 .pptx → 逐页建立「内容真源」→ DeepSeek 写演讲备注 → 写回备注栏导出。

与生成流程（pipeline）解耦，但复用两样东西：
  · 作业/SSE 通道（pipeline.new_job / emit / job_queue / _job_update）→ 前端零额外接线
  · 视觉模型配置（config.vision_provider）+ 宽容 JSON 解析（providers.parse_vision_json）

三条铁律（改动前先读）：
  1. 「内容真源」只能由**页面自身**产生：文本框/表格文字 + 该页渲染图的识别结果。
     两样都取不到就不生成备注（如实报错），绝不靠模型常识把页面补圆。
  2. 导出只写 notes 备注栏；页数、形状、字体、母版、图片一律不动。
  3. 渲染出的 PDF 页数必须与 pptx 页数一致，否则拒绝继续
     —— 备注错到别的页上，是这类工具最致命的错误，宁可失败也不猜。
"""
import asyncio
import base64
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import threading
import time
from typing import Any, Dict, List, Optional, Tuple

from . import config, db, pipeline, providers

# ────────────────────────── 常量 ──────────────────────────

SOFFICE_CANDIDATES = [
    "/Applications/LibreOffice.app/Contents/MacOS/soffice",
    "/usr/local/bin/soffice",
    "/opt/homebrew/bin/soffice",
]
RENDER_WIDTH = 1600                 # 渲染宽度（视觉识别够用，又不至于把图传得过大）
RENDER_TIMEOUT = 900                # 98MB/64 页实测 28s，留足余量
LOW_INFO_CHARS = 30                 # 文本框文字少于此 → 判为「图片页」，必须靠视觉识别
VISION_CONCURRENCY = 3
TEXT_CONCURRENCY = 4
VISION_MAX_TOKENS = 4000
VISION_MAX_TOKENS_RETRY = 12000

# 计费估算（元/百万 token）。价格随厂商调整，账本仅作「大概花了多少」参考，
# 精确对账以厂商账单为准。DeepSeek 单价与 providers.call_text 保持一致。
VISION_PRICE_IN, VISION_PRICE_OUT = 1.5, 4.5

VISION_PROMPT = """这是一页 PPT 幻灯片。请如实识别页面上的信息，用于给汇报人撰写演讲备注。

输出严格 JSON（不要 Markdown 代码块）：
{
  "title": "页面主标题（取不到留空）",
  "text_on_page": ["页面上出现的所有文字，逐条列出，包含图片/截图里的文字"],
  "visual": "画面主体是什么（架构图/界面截图/图表/照片/插画/纯装饰）及其层次结构、模块名称、界面元素",
  "data": [{"label": "指标名", "value": "数值", "unit": "单位"}]
}

要求：
· text_on_page 要尽量把页面上真实存在的文字抄全，不要概括、不要翻译。
· visual 描述页面画面上真实存在的东西，不要推测业务含义。
· data 只填页面上明确出现的数值（含图表上的），看不清就留空数组。
· 看不清或页面上没有的项目一律留空，**禁止编造、禁止脑补**。只输出 JSON。"""

NOTE_SYSTEM = """你是资深的项目汇报讲稿撰写人，为汇报人撰写这一页幻灯片的演讲者备注。

【最重要的约束】只能依据下面给出的「页面内容」写作。页面内容里没有的信息、数字、案例、背景、
政策、成效，一律不许出现。你不确定的东西就不写。宁可写得短，也不要编。

【篇幅按页面信息量自适应，不要一律写长】
· 信息丰富的页（有要点、数据、架构、多个功能模块）：120~180 字，说清这页在讲什么、关键信息是什么。
· 案例展示页、界面截图页、装饰插画页、章节过渡页：**一句话说清即可，控制在 40 字以内**，不展开、不拔高。
· 封面页：一句开场。结尾页：一句收尾。都保持简短。

【语气】正式的项目汇报口径，像人站在现场讲，自然、克制、有信息量。听众是校方领导与图书馆专家。

【禁止】「本页」「这一页」「备注」「讲稿」这类元词；复述标题；用「首先/其次/最后」硬凑结构；
空话套话（如「具有重要意义」「为高质量发展赋能」「立体呈现整体态势」）。

【输出】只输出备注正文，一整段可直接照读的话。不要前后缀、不要引号、不要小标题、不要换行分段。"""


# ────────────────────────── 渲染：pptx → PDF → 逐页 PNG ──────────────────────────

def find_soffice() -> str:
    env = os.environ.get("DECKFORGE_SOFFICE", "")
    if env and os.path.exists(env):
        return env
    for p in SOFFICE_CANDIDATES:
        if os.path.exists(p):
            return p
    for variable, default in (("ProgramFiles", "C:\\Program Files"),
                              ("ProgramFiles(x86)", "C:\\Program Files (x86)")):
        path = os.path.join(os.environ.get(variable, default), "LibreOffice", "program", "soffice.exe")
        if os.path.isfile(path):
            return path
    found = shutil.which("soffice")
    if found:
        return found
    raise ValueError("未找到 LibreOffice（用于把 PPT 渲染成图做视觉识别）。"
                     "请安装后在设置里或用环境变量 DECKFORGE_SOFFICE 指定 soffice 路径。")


def render_deck(pptx_path: str, out_dir: str, expect_pages: int, width: int = RENDER_WIDTH) -> List[str]:
    """把 pptx 渲染成逐页 PNG，返回按页码顺序的 PNG 路径列表。

    用 LibreOffice 转 PDF（比逐页截图稳），再用 PyMuPDF 出图。
    独立 user profile：本机开着 LibreOffice 界面时，共用 profile 的 headless 转换会静默失败。
    """
    import fitz                                        # PyMuPDF

    soffice = find_soffice()
    tmp = tempfile.mkdtemp(prefix="deckforge_notes_")
    profile = tempfile.mkdtemp(prefix="deckforge_lo_profile_")
    os.makedirs(out_dir, exist_ok=True)
    try:
        cmd = [soffice, "--headless", "--norestore", "--nologo", "--nolockcheck",
               "-env:UserInstallation=%s" % Path(profile).resolve().as_uri(),
               "--convert-to", "pdf", "--outdir", tmp, pptx_path]
        try:
            proc = subprocess.run(cmd, capture_output=True, text=True, timeout=RENDER_TIMEOUT)
        except subprocess.TimeoutExpired as e:
            raise ValueError("渲染 PPT 超时（超过 %d 秒），文件可能过大或已损坏" % RENDER_TIMEOUT) from e
        pdfs = [f for f in os.listdir(tmp) if f.lower().endswith(".pdf")]
        if not pdfs:
            raise ValueError("渲染失败：LibreOffice 未产出 PDF。%s"
                             % (proc.stderr or proc.stdout or "")[:300].strip())
        pdf_path = os.path.join(tmp, pdfs[0])
        doc = fitz.open(pdf_path)
        # 铁律 3：页数不一致绝不继续（否则备注会串页）
        if expect_pages and doc.page_count != expect_pages:
            raise ValueError("渲染页数（%d）与 PPT 页数（%d）不一致，已中止以防备注错页。"
                             "请检查文件是否含隐藏页或损坏。" % (doc.page_count, expect_pages))
        pngs = []
        for i in range(doc.page_count):
            pg = doc[i]
            zoom = float(width) / float(pg.rect.width or 1)
            pix = pg.get_pixmap(matrix=fitz.Matrix(zoom, zoom))
            fp = os.path.join(out_dir, "p%03d.png" % (i + 1))
            pix.save(fp)
            pngs.append(fp)
        doc.close()
        return pngs
    finally:
        shutil.rmtree(profile, ignore_errors=True)
        shutil.rmtree(tmp, ignore_errors=True)


# ────────────────────────── 原页渲染（逐页核对用，按需触发）──────────────────────────

_RENDER_LOCKS: Dict[str, threading.Lock] = {}
_RENDER_GUARD = threading.Lock()


def _render_lock(nid: str) -> threading.Lock:
    with _RENDER_GUARD:
        return _RENDER_LOCKS.setdefault(nid, threading.Lock())


def ensure_rendered(nid: str) -> Dict[str, Any]:
    """把上传的 pptx 渲染成逐页 PNG（幂等、按 job 串行），供「逐页复核」显示 PPT 实际页面。

    上传刻意不做渲染（秒回、不花钱）；第一次进入复核步骤时前端才调本函数，之后走磁盘缓存。
    页数校验沿用 render_deck 的铁律：渲染页数与 PPT 页数不一致时中止，绝不错页。
    """
    job = job_row(nid)
    if not job:
        raise ValueError("备注任务不存在")
    source = job.get("source_path") or ""
    if not source or not os.path.isfile(source):
        raise ValueError("上传的原文件已不在磁盘上，无法渲染原页")

    def current_rows() -> List[Dict[str, Any]]:
        return page_rows(nid)

    def missing(rows: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        return [r for r in rows if not (r.get("render_path") and os.path.isfile(r["render_path"] or ""))]

    rows = current_rows()
    if not rows:
        raise ValueError("这个任务还没有页面记录")
    rendered = False
    if missing(rows):
        with _render_lock(nid):
            rows = current_rows()                       # 等锁期间别的请求可能已经渲染完
            if missing(rows):
                render_dir = os.path.join(config.FILES_DIR, "notes", nid)
                pngs = render_deck(source, render_dir, int(job.get("pages") or 0))   # 页数不符会抛 ValueError
                for i, row in enumerate(current_rows(), 1):
                    if i <= len(pngs):
                        db.update("notes_pages", row["id"], dict(render_path=pngs[i - 1]))
                db.update("notes_jobs", nid, dict(render_dir=render_dir))
                rendered = True

    pages = [dict(page_no=int(r["page_no"]),
                  image_url="/files/notes/%s/p%03d.png" % (nid, int(r["page_no"])))
             for r in current_rows()
             if r.get("render_path") and os.path.isfile(r["render_path"] or "")]
    return dict(rendered=rendered, page_count=len(current_rows()), pages=pages)


# ────────────────────────── 解析 pptx（文本框 / 表格 / 已有备注）──────────────────────────

def _shape_type(sh: Any):
    """shape_type 对某些形状会抛 NotImplementedError（真机 64 页文件已踩到）→ 返回 None。"""
    try:
        from pptx.enum.shapes import MSO_SHAPE_TYPE
        return sh.shape_type if sh.shape_type in MSO_SHAPE_TYPE else sh.shape_type
    except Exception:                                   # noqa: BLE001
        return None


def _walk_shapes(shapes) -> Tuple[List[str], int]:
    """递归收集文本（含组合内、表格单元格），并统计图片数。"""
    from pptx.enum.shapes import MSO_SHAPE_TYPE

    texts: List[str] = []
    pics = 0
    for sh in shapes:
        st = _shape_type(sh)
        if st == MSO_SHAPE_TYPE.GROUP:
            try:
                t, p = _walk_shapes(sh.shapes)
                texts += t
                pics += p
                continue
            except Exception:                           # noqa: BLE001
                continue
        if st == MSO_SHAPE_TYPE.PICTURE:
            pics += 1
        try:
            if getattr(sh, "has_table", False) and sh.has_table:
                for row in sh.table.rows:
                    line = " | ".join((c.text or "").strip() for c in row.cells).strip(" |")
                    if line:
                        texts.append(line)
        except Exception:                               # noqa: BLE001
            pass
        try:
            if sh.has_text_frame and sh.text_frame.text.strip():
                texts.append(sh.text_frame.text.strip())
        except Exception:                               # noqa: BLE001
            pass
    return texts, pics


def parse_pptx(path: str) -> List[Dict[str, Any]]:
    """读出每页：文本框/表格文字、图片数、原文件已有备注。纯读，不改文件。"""
    from pptx import Presentation

    prs = Presentation(path)
    out = []
    for i, s in enumerate(list(prs.slides), 1):         # 切片 prs.slides[:n] 会崩，必须 list()
        texts, pics = _walk_shapes(s.shapes)
        try:
            original = s.notes_slide.notes_text_frame.text.strip() if s.has_notes_slide else ""
        except Exception:                               # noqa: BLE001
            original = ""
        text = "\n".join(t for t in texts if t.strip())
        out.append(dict(page_no=i, text_source=text, pic_count=pics, note_original=original,
                        low_info=1 if len(text) < LOW_INFO_CHARS else 0))
    return out


def create_job(pptx_path: str, source_name: str, title: str = "") -> Dict[str, Any]:
    """登记一个备注任务并解析页清单（不花钱、不渲染，秒回）。"""
    pages = parse_pptx(pptx_path)
    nid = db.uid("n")
    low = sum(1 for p in pages if p["low_info"])
    db.insert("notes_jobs", dict(
        id=nid, title=title or os.path.splitext(source_name)[0], source_name=source_name,
        source_path=pptx_path, pages=len(pages), image_pages=low,
        notes_existing=sum(1 for p in pages if p["note_original"]),
        status="uploaded", cost_cny=0.0, created_at=db.now(), updated_at=db.now()))
    for p in pages:
        db.insert("notes_pages", dict(
            id=db.uid("np"), job_id=nid, page_no=p["page_no"], text_source=p["text_source"],
            pic_count=p["pic_count"], note_original=p["note_original"], low_info=p["low_info"],
            vision_status="pending", note_status="pending", vision_json="{}",
            created_at=db.now(), updated_at=db.now()))
    return job_detail(nid)


def job_row(nid: str) -> Optional[Dict[str, Any]]:
    row = db.q1("SELECT * FROM notes_jobs WHERE id=?", (nid,))
    return dict(row) if row else None


def page_rows(nid: str, page_nos: Optional[List[int]] = None) -> List[Dict[str, Any]]:
    if page_nos:
        marks = ",".join("?" * len(page_nos))
        return [dict(r) for r in db.q(
            "SELECT * FROM notes_pages WHERE job_id=? AND page_no IN (%s) ORDER BY page_no" % marks,
            (nid,) + tuple(page_nos))]
    return [dict(r) for r in db.q("SELECT * FROM notes_pages WHERE job_id=? ORDER BY page_no", (nid,))]


def _public_page(r: Dict[str, Any]) -> Dict[str, Any]:
    import json as _json
    d = dict(r)
    for k in ("vision_json", "content_json"):
        try:
            d[k.replace("_json", "")] = _json.loads(r.get(k) or "{}")
        except Exception:                               # noqa: BLE001
            d[k.replace("_json", "")] = {}
    d["image_url"] = "/files/notes/%s/p%03d.png" % (r["job_id"], r["page_no"]) if r.get("render_path") else ""
    d["has_original_note"] = bool((r.get("note_original") or "").strip())
    for k in ("note_cost_cny", "vision_cost_cny"):
        d[k] = float(r.get(k) or 0.0)
    return d


def job_detail(nid: str) -> Dict[str, Any]:
    job = job_row(nid)
    if not job:
        return {}
    pages = [_public_page(r) for r in page_rows(nid)]
    out = dict(job)
    out["cost_cny"] = float(job.get("cost_cny") or 0.0)
    out["pages_detail"] = pages
    out["notes_done"] = sum(1 for p in pages if p["note_status"] == "done" and (p["note"] or "").strip())
    out["notes_failed"] = sum(1 for p in pages if p["note_status"] == "failed")
    return out


# ────────────────────────── 视觉识别（图片页的内容来源）──────────────────────────

def _vision_call(data_url: str, max_tokens: int) -> Dict[str, Any]:
    import httpx

    vp = config.vision_provider(with_keys=True)
    if not vp.get("key"):
        raise ValueError("未配置视觉模型 API Key（设置页 → 视觉模型）")
    body = dict(model=vp["default_model"], temperature=0.0, max_tokens=max_tokens,
                messages=[dict(role="user", content=[
                    dict(type="image_url", image_url=dict(url=data_url)),
                    dict(type="text", text=VISION_PROMPT)])])
    with httpx.Client(**providers._client_kwargs(bool(vp.get("needs_proxy")), 240.0)) as c:
        r = c.post(vp["base_url"].rstrip("/") + "/chat/completions",
                   headers={"Authorization": "Bearer %s" % vp["key"], "Content-Type": "application/json"},
                   json=body)
        r.raise_for_status()
        data = r.json()
    choice = (data.get("choices") or [{}])[0]
    return dict(content=(choice.get("message") or {}).get("content") or "",
                finish_reason=choice.get("finish_reason"), usage=data.get("usage") or {},
                model=vp["default_model"])


def recognize_page(png_path: str) -> Dict[str, Any]:
    """识别一页画面。返回 (ok, scene, meta)。失败不抛异常，由调用方决定如实标注。"""
    t0 = time.time()
    try:
        with open(png_path, "rb") as f:
            data_url = "data:image/png;base64," + base64.b64encode(f.read()).decode("ascii")
        res = _vision_call(data_url, VISION_MAX_TOKENS)
        if not res["content"].strip() and res.get("finish_reason") == "length":
            res = _vision_call(data_url, VISION_MAX_TOKENS_RETRY)   # 预算被推理吃光 → 放大重试
        scene = providers.parse_vision_json(res["content"])
        ms = int((time.time() - t0) * 1000)
        if scene is None:
            return dict(ok=False, reason="bad_json", latency_ms=ms, model=res.get("model", ""),
                        message="视觉模型返回无法解析（finish_reason=%s，%d 字符）"
                                % (res.get("finish_reason"), len(res["content"])))
        usage = res.get("usage") or {}
        cost = (usage.get("prompt_tokens", 0) / 1_000_000) * VISION_PRICE_IN + \
               (usage.get("completion_tokens", 0) / 1_000_000) * VISION_PRICE_OUT
        return dict(ok=True, scene=scene, latency_ms=ms, model=res.get("model", ""),
                    usage=usage, cost_cny=round(cost, 6), finish_reason=res.get("finish_reason"))
    except Exception as e:                              # noqa: BLE001
        return dict(ok=False, reason="call_failed", latency_ms=int((time.time() - t0) * 1000),
                    message="%s: %s" % (type(e).__name__, str(e)[:200]))


# ────────────────────────── 内容真源 → 备注 ──────────────────────────

def build_content(page: Dict[str, Any]) -> Dict[str, Any]:
    """把该页的内容真源合并成给文本模型的输入。空就是空，不补。"""
    import json as _json
    scene = {}
    try:
        scene = _json.loads(page.get("vision_json") or "{}") or {}
    except Exception:                                   # noqa: BLE001
        scene = {}
    text_parts = [t for t in (page.get("text_source") or "").split("\n") if t.strip()]
    on_page = [str(x).strip() for x in (scene.get("text_on_page") or []) if str(x).strip()]
    # 画面上识别到的、文本框里没有的文字（图片版页面就靠这个）
    extra = [t for t in on_page if t not in text_parts]
    data = []
    for d in (scene.get("data") or []):
        if isinstance(d, dict) and str(d.get("value") or "").strip():
            data.append(dict(label=str(d.get("label") or ""), value=str(d.get("value") or ""),
                             unit=str(d.get("unit") or "")))
    return dict(title=str(scene.get("title") or "").strip(),
                text_box=text_parts, text_in_image=extra,
                visual=str(scene.get("visual") or "").strip(), data=data)


def content_is_empty(content: Dict[str, Any]) -> bool:
    return not (content.get("text_box") or content.get("text_in_image") or content.get("visual"))


def _content_to_prompt(content: Dict[str, Any]) -> str:
    lines: List[str] = []
    if content.get("title"):
        lines.append("页面标题：%s" % content["title"])
    if content.get("text_box"):
        lines.append("\n幻灯片里的文字：\n" + "\n".join("- " + t for t in content["text_box"]))
    if content.get("text_in_image"):
        lines.append("\n画面（图片/截图）中出现的文字：\n" + "\n".join("- " + t for t in content["text_in_image"]))
    if content.get("visual"):
        lines.append("\n画面内容描述：%s" % content["visual"])
    if content.get("data"):
        lines.append("\n画面上出现的数值：\n" + "\n".join(
            "- %s：%s%s" % (d["label"] or "指标", d["value"], d["unit"]) for d in content["data"]))
    return "\n".join(lines) or "（页面没有可识别的内容）"


def write_note(content: Dict[str, Any], page_no: int, total: int, instruction: str = "",
               brief: bool = False) -> Tuple[bool, str, Dict[str, Any]]:
    """写一页备注。返回 (ok, note, meta)。空正文按失败处理（思考型模型会吃光预算）。"""
    user = "这是第 %d 页（共 %d 页）。\n\n页面内容如下（这是你唯一可依据的信息）：\n%s" % (
        page_no, total, _content_to_prompt(content))
    if brief:
        user += "\n\n本页补充要求：这是一页文字极少的页面，请只用一句话说明，不要展开。"
    if instruction.strip():
        user += "\n\n本次重写的额外要求（必须满足）：%s" % instruction.strip()
    budgets = [8000, 16000]
    meta: Dict[str, Any] = {}
    for i, budget in enumerate(budgets):
        ok, text, meta = providers.call_text(NOTE_SYSTEM, user, max_tokens=budget)
        if ok and (text or "").strip():
            return True, text.strip(), meta
        if not ok:
            return False, "", meta                        # 真失败（未配置/网络）→ 直接上报
        meta["empty_retry"] = i + 1
    return False, "", dict(meta, reason="empty_content",
                           message="模型只输出了推理、正文为空（已把预算放大到 %d 重试过一次）" % budgets[-1])


# ────────────────────────── 作业：解析（渲染 + 视觉）──────────────────────────

async def run_analyze(nid: str, vision_mode: str = "auto", page_nos: Optional[List[int]] = None) -> str:
    """建立/补充每页的「内容真源」。

    vision_mode:
      auto（默认）—— 只对文字过少的「图片页」做画面识别（省钱省时）
      all        —— 每页都识别（更准，更慢更贵）
      off        —— 完全不识别，只读文本框文字
    """
    job = job_row(nid)
    if not job:
        raise ValueError("备注任务不存在")
    if vision_mode not in ("auto", "all", "off"):
        vision_mode = "auto"
    rows = page_rows(nid, page_nos)
    if not rows:
        raise ValueError("没有可识别的页面")

    if vision_mode == "off":
        for r in rows:
            db.update("notes_pages", r["id"], dict(vision_status="skipped"))
        db.update("notes_jobs", nid, dict(status="analyzed"))
        jid = pipeline.new_job(nid, "notes_analyze", len(rows))["id"]
        pipeline._job_update(jid, status="done", done=len(rows), message="已按设置跳过画面识别")
        return jid

    # auto：补齐「图片页」中尚未识别成功的；all：无条件重识别全部
    if vision_mode == "all":
        targets = rows
    else:
        targets = [r for r in rows
                   if (r["low_info"] or not (r["text_source"] or "").strip())
                   and r.get("vision_status") != "done"]

    jid = pipeline.new_job(nid, "notes_analyze", max(1, len(targets)))["id"]
    db.update("notes_jobs", nid, dict(status="analyzing"))
    if not targets:
        db.update("notes_jobs", nid, dict(status="analyzed"))
        pipeline._job_update(jid, status="done", done=0, message="没有需要识别的页面")
        return jid
    asyncio.create_task(_analyze_worker(jid, nid, targets, vision_mode))
    return jid


async def _analyze_worker(jid: str, nid: str, rows: List[Dict[str, Any]], vision_mode: str) -> None:
    done = 0
    total = len(rows)
    try:
        job = job_row(nid)
        render_dir = os.path.join(config.FILES_DIR, "notes", nid)
        need_render = (vision_mode != "off") and any(not r.get("render_path") for r in rows)
        if need_render:
            await pipeline.emit(jid, dict(type="progress", total=total, done=0, stage="render",
                                          status="running", message="正在渲染幻灯片（大文件需 30 秒左右）"))
            try:
                pngs = await asyncio.to_thread(render_deck, job["source_path"], render_dir, int(job["pages"] or 0))
                for i, r in enumerate(page_rows(nid), 1):
                    if i <= len(pngs):
                        db.update("notes_pages", r["id"], dict(render_path=pngs[i - 1]))
                db.update("notes_jobs", nid, dict(render_dir=render_dir))
            except Exception as e:                      # noqa: BLE001 —— 渲染失败：如实标注，不静默降级
                msg = "%s: %s" % (type(e).__name__, str(e)[:200])
                for r in rows:
                    db.update("notes_pages", r["id"], dict(vision_status="failed", error=msg))
                db.update("notes_jobs", nid, dict(status="failed", error=msg))
                pipeline._job_update(jid, status="failed", message=msg)
                await pipeline.emit(jid, dict(type="error", message=msg, done=0, total=total))
                return

        sem = asyncio.Semaphore(VISION_CONCURRENCY)
        cost_acc = 0.0

        async def one_impl(r: Dict[str, Any]) -> None:
            nonlocal done, cost_acc
            async with sem:
                png = (page_rows(nid, [r["page_no"]])[0]).get("render_path") or r.get("render_path")
                if not png or not os.path.exists(png):
                    db.update("notes_pages", r["id"], dict(vision_status="failed", error="缺少该页渲染图"))
                    return
                db.update("notes_pages", r["id"], dict(vision_status="pending"))
                await pipeline.emit(jid, dict(type="progress", total=total, done=done, stage="vision",
                                              page=r["page_no"], status="running",
                                              message="第 %s 页画面识别中" % r["page_no"]))
                res = await asyncio.to_thread(recognize_page, png)
                if res.get("ok"):
                    import json as _json
                    db.update("notes_pages", r["id"], dict(
                        vision_json=_json.dumps(res["scene"], ensure_ascii=False), vision_status="done",
                        vision_model=res.get("model", ""), vision_ms=int(res.get("latency_ms") or 0),
                        vision_cost_cny=float(res.get("cost_cny") or 0.0), error=""))
                    cost_acc += float(res.get("cost_cny") or 0.0)
                    db.log_usage(nid, r["page_no"], "notes_vision", "qwen_vl", res.get("model", ""),
                                 "-", float(res.get("cost_cny") or 0.0), int(res.get("latency_ms") or 0),
                                 True, "备注·画面识别")
                    await pipeline.emit(jid, dict(type="progress", total=total, done=done, stage="vision",
                                                  page=r["page_no"], status="done", image_url=(
                                                      "/files/notes/%s/p%03d.png" % (nid, r["page_no"])),
                                                  message="第 %s 页识别完成" % r["page_no"]))
                else:
                    db.update("notes_pages", r["id"], dict(vision_status="failed",
                                                           error=str(res.get("message") or res.get("reason"))[:200]))
                    await pipeline.emit(jid, dict(type="progress", total=total, done=done, stage="vision",
                                                  page=r["page_no"], status="failed",
                                                  message="第 %s 页识别失败：%s" % (r["page_no"], str(res.get("message"))[:60])))
                done += 1
                pipeline._job_update(jid, done=done)

        async def one(r: Dict[str, Any]) -> None:
            try:
                await one_impl(r)
            except Exception as e:                      # noqa: BLE001 —— 单页隔离
                db.update("notes_pages", r["id"], dict(vision_status="failed",
                                                       error="%s: %s" % (type(e).__name__, str(e)[:180])))
                await pipeline.emit(jid, dict(type="progress", total=total, done=done, stage="vision",
                                              page=r["page_no"], status="failed",
                                              message="第 %s 页异常：%s" % (r["page_no"], str(e)[:60])))

        await asyncio.gather(*[one(r) for r in rows])
        if vision_mode == "off":
            for r in rows:
                db.update("notes_pages", r["id"], dict(vision_status="skipped"))
        cur = job_row(nid) or {}
        db.update("notes_jobs", nid, dict(status="analyzed",
                                          cost_cny=float(cur.get("cost_cny") or 0) + cost_acc))
        pipeline._job_update(jid, status="done", done=done, message="识别完成")
        await pipeline.emit(jid, dict(type="done", done=done, total=total, stage="vision"))
    except Exception as e:                              # noqa: BLE001 —— 兜底：务必终结作业
        msg = "%s: %s" % (type(e).__name__, str(e)[:200])
        pipeline._job_update(jid, status="failed", message=msg)
        db.update("notes_jobs", nid, dict(status="failed", error=msg))
        await pipeline.emit(jid, dict(type="error", message=msg, done=done, total=total))


# ────────────────────────── 作业：生成备注 ──────────────────────────

async def run_generate(nid: str, page_nos: Optional[List[int]] = None, instruction: str = "",
                       only_missing: bool = False) -> str:
    """写备注。

    page_nos 给了 → 只写这些页（显式指定，单页重写也走这里）
    only_missing=True → 只补还没写成功的页（「续跑」，不重跑已完成页、不白花钱）
    否则 → 全部页重写
    """
    job = job_row(nid)
    if not job:
        raise ValueError("备注任务不存在")
    rows = page_rows(nid, page_nos)
    if only_missing and not page_nos:
        rows = [r for r in rows if not (r.get("note") or "").strip() or r.get("note_status") != "done"]
    if not rows:
        raise ValueError("没有需要写备注的页面（都已生成；要重写请点「重新生成全部备注」）")
    if not providers.text_configured():
        raise ValueError("未配置 DeepSeek API Key（设置页 → 文本模型）")
    jid = pipeline.new_job(nid, "notes_generate", len(rows))["id"]
    db.update("notes_jobs", nid, dict(status="generating"))
    asyncio.create_task(_generate_worker(jid, nid, rows, int(job.get("pages") or len(rows)), instruction))
    return jid


async def _generate_worker(jid: str, nid: str, rows: List[Dict[str, Any]], total: int,
                           instruction: str) -> None:
    sem = asyncio.Semaphore(TEXT_CONCURRENCY)
    done = 0
    cost_acc = 0.0

    async def one_impl(r: Dict[str, Any]) -> None:
        nonlocal done, cost_acc
        async with sem:
            fresh = page_rows(nid, [r["page_no"]])[0]
            content = build_content(fresh)
            if content_is_empty(content):
                db.update("notes_pages", r["id"], dict(
                    note_status="failed", note="",
                    error="页面既没有文字、也没识别到画面内容，无法生成备注（不会凭空编）。"
                          "可在高级选项里用「全部页面」重新识别，或手工填写。"))
                await pipeline.emit(jid, dict(type="progress", total=total, done=done, stage="notes",
                                              page=r["page_no"], status="failed",
                                              message="第 %s 页无可用内容，已跳过（不凭空编）" % r["page_no"]))
                done += 1
                pipeline._job_update(jid, done=done)
                return
            db.update("notes_pages", r["id"], dict(note_status="running"))
            await pipeline.emit(jid, dict(type="progress", total=total, done=done, stage="notes",
                                          page=r["page_no"], status="running",
                                          message="第 %s 页写备注中" % r["page_no"]))
            ok, note, meta = await asyncio.to_thread(
                write_note, content, r["page_no"], total, instruction,
                bool(fresh.get("low_info")) and not content.get("text_in_image"))
            if ok:
                cost = float(meta.get("cost_cny") or 0.0)
                cost_acc += cost
                db.update("notes_pages", r["id"], dict(
                    note=note, note_status="done", note_model=meta.get("model", ""),
                    note_ms=int(meta.get("latency_ms") or 0), note_cost_cny=cost,
                    note_edited=0, note_prompt=instruction, error=""))
                db.log_usage(nid, r["page_no"], "notes_write", "deepseek", meta.get("model", ""),
                             "-", cost, int(meta.get("latency_ms") or 0), True, "备注·撰写")
                await pipeline.emit(jid, dict(type="progress", total=total, done=done, stage="notes",
                                              page=r["page_no"], status="done",
                                              message="第 %s 页备注完成" % r["page_no"]))
            else:
                db.update("notes_pages", r["id"], dict(
                    note_status="failed",
                    error=str(meta.get("message") or meta.get("reason") or "生成失败")[:200]))
                db.log_usage(nid, r["page_no"], "notes_write", "deepseek", meta.get("model", ""),
                             "-", 0.0, int(meta.get("latency_ms") or 0), False,
                             str(meta.get("reason") or "")[:120])
                await pipeline.emit(jid, dict(type="progress", total=total, done=done, stage="notes",
                                              page=r["page_no"], status="failed",
                                              message="第 %s 页失败：%s" % (r["page_no"], str(meta.get("message"))[:60])))
            done += 1
            pipeline._job_update(jid, done=done)

    async def one(r: Dict[str, Any]) -> None:
        try:
            await one_impl(r)
        except Exception as e:                          # noqa: BLE001 —— 单页隔离
            db.update("notes_pages", r["id"], dict(note_status="failed",
                                                   error="%s: %s" % (type(e).__name__, str(e)[:180])))
            await pipeline.emit(jid, dict(type="progress", total=total, done=done, stage="notes",
                                          page=r["page_no"], status="failed",
                                          message="第 %s 页异常：%s" % (r["page_no"], str(e)[:60])))

    try:
        await asyncio.gather(*[one(r) for r in rows])
        cur = job_row(nid) or {}
        stat = cur.get("status")
        db.update("notes_jobs", nid, dict(
            status="done" if stat != "failed" else stat,
            cost_cny=float(cur.get("cost_cny") or 0) + cost_acc))
        pipeline._job_update(jid, status="done", done=done, message="生成完成")
        await pipeline.emit(jid, dict(type="done", done=done, total=total, stage="notes"))
    except Exception as e:                              # noqa: BLE001
        msg = "%s: %s" % (type(e).__name__, str(e)[:200])
        pipeline._job_update(jid, status="failed", message=msg)
        await pipeline.emit(jid, dict(type="error", message=msg, done=done, total=total))


# ────────────────────────── 导出：把备注写回 pptx 备注栏 ──────────────────────────

NOTE_MARKER = "【演讲备注】"


def export_with_notes(nid: str, keep_original: bool = True) -> Dict[str, Any]:
    """打开原文件副本写入备注栏并另存。原文件不变，页面内容/版式/母版一律不动。"""
    from pptx import Presentation

    job = job_row(nid)
    if not job:
        raise ValueError("备注任务不存在")
    rows = [r for r in page_rows(nid) if (r.get("note") or "").strip() and r["note_status"] == "done"]
    if not rows:
        raise ValueError("还没有任何已生成的备注，请先生成")
    src = job["source_path"]
    if not os.path.exists(src):
        raise ValueError("原始 PPT 文件已不在（%s）" % src)
    prs = Presentation(src)
    slides = list(prs.slides)
    if len(slides) != int(job["pages"] or 0):
        raise ValueError("原文件页数（%d）与解析时（%d）不一致，已中止以防备注错页"
                         % (len(slides), int(job["pages"] or 0)))
    written, skipped = 0, []
    for r in rows:
        no = int(r["page_no"])
        if no < 1 or no > len(slides):
            skipped.append(no)
            continue
        note = (r["note"] or "").strip()
        original = (r["note_original"] or "").strip()
        if original and keep_original:
            final = "%s\n\n%s\n%s" % (original, NOTE_MARKER, note)
        else:
            final = note
        try:
            slides[no - 1].notes_slide.notes_text_frame.text = final
            written += 1
        except Exception as e:                          # noqa: BLE001
            skipped.append(no)
            db.update("notes_pages", r["id"], dict(error="写备注失败：%s" % str(e)[:150]))
    out_dir = os.path.join(config.FILES_DIR, "exports")
    os.makedirs(out_dir, exist_ok=True)
    fname = "%s_带备注_%s.pptx" % (job["title"] or "deck", time.strftime("%Y%m%d%H%M%S"))
    out_path = os.path.join(out_dir, re.sub(r"[^\w.\u4e00-\u9fff-]", "_", fname))
    prs.save(out_path)
    db.update("notes_jobs", nid, dict(export_path=out_path))
    db.insert("exports", dict(id=db.uid("e"), project_id=nid, kind="notes", path=out_path,
                              pages=written, editable_pages_json=json_dumps(list(range(1, written + 1))),
                              passthrough_pages_json="[]", size_bytes=os.path.getsize(out_path),
                              created_at=db.now()))
    return dict(file="/files/exports/" + os.path.basename(out_path), name=os.path.basename(out_path),
                pages=written, skipped_pages=skipped, kept_original=bool(keep_original),
                size_bytes=os.path.getsize(out_path))


def json_dumps(obj: Any) -> str:
    import json as _json
    return _json.dumps(obj, ensure_ascii=False)
