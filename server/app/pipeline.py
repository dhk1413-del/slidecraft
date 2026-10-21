# -*- coding: utf-8 -*-
"""流水线：解析 → 大纲（DeepSeek 或本地切页）→ 拼 prompt → 生图/本地渲染 → 精细重建（第三方 skill）→ 导出。

作业模型：内存 JOBS + asyncio 队列，供 SSE 推送（`/api/jobs/{id}/stream`）。
并发：生图并发 N=3（对齐对标实测的 3 页并行）。
"""
import asyncio
import hashlib
import json
import os
import re
import shutil
import subprocess
import time
from typing import Any, Dict, List, Optional, Tuple

from . import slide_versions, config, db, editppt_engine, export_pptx, providers, render, stylepacks

JOBS: Dict[str, Dict[str, Any]] = {}
CANCEL: Dict[str, bool] = {}


def request_cancel(job_id: str) -> None:
    CANCEL[job_id] = True


def is_cancelled(job_id: str) -> bool:
    return CANCEL.get(job_id, False)


def clear_cancel(job_id: str) -> None:
    CANCEL.pop(job_id, None)


_QUEUES: Dict[str, asyncio.Queue] = {}
_STREAMS: Dict[str, int] = {}
_TERMINAL = {"done", "failed", "cancelled", "interrupted"}
_MAX_RETAINED_JOBS = 128


def _evict_job(job_id: str) -> None:
    _QUEUES.pop(job_id, None)
    JOBS.pop(job_id, None)
    clear_cancel(job_id)


def _sweep_jobs() -> None:
    # Dict insertion order retains the newest completed jobs; running jobs and
    # connected streams must keep their queues.
    for jid in list(JOBS):
        if len(JOBS) <= _MAX_RETAINED_JOBS:
            break
        if JOBS[jid].get("status") in _TERMINAL and not _STREAMS.get(jid):
            _evict_job(jid)


def stream_open(job_id: str) -> Optional[asyncio.Queue]:
    _STREAMS[job_id] = _STREAMS.get(job_id, 0) + 1
    return job_queue(job_id)


def stream_close(job_id: str) -> None:
    remaining = _STREAMS.get(job_id, 1) - 1
    if remaining:
        _STREAMS[job_id] = remaining
    else:
        _STREAMS.pop(job_id, None)
        if JOBS.get(job_id, {}).get("status") in _TERMINAL:
            _evict_job(job_id)
CONCURRENCY = 3
# 文档生成的逐页并发：与美化同一标准——多页一起生成。默认 6（零 key 时走本地原生渲染，属 CPU 密集，
# 比生图的 8 略保守）；可用环境变量 DECKFORGE_GENERATE_CONCURRENCY 调整。
GENERATE_CONCURRENCY = max(1, int(os.environ.get("DECKFORGE_GENERATE_CONCURRENCY") or 6))
# 美化逐页生图并发：参考产品是「多页一起生成」，默认放宽到 8（页数更少时按页数）。
# 太小会看着像排队；太大可能触发供应商限流——被限流时该页会如实降级为原图并记 warning，不会假装成功。
# 需要调整时用环境变量 DECKFORGE_BEAUTIFY_CONCURRENCY，不必改代码。
BEAUTIFY_CONCURRENCY = max(1, int(os.environ.get("DECKFORGE_BEAUTIFY_CONCURRENCY") or 8))

LAYOUT_CYCLE = ["cover", "cards_4", "data_chart", "comparison_2col", "timeline", "cards_4", "summary"]


# ────────────────────────── 作业与 SSE ──────────────────────────

def recover_interrupted_jobs() -> int:
    """仅恢复无存活进程拥有的作业，重复调用不触碰正常 worker。"""
    conn = db.connect()
    conn.execute("BEGIN IMMEDIATE")
    count = 0
    try:
        active = [dict(r) for r in conn.execute("SELECT * FROM jobs WHERE status IN ('running','queued','cancelling')").fetchall()]
        live_ids = set()
        protected_pages = set()
        for job in active:
            alive = job['id'] in JOBS
            if not alive and job.get('owner_pid'):
                try:
                    os.kill(job['owner_pid'], 0)
                    alive = True
                except ProcessLookupError:
                    pass
                except PermissionError:
                    alive = True
            if alive:
                live_ids.add(job['id'])
                if job['kind'] == 'generate':
                    pages = json.loads(job.get('pages_json') or '{}')
                    if not pages:
                        protected_pages.add((job['project_id'], None))
                    protected_pages.update((job['project_id'], int(no)) for no, event in pages.items()
                                           if event.get('status') in ('running', 'queued'))
        for job in active:
            if job['id'] in live_ids:
                continue
            message = '服务重启，作业已中断；未完成页未生成，可重新生成'
            pages = json.loads(job.get('pages_json') or '{}')
            for no, event in pages.items():
                if event.get('status') in ('queued', 'running'):
                    event.update(status='interrupted', message=message)
                    if job['kind'] == 'generate' and (job['project_id'], int(no)) not in protected_pages and (job['project_id'], None) not in protected_pages:
                        conn.execute("UPDATE slides SET status='interrupted', error=?, updated_at=? WHERE project_id=? AND page_no=?",
                                     (message, db.now(), job['project_id'], int(no)))
            conn.execute("UPDATE jobs SET status='interrupted', message=?, pages_json=?, version=COALESCE(version,0)+1, updated_at=? WHERE id=?",
                         (message, json.dumps(pages, ensure_ascii=False), db.now(), job['id']))
            if job['kind'] == 'generate' and not pages and not any(pid == job['project_id'] for pid, _ in protected_pages):
                conn.execute("UPDATE slides SET status='interrupted', error=? WHERE project_id=? AND status IN ('running','queued')", (message, job['project_id']))
            conn.execute("UPDATE projects SET status='interrupted', updated_at=? WHERE id=? AND status='generating' AND NOT EXISTS (SELECT 1 FROM jobs WHERE project_id=? AND status IN ('running','queued','cancelling'))", (db.now(), job['project_id'], job['project_id']))
            count += 1
        conn.execute('COMMIT')
    except BaseException:
        conn.execute('ROLLBACK')
        raise
    return count


def new_job(project_id: str, kind: str, total: int) -> Dict[str, Any]:
    _sweep_jobs()
    jid = db.uid("j")
    job = dict(id=jid, project_id=project_id, kind=kind, total=total, done=0, status="running",
               owner_pid=os.getpid(), message="", created_at=db.now(), updated_at=db.now())
    from .operations import submission_key
    key = submission_key.get()
    conn = db.connect()
    conn.execute("BEGIN IMMEDIATE")
    try:
        conn.execute("INSERT INTO jobs (%s) VALUES (%s)" % (",".join(job), ",".join("?" * len(job))), tuple(job.values()))
        if key:
            conn.execute("UPDATE operation_submissions SET job_id=? WHERE id=?", (jid, key))
        conn.execute("COMMIT")
    except BaseException:
        conn.execute("ROLLBACK")
        raise
    clear_cancel(jid)
    JOBS[jid] = job
    _QUEUES[jid] = asyncio.Queue()
    return job


async def emit(job_id: str, event: Dict[str, Any]) -> None:
    job = get_job(job_id) or {}
    version = int(job.get("version") or 0) + 1
    pages = json.loads(job.get("pages_json") or "{}")
    event = dict(event, job_id=job_id, version=version, server_time=db.now())
    if event.get("type") == "progress" and event.get("page") is not None:
        pages[str(event["page"])] = event      # 逐页事件才记账；整册作业（如按需转可编辑）没有 page
    _job_update(job_id, version=version, pages_json=json.dumps(pages, ensure_ascii=False))
    q = _QUEUES.get(job_id)
    if q is not None:
        await q.put(event)


def get_job(job_id: str) -> Optional[Dict[str, Any]]:
    row = JOBS.get(job_id) or db.q1("SELECT * FROM jobs WHERE id=?", (job_id,))
    if not row:
        return None
    job = dict(row)
    pages = json.loads(job.get("pages_json") or "{}")
    job["counts"] = {name: sum(e.get("status") == status for e in pages.values())
                     for name, status in (("succeeded", "done"), ("failed", "failed"),
                                          ("running", "running"), ("queued", "queued"), ("interrupted", "interrupted"))}
    status = job["status"]
    job["task_status"] = ("partial_success" if job["counts"]["failed"] and job["counts"]["succeeded"] else
                          "failed" if job["counts"]["failed"] else "succeeded") if status == "done" else status
    return job


def job_queue(job_id: str) -> Optional[asyncio.Queue]:
    return _QUEUES.get(job_id)


def _job_update(job_id: str, **kw) -> None:
    if job_id in JOBS:
        JOBS[job_id].update(kw)
        JOBS[job_id]["updated_at"] = db.now()
    db.update("jobs", job_id, {k: v for k, v in kw.items() if k in
                               ("status", "done", "total", "message", "version", "pages_json")})
    _sweep_jobs()


# ────────────────────────── 文本解析 ──────────────────────────

def parse_file(path: str, filename: str) -> str:
    ext = os.path.splitext(filename)[1].lower()
    if ext in (".md", ".markdown", ".txt"):
        return open(path, encoding="utf-8", errors="replace").read()
    if ext == ".docx":
        import docx                                   # python-docx
        d = docx.Document(path)
        return "\n".join(p.text for p in d.paragraphs if p.text.strip())
    if ext == ".pdf":
        import fitz                                   # pymupdf
        doc = fitz.open(path)
        return "\n".join(page.get_text() for page in doc)
    if ext == ".pptx":
        from pptx import Presentation
        prs = Presentation(path)
        out = []
        for i, s in enumerate(prs.slides, 1):
            texts = [sh.text_frame.text for sh in s.shapes if sh.has_text_frame and sh.text_frame.text.strip()]
            out.append("[第 %d 页] %s" % (i, " / ".join(texts)))
        return "\n".join(out)
    if ext == ".json":
        return open(path, encoding="utf-8", errors="replace").read()
    raise ValueError("暂不支持的文件类型：%s（支持 md/txt/docx/pdf/pptx）" % ext)


# ────────────────────────── 大纲 ──────────────────────────

OUTLINE_SYS = ("你是资深 PPT 内容架构师。把用户给的素材整理成「分章 + 逐页」大纲。"
               "严格输出 JSON 数组，每项是一章："
               "{\"chapter\":\"章节标题(≤14字)\","
               "\"pages\":[{\"title\":\"页标题(≤18字)\",\"role\":\"cover|section|content|data|summary\","
               "\"outline\":\"一句话说明这页讲什么\",\"points\":[\"要点1\",\"要点2\"],"
               "\"must_keep\":[\"必须原样保留的数字或专有名词\"]}]}。"
               "章节标题只能来自素材里真实的标题层级（例如「一、」「第X章」「1.1」或小标题原文），"
               "**不得自己编造章节名**；素材没有明显章节时，把全部页放进一章，章节名用素材标题或「正文」。"
               "不要额外解释，不要 markdown 代码块。")


# 章节级标题（真实标题层级）：#/##、第X章、一、；而 ###/####、1.1 只作为章内分页
CHAPTER_HEAD = re.compile(r"^(#{1,2}\s|第[一二三四五六七八九十]+[章部分]|[一二三四五六七八九十]+、)")


def chapter_summary(pages: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """按页上的 chapter_no/chapter_title 归纳出章节区间，供大纲编辑器左侧章节栏使用。"""
    out: List[Dict[str, Any]] = []
    for page in pages:
        no = int(page.get("chapter_no") or 1)
        title = str(page.get("chapter_title") or "").strip() or ("第 %d 章" % no)
        page_no = int(page.get("page_no") or 0)
        if out and out[-1]["chapter_no"] == no:
            out[-1]["page_to"] = page_no
            out[-1]["page_count"] += 1
        else:
            out.append(dict(chapter_no=no, title=title, page_from=page_no, page_to=page_no, page_count=1))
    return out


def local_split(text: str, target_pages: int) -> List[Dict[str, Any]]:
    """无 DeepSeek key 的本地兜底：按小标题/段落切页 + 规则抽标题与要点。"""
    text = (text or "").strip()
    blocks: List[List[str]] = []
    cur: List[str] = []
    for line in text.split("\n"):
        s = line.strip()
        if not s:
            if cur:
                blocks.append(cur); cur = []
            continue
        if re.match(r"^(#{1,4}\s|第[一二三四五六七八九十]+[章节部分]|[一二三四五六七八九十]+、|\d+(\.\d+)*\s)", s) and cur:
            blocks.append(cur); cur = [s]
        else:
            cur.append(s)
    if cur:
        blocks.append(cur)
    if not blocks:
        blocks = [[text]]

    pages: List[Dict[str, Any]] = []
    chapter_no, chapter_title = 0, ""
    for i, blk in enumerate(blocks):
        head = re.sub(r"^#+\s*", "", blk[0])[:18]
        # 真实标题层级决定归章：第 1 块起章，之后遇到章节级标题再起新章
        if i == 0 or CHAPTER_HEAD.match(blk[0].strip()):
            chapter_no += 1
            chapter_title = (head or ("第 %d 章" % chapter_no))[:24]
        pts = [re.sub(r"^[-*·\d.]+\s*", "", x)[:40] for x in blk[1:5]]
        nums = re.findall(r"\d+(?:\.\d+)?%?|[A-Z]{2,}", " ".join(blk))[:6]
        role = "cover" if i == 0 else ("summary" if i == len(blocks) - 1 else "content")
        pages.append(dict(page_no=i + 1, title=head or "第 %d 页" % (i + 1), role=role,
                          outline=(blk[1][:60] if len(blk) > 1 else head), points=pts or [head],
                          must_keep=sorted(set(nums))[:6], layout=("cover" if i == 0 else LAYOUT_CYCLE[(i) % len(LAYOUT_CYCLE)]),
                          chapter_no=chapter_no or 1, chapter_title=chapter_title or "正文"))
    if target_pages and len(pages) > target_pages:
        pages = pages[:target_pages]
    for i, p in enumerate(pages, 1):
        p["page_no"] = i
        if i == 1:
            p["layout"] = "cover"
            p["role"] = "cover"
        elif i == len(pages):
            p["layout"] = "summary"
            p["role"] = "summary"          # 截断后仍保证末页是「总结」角色
        else:
            p["role"] = p.get("role") or "content"
    return pages


def build_outline(text: str, target_pages: int) -> Dict[str, Any]:
    ok, content, meta = providers.call_text(OUTLINE_SYS, (text or "")[:12000])
    if not ok:
        pages = local_split(text, target_pages)
        return dict(pages=pages, chapters=chapter_summary(pages), configured=False, fellback="local_split",
                    hint="未配置 DeepSeek key：已按本地规则切页（%d 页）。到「设置」填入 key 后可用 LLM 梳理。" % len(pages),
                    provider="local_split", model="local", cost_cny=0.0)
    try:
        raw = content.strip()
        raw = re.sub(r"^```(?:json)?|```$", "", raw, flags=re.M).strip()
        data = json.loads(raw)
        if not isinstance(data, list):
            raise ValueError("顶层不是数组")

        # 新格式：每项是一章 {chapter, pages:[...]}；旧格式（扁平页数组）兼容成单章
        groups: List[tuple] = []
        if any(isinstance(item, dict) and isinstance(item.get("pages"), list) for item in data):
            for item in data:
                if not isinstance(item, dict):
                    continue
                plist = [x for x in (item.get("pages") or []) if isinstance(x, dict)]
                if plist:
                    groups.append((str(item.get("chapter") or item.get("title") or "").strip()[:24], plist))
        else:
            flat = [x for x in data if isinstance(x, dict)]
            if flat:
                groups.append(("", flat))

        pages: List[Dict[str, Any]] = []
        for chapter_no, (chapter_title, plist) in enumerate(groups, 1):
            if target_pages and len(pages) >= target_pages:
                break
            for p in plist:
                if target_pages and len(pages) >= target_pages:
                    break
                i = len(pages) + 1
                pages.append(dict(page_no=i, title=str(p.get("title", ""))[:40],
                                  role=p.get("role", "content"), outline=str(p.get("outline", ""))[:200],
                                  points=[str(x)[:60] for x in (p.get("points") or [])][:6],
                                  must_keep=[str(x)[:30] for x in (p.get("must_keep") or [])][:8],
                                  layout=("cover" if i == 1 else LAYOUT_CYCLE[i % len(LAYOUT_CYCLE)]),
                                  chapter_no=chapter_no,
                                  chapter_title=(chapter_title or ("正文" if len(groups) == 1 else "第 %d 章" % chapter_no))))
        if not pages:
            raise ValueError("空数组")
        pages[-1]["layout"] = "summary"
        db.log_usage(None, None, "outline", meta.get("provider", "deepseek"), meta.get("model", ""), "-",
                     meta.get("cost_cny", 0.0), meta.get("latency_ms", 0), True, "%d 页" % len(pages))
        return dict(pages=pages, chapters=chapter_summary(pages), configured=True, provider=meta.get("provider"),
                    model=meta.get("model"), cost_cny=meta.get("cost_cny", 0.0), hint="")
    except Exception as e:                            # noqa: BLE001 —— LLM 格式异常也降级
        pages = local_split(text, target_pages)
        return dict(pages=pages, chapters=chapter_summary(pages), configured=True, fellback="local_split",
                    hint="LLM 返回格式异常，已用本地规则切页（%s）" % str(e)[:60],
                    provider="local_split", model="local", cost_cny=0.0)


# ────────────────────────── 生成 ──────────────────────────

def refresh_project_result_status(project_id: str) -> None:
    if db.q1("SELECT id FROM jobs WHERE project_id=? AND kind='generate' AND status IN ('queued','running','cancelling')", (project_id,)):
        status = 'generating'
    else:
        rows = db.q("SELECT status, image_path FROM slides WHERE project_id=? AND keep=1", (project_id,))
        completed = sum(r['status'] == 'done' and bool(r['image_path']) for r in rows)
        status = 'done' if completed == len(rows) and completed else 'partial_success' if completed else 'interrupted' if any(r['status'] == 'interrupted' for r in rows) else 'failed'
    db.update('projects', project_id, dict(status=status))


async def run_generation(project_id: str, page_nos: List[int], style_pack_id: str, size: str) -> str:
    slide_versions.backfill()
    proj = dict(db.q1("SELECT * FROM projects WHERE id=?", (project_id,)) or {})
    style = stylepacks.get_style_pack(style_pack_id) or {}
    rows = [dict(r) for r in db.q("SELECT * FROM slides WHERE project_id=? ORDER BY page_no", (project_id,))]
    total = len(page_nos)
    job = new_job(project_id, "generate", total)
    for row in rows:
        if row["page_no"] in page_nos:
            await emit(job["id"], dict(type="progress", page=row["page_no"], total=total,
                       stage="generate", status="queued", message="等待生成"))
    db.update("projects", project_id, dict(status="generating", style_pack_id=style_pack_id, size=size))
    asyncio.create_task(_generate_worker(job["id"], proj, rows, page_nos, style, style_pack_id, size))
    return job["id"]


def render_data_page(proj: Dict[str, Any], row: Dict[str, Any], content: Dict[str, Any],
                     style: Dict[str, Any], size: str) -> Dict[str, Any]:
    """Use the existing native renderer for axes/data; never ask an image model to draw charts."""
    from . import source_pages
    chart_dir = os.path.join(config.FILES_DIR, proj["id"], "native-charts")
    os.makedirs(chart_dir, exist_ok=True)
    path = os.path.join(chart_dir, db.uid("chart") + ".pptx")
    payload = dict(output=path, project=dict(id=proj["id"], title=proj.get("title")),
                   tokens=style.get("tokens") or {}, slides=[dict(page_no=row["page_no"],
                   layout="data_chart", title=content["title"], outline=content["subtitle"], points=content["points"])])
    proc = subprocess.run(["node", os.path.join(config.ROOT, "server/pptx/render_native.mjs")],
                          input=json.dumps(payload, ensure_ascii=False), text=True, capture_output=True, timeout=60)
    if proc.returncode != 0 or not os.path.isfile(path):
        raise ValueError("原生图表渲染失败：" + (proc.stderr or proc.stdout)[:200])
    data = source_pages.render_generated_page(path, {"1K":1024,"2K":2048,"4K":4096}.get(size,2048))
    return dict(ok=True, image_bytes=data, provider="local_render", model="native_chart", cost_cny=0, latency_ms=0)


async def _generate_worker(job_id: str, proj: Dict[str, Any], rows: List[Dict[str, Any]],
                           page_nos: List[int], style: Dict[str, Any], style_pack_id: str,
                           size: str) -> None:
    sem = asyncio.Semaphore(max(1, min(GENERATE_CONCURRENCY, len(page_nos) or 1)))
    done = 0
    failed = 0
    total = len(page_nos)
    by_no = {r["page_no"]: r for r in rows}

    async def _one_impl(page_no: int) -> None:
        nonlocal done
        async with sem:
            if is_cancelled(job_id):
                return
            row = by_no.get(page_no)
            if not row:
                return
            content = dict(title=row.get("title"), subtitle=row.get("outline"),
                           points=json.loads(row.get("points_json") or "[]"),
                           must_keep=json.loads(row.get("must_keep_json") or "[]"),
                           index=str(page_no).zfill(2), meta=proj.get("title", ""))
            modules = json.loads(row.get("modules_json") or "[]")
            content["modules"] = modules
            content["source_note"] = row.get("source_note") or ""
            for module in modules:
                if module.get("text"):
                    content["points"].append(module["text"])
                for cells in module.get("cells", []):
                    content["points"].append(" | ".join("待统计" if c is None or c == "" else str(c) for c in cells)
                                             + ("（" + module["unit"] + "）" if module.get("unit") else ""))
            if content["source_note"]:
                content["points"].append(content["source_note"])
            layout_key = row.get("layout") or "cards_4"
            prompt = render.assemble_prompt(style, layout_key, content, size)
            db.update("slides", row["id"], dict(status="running"))
            await emit(job_id, dict(type="progress", page=page_no, total=total, stage="generate",
                                    status="running", message="第 %s 页生成中" % page_no))
            t0 = time.time()
            if layout_key == "data_chart":
                try:
                    res = await asyncio.to_thread(render_data_page, proj, row, content, style, size)
                except Exception as exc:
                    res = dict(ok=False, provider="local_render", model="local", cost_cny=0,
                               message="确定性图表不可用，保留原文数值、不绘制图表：" + str(exc)[:180])
            else:
                res = await asyncio.to_thread(providers.generate_image, prompt, size,
                                              (style.get("tokens", {}).get("colors", {}) or {}).get("accent", "#1E78FA"))
            img_dir = os.path.join(config.FILES_DIR, proj["id"])
            out_png = os.path.join(img_dir, "%d-%s.png" % (page_no, db.uid("img")))
            provider, model, cost, latency = res["provider"], res["model"], float(res.get("cost_cny") or 0.0), int(res.get("latency_ms") or 0)
            fellback = ""
            if res.get("ok"):
                os.makedirs(img_dir, exist_ok=True)
                with open(out_png, "wb") as f:
                    f.write(res["image_bytes"])
                w, h = _png_size(out_png)
                if model == "native_chart":
                    latency = int((time.time() - t0) * 1000)
            else:
                if is_cancelled(job_id):
                    db.update("slides", row["id"], dict(status=row.get("status", "pending")))
                    return
                fellback = res.get("message", "")
                provider, model, cost = "local_render", "local", 0.0
                w, h = await asyncio.to_thread(render.local_render, content, style, out_png, size,
                                               page_no, len(by_no), layout_key, proj.get("title", ""))
                latency = int((time.time() - t0) * 1000)
            if not os.path.isfile(out_png) or os.path.getsize(out_png) == 0 or not w or not h:
                raise RuntimeError("生成资产为空或不可访问")
            verify = verify_page(content)
            conn = db.connect()
            conn.execute("BEGIN IMMEDIATE")
            try:
                values = dict(
                generated_revision=row.get("content_revision", 1), generated_style=style_pack_id,
                generated_content_json=json.dumps(content, ensure_ascii=False), reviewed_image=None,
                image_path=out_png, width=w, height=h, status="done", provider=provider, model=model,
                size=size, cost_cny=cost, latency_ms=latency, verify_json=json.dumps(verify, ensure_ascii=False),
                editable=0, native_status="pending", native_scene_json="{}", native_object_count=0,
                native_warnings_json="[]", error=fellback, updated_at=db.now())
                db.update("slides", row["id"], values)
                slide_versions.preserve(conn, dict(row, **values), job_id)
                conn.execute("COMMIT")
            except BaseException:
                conn.execute("ROLLBACK")
                raise
            db.log_usage(proj["id"], page_no, "generate", provider, model, size, cost, latency, True,
                         "%s%s" % (layout_key, ("（降级：%s）" % fellback[:40]) if fellback else ""), job_id=job_id)
            done += 1
            _job_update(job_id, done=done)
            await emit(job_id, dict(type="progress", page=page_no, total=total, stage="generate",
                                    status="done", message="第 %s 页完成（%s）" % (page_no, provider),
                                    fellback=fellback, image_url=_files_url(out_png)))

    async def one(page_no: int) -> None:
        nonlocal done, failed
        """单页失败的隔离层：一页崩掉不能拖垮整批，也不能让 SSE 永久挂起。"""
        try:
            await _one_impl(page_no)
        except Exception as e:                       # noqa: BLE001
            msg = "%s: %s" % (type(e).__name__, str(e)[:200])
            row = by_no.get(page_no)
            if row:
                db.update("slides", row["id"], dict(status="failed", error=msg))
            failed += 1
            done += 1
            _job_update(job_id, done=done)
            db.log_usage(proj["id"], page_no, "generate", "local_render", "local", size, 0.0, 0, False, msg[:120], job_id=job_id)
            await emit(job_id, dict(type="progress", page=page_no, total=total, stage="generate",
                                    status="failed", message="第 %s 页失败：%s" % (page_no, msg[:80])))

    try:
        await asyncio.gather(*[one(n) for n in page_nos])
        if is_cancelled(job_id):
            _job_update(job_id, status="cancelled", done=done, message="已取消")
            db.update("projects", proj["id"], dict(status="cancelled"))
            await emit(job_id, dict(type="cancelled", message="已取消生成"))
            return
        _job_update(job_id, status="done" if done > failed else "failed", done=done, message="全部完成" if not failed else "部分完成" if done > failed else "全部失败")
        refresh_project_result_status(proj['id'])
        await emit(job_id, dict(type="done" if done > failed else "error", message="全部失败" if done == failed else "处理结束", deck_id=proj["id"], done=done, total=total))
    except Exception as e:                           # noqa: BLE001 —— 兜底：务必终结作业，别让前端一直转圈
        msg = "%s: %s" % (type(e).__name__, str(e)[:200])
        _job_update(job_id, status="failed", message=msg)
        db.update("projects", proj["id"], dict(status="failed"))
        await emit(job_id, dict(type="error", message=msg, done=done, total=total))


def verify_page(content: Dict[str, Any]) -> Dict[str, Any]:
    """文字保真校验（MVP 版）：结构化文字是我们的真源 → 逐字必然一致；
    真正的 OCR 回读比对（D20）在接入 OCR 后启用，这里如实标注为源侧校验。"""
    text = " ".join([content.get("title") or "", content.get("subtitle") or ""] + list(content.get("points") or []))
    missing = [m for m in (content.get("must_keep") or []) if str(m) not in text]
    return dict(mode="source_side", text_accuracy=1.0, must_keep_total=len(content.get("must_keep") or []),
                must_keep_missing=missing, issues=[], note="源侧校验（文字来自结构化数据，逐字一致）；OCR 回读校验待接入")


def _png_size(path: str):
    from PIL import Image
    with Image.open(path) as im:
        return im.size


def _image_sha256(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _page_visual_reference(row: Dict[str, Any]) -> Dict[str, Any]:
    """把已生成页面作为原生重建的视觉真源。

    这里不把整页 PNG 放进 PPTX。只提取该页自己的色板及无文字的插画裁片，
    文本、卡片、图表仍由原生对象重建，避免“整页图片伪可编辑”。
    """
    image_path = row.get("image_path") or ""
    if not image_path or not os.path.isfile(image_path):
        raise ValueError("该页没有可用的图片版页面，不能按图片版重建")
    from PIL import Image

    with Image.open(image_path) as raw:
        image = raw.convert("RGB")
        width, height = image.size
        # 用角落像素估计真实底色；生成页通常是深色科技底，不能再被风格包的浅色令牌覆盖。
        samples = [image.getpixel((x, y)) for x, y in (
            (0, 0), (width - 1, 0), (0, height - 1), (width - 1, height - 1),
            (width // 2, 0), (0, height // 2),
        )]
        bg_rgb = tuple(sum(p[i] for p in samples) // len(samples) for i in range(3))
        bg_luma = int(0.2126 * bg_rgb[0] + 0.7152 * bg_rgb[1] + 0.0722 * bg_rgb[2])
        # 亮青/蓝像素作为强调色候选；保证可读性而不是把文字白色误识别为主色。
        palette = image.resize((160, 90)).quantize(colors=32).convert("RGB").getcolors(160 * 90) or []
        vivid = [rgb for count, rgb in palette if max(rgb) > 110 and (rgb[2] > rgb[0] * 1.12 or rgb[1] > rgb[0] * 1.12)]
        accent_rgb = max(vivid, key=lambda c: max(c) - min(c), default=(27, 139, 255))
        accent2_rgb = (35, 215, 238) if bg_luma < 125 else (38, 171, 254)

        def hx(rgb: tuple) -> str:
            return "#%02X%02X%02X" % rgb

        assets: List[Dict[str, Any]] = []
        # 封面和总结页的右侧是独立的 AI 插画区。只保留该无文字裁片作为独立图片，
        # 在 PowerPoint 里可替换/裁剪/缩放；绝不嵌入整页 PNG。
        if row.get("layout") in ("cover", "summary"):
            left = int(width * 0.69)
            top = 0 if row.get("layout") == "cover" else int(height * 0.60)
            crop = image.crop((left, top, width, int(height * 0.52) if row.get("layout") == "cover" else height))
            asset_dir = os.path.join(os.path.dirname(image_path), "native-assets")
            os.makedirs(asset_dir, exist_ok=True)
            asset_path = os.path.join(asset_dir, "%s-hero.png" % row.get("page_no"))
            crop.save(asset_path, "PNG")
            assets.append(dict(kind="illustration_crop", path=asset_path,
                               source_rect=[round(left / width, 4), round(top / height, 4), 1, round(crop.height / height, 4)]))

    return dict(
        source_image=dict(path=image_path, sha256=_image_sha256(image_path), width=width, height=height),
        visual=dict(mode="image_guided", dark=bg_luma < 125, background=hx(bg_rgb),
                    accent=hx(accent_rgb), accent2=hx(accent2_rgb),
                    surface="#081E3C" if bg_luma < 125 else "#FFFFFF",
                    ink="#F7FBFF" if bg_luma < 125 else "#1E232E",
                    sub="#C2D5EE" if bg_luma < 125 else "#637083"),
        image_assets=assets,
    )


def _safe_name(title: str) -> str:
    return re.sub(r"[^\w.\u4e00-\u9fff-]", "_", title or "deck")


async def run_editppt(project_id: str, page_nos: List[int], resume: bool = False) -> str:
    """**「图片转可编辑」唯一引擎**：调度第三方 skill `image-to-editable-ppt` 的状态机（分钟级/页）。

    内置引擎（本地渲染）已于 2026-09-21 下线，这条是唯一的路；产物登记为 exports.kind='editable_hi'。
    页面重建由 headless Hermes 作为 page worker 完成；失败如实上报并保留 run 目录。
    `resume=True` 时复用最近一次未完成的 run 现场（跳过已记录页）；可随时取消（保留现场）。
    """
    import shutil
    active = db.q1(
        "SELECT id FROM jobs WHERE project_id=? AND kind='editable_hi' "
        "AND status IN ('queued','running','cancelling') ORDER BY rowid DESC",
        (project_id,))
    if active:                                              # 同一项目只允许一个转换任务：两个任务会同时写同一份现场
        raise ValueError('该项目已有转换任务在跑（%s），请等它结束或先停止后再提交' % active['id'])
    source_rows = None
    if not resume:
        source_rows = [dict(r) for r in db.q('SELECT * FROM slides WHERE project_id=? ORDER BY page_no', (project_id,)) if r['page_no'] in page_nos]
        if len(source_rows) != len(set(page_nos)) or any(not r.get('current_version_id') for r in source_rows):
            raise ValueError('转换页面或当前版本记录缺失')
        root = os.path.join(config.FILES_DIR, 'editppt', db.uid('input'))
        os.makedirs(root, exist_ok=False)
        for row in source_rows:
            if row['status'] != 'done' or not os.path.isfile(row.get('image_path') or ''):
                raise ValueError('所选页尚未就绪，无法转换')
            path = os.path.join(root, str(row['page_no']) + os.path.splitext(row['image_path'])[1])
            shutil.copyfile(row['image_path'], path)
            row['image_path'] = path
    total = len(page_nos)
    job = new_job(project_id, "editable_hi", total)
    db.update("projects", project_id, dict(status="generating"))
    loop = asyncio.get_running_loop()
    editppt_engine.clear_cancel(project_id)                 # 新作业先从干净的取消状态开始
    def on_event(ev: Dict[str, Any]) -> None:
        """引擎跑在线程里，这里把进度安全地送回事件循环（SSE）。"""
        async def _forward() -> None:
            await emit(job["id"], dict(type="progress", **ev))
            if ev.get("done") is not None and ev.get("total"):
                _job_update(job["id"], done=int(ev["done"]), message=str(ev.get("message") or ""))
        try:
            asyncio.run_coroutine_threadsafe(_forward(), loop)
        except RuntimeError:                                   # 事件循环已关闭（服务停止）
            pass

    async def _worker() -> None:
        try:
            res = await asyncio.to_thread(
                editppt_engine.convert, project_id, page_nos, on_event,
                resume=resume, cancel_key=project_id, source_rows=source_rows)
        except Exception as exc:                                # noqa: BLE001
            res = dict(ok=False, error="%s: %s" % (type(exc).__name__, str(exc)[:200]), run_dir="")
        if res.get("ok"):
            import shutil
            eid = db.uid('e')
            project = dict(db.q1('SELECT * FROM projects WHERE id=?', (project_id,)))
            deck = os.path.join(config.FILES_DIR, 'exports', _safe_name(project['title']) + '_editable_hi_' + eid + '.pptx')
            shutil.copyfile(str(res['deck']), deck)
            manifest = os.path.join(res.get('run_dir', ''), 'deckforge_snapshot.json')
            frozen = []
            if os.path.isfile(manifest):
                with open(manifest, encoding='utf-8') as source:
                    frozen = json.load(source)
            snapshot = [dict(slide_id=r['id'], page_no=r['page_no'], display_order=r.get('display_order') or r['page_no'],
                             version_id=r.get('current_version_id'), version_number=r.get('export_version_number')) for r in frozen]
            pages = list(res.get("pages") or [])
            db.insert("exports", dict(id=db.uid("e"), project_id=project_id, kind="editable_hi", path=deck,
                                      snapshot_json=json.dumps(snapshot, ensure_ascii=False),
                                      pages=len(pages), editable_pages_json=json.dumps(pages),
                                      passthrough_pages_json="[]", size_bytes=os.path.getsize(deck),
                                      created_at=db.now()))
            db.update("projects", project_id, dict(status="done"))
            _job_update(job["id"], status="done", done=total,
                        message="完成 %s 页（高精度，已通过自带校验）" % len(pages))
            await emit(job["id"], dict(type="done", done=total, total=total,
                                       file=_files_url(deck), run_dir=res.get("run_dir", "")))
        else:
            recorded = res.get("recorded") or []
            cancelled = bool(res.get("cancelled"))
            status = "cancelled" if cancelled else "failed"
            _job_update(job["id"], status=status, done=len(recorded),
                        message=str(res.get("error") or "转换失败")[:200])
            db.update("projects", project_id, dict(status="done" if cancelled else "failed"))
            await emit(job["id"], dict(type="cancelled" if cancelled else "error",
                                       message=str(res.get("error") or "转换失败")[:400],
                                       recorded=recorded, partial=bool(res.get("partial")),
                                       failures=res.get("failures") or [], run_dir=res.get("run_dir", "")))

    async def guarded_worker():
        try:
            await _worker()
        except Exception as exc:
            message = '转换产物保存失败：' + str(exc)[:300]
            _job_update(job['id'], status='failed', message=message)
            db.update('projects', project_id, dict(status='failed'))
            await emit(job['id'], dict(type='error', message=message))

    asyncio.create_task(guarded_worker())
    return job["id"]


def _files_url(path: str) -> str:
    """把 FILES_DIR 下的绝对路径转成 /files/... 的对外 URL。"""
    root = os.path.abspath(config.FILES_DIR)
    abs_path = os.path.abspath(path)
    return "/files/" + os.path.relpath(abs_path, root).replace(os.sep, "/")


def native_scene(row: Dict[str, Any], visual_override: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """原生 PPTX 的真源，必须与该页图片版一一绑定。
    `visual_override` 供「换皮·重排（B 口径）」使用：色彩改用目标风格包令牌，
    而不是从原页图里取样——否则重排出来的还是原稿那套颜色。
    """
    points = json.loads(row.get("points_json") or "[]") if isinstance(row.get("points_json"), str) else (row.get("points") or [])
    reference = _page_visual_reference(row)
    if visual_override:
        reference["visual"] = dict(visual_override)
    return dict(version=2, layout=row.get("layout") or "cards_4", title=row.get("title") or "",
                outline=row.get("outline") or "", points=points,
                components=["text", "shapes", "svg_icon"] + (["chart"] if row.get("layout") == "data_chart" else []),
                **reference)


MIN_TEXT_W = 0.01          # 宽度小于画布 1% 的识别块基本是噪声
MIN_TEXT_H = 0.005


def _vision_num(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _norm_rect(item: Dict[str, Any], img_w: int = 0, img_h: int = 0) -> Optional[Dict[str, float]]:
    """把一块的坐标归一到画布比例 0-1，**逐块判定单位**。

    实测：qwen3-vl-flash **无视"用 0-1 比例"的要求，返回源图像素**（x=32,w=300 对应 1200×675 的页面），
    而 qwen3-vl-plus 能给比例。逐块判定的好处：同一份返回里混着两种单位也不会算错，
    也不会因为个别大坐标把整份数据都按像素缩放。
    """
    raw_x, raw_y = _vision_num(item.get("x")), _vision_num(item.get("y"))
    raw_w, raw_h = _vision_num(item.get("w")), _vision_num(item.get("h"))
    sx = float(img_w) if (raw_x + raw_w > 1.5 and img_w) else 1.0
    sy = float(img_h) if (raw_y + raw_h > 1.5 and img_h) else 1.0
    x = min(max(raw_x / sx, 0.0), 1.0)
    y = min(max(raw_y / sy, 0.0), 1.0)
    w = min(max(raw_w / sx, 0.0), 1.0)
    h = min(max(raw_h / sy, 0.0), 1.0)
    if w < MIN_TEXT_W or h < MIN_TEXT_H:
        return None
    return dict(x=round(x, 4), y=round(y, 4), w=round(min(w, 1.0 - x), 4), h=round(min(h, 1.0 - y), 4))


def blocks_from_vision(vision: Dict[str, Any], img_w: int = 0, img_h: int = 0) -> List[Dict[str, Any]]:
    """视觉识别的 texts → 可排版文本块（画布比例 0-1，按阅读顺序）。

    只搬运识别到的文字，不造句、不补位；坐标缺失/宽高过小的块直接丢弃，绝不猜位置。
    """
    out: List[Dict[str, Any]] = []
    for item in (vision or {}).get("texts") or []:
        if not isinstance(item, dict):
            continue
        text = str(item.get("text") or "").strip()
        if not text:
            continue
        rect = _norm_rect(item, img_w, img_h)
        if rect is None:
            continue
        size = _vision_num(item.get("font_size_pt")) or _vision_num(item.get("fontSize")) or 0.0
        out.append(dict(text=text, role=str(item.get("role") or "body"), font_size_pt=round(size, 1), **rect))
    out.sort(key=lambda b: (round(b["y"], 2), b["x"]))
    return out


def shapes_from_vision(vision: Dict[str, Any], img_w: int = 0, img_h: int = 0) -> List[Dict[str, Any]]:
    """视觉识别的 components 里可用于"画底衬/图表区域"的块（归一化坐标）。"""
    out: List[Dict[str, Any]] = []
    for item in (vision or {}).get("components") or []:
        if not isinstance(item, dict):
            continue
        kind = str(item.get("type") or "")
        if kind not in ("card", "shape", "chart"):
            continue
        rect = _norm_rect(item, img_w, img_h)
        if rect is None:
            continue
        out.append(dict(type=kind, **rect))
    return out


def charts_from_vision(vision: Dict[str, Any]) -> List[Dict[str, Any]]:
    """视觉识别出的图表数据 → 渲染器要的结构（兼容顶层 chart_data 与 components[].data）。"""
    raw: List[Any] = list((vision or {}).get("chart_data") or [])
    for item in (vision or {}).get("components") or []:
        if isinstance(item, dict) and isinstance(item.get("data"), dict):
            raw.append(item["data"])
    normalized = providers.normalize_chart_data(raw)
    return [c for c in normalized if c.get("labels") and c.get("series")]


def title_and_points(blocks: List[Dict[str, Any]]) -> Tuple[str, List[str]]:
    """从文本块挑标题与正文：优先 role=title，否则取最靠上的一块；文字内容原样不改写。"""
    if not blocks:
        return "", []
    title_block = next((b for b in blocks if b["role"] == "title"), None)
    if title_block is None:
        title_block = min(blocks, key=lambda b: (b["y"], b["x"]))
    return title_block["text"], [b["text"] for b in blocks if b is not title_block]


def reported_native_status(row: Dict[str, Any]) -> str:
    """给 UI 汇报的 native_status：**别把"从未构建"伪造成"待重建"**。

    历史 bug：`GET /slides` 把所有非 ready 的行都报成 `stale` → 刚生成、从未构建过的页在界面角标里
    显示「待按图片重建」（语义错误，这页谈不上"重建"）。
    口径：pending / failed / building 原样返回；ready / legacy_overlay 才可能变 stale。
    """
    raw = row.get("native_status") or "pending"
    if raw in ("pending", "failed", "building"):
        return str(raw)
    return raw if native_scene_is_current(row) else "stale"


def native_scene_is_current(row: Dict[str, Any]) -> bool:
    """旧通用版场景不可再当作“原生可编辑”。图片重生成后也必须重新构建。"""
    try:
        scene = json.loads(row.get("native_scene_json") or "{}")
        if not isinstance(scene, dict):        # 脏数据（"null" / "[]" 之类）不能让接口 500
            return False
        source = scene.get("source_image") or {}
        return (row.get("native_status") == "ready" and scene.get("version") == 2
                and source.get("sha256") == _image_sha256(row.get("image_path") or ""))
    except (OSError, ValueError, TypeError):
        return False


# ────────────────────────── 导出 ──────────────────────────

def do_export(project_id: str, kind: str, require_review: bool = False) -> Dict[str, Any]:
    proj = dict(db.q1("SELECT * FROM projects WHERE id=?", (project_id,)) or {})
    rows = [dict(r) for r in db.q("SELECT * FROM slides WHERE project_id=? AND image_path IS NOT NULL "
                                  "AND status='done' AND keep=1 ORDER BY COALESCE(display_order,page_no)", (project_id,))]
    active_pages = set()
    for task in db.q("SELECT id FROM jobs WHERE project_id=? AND kind='generate' AND status IN ('queued','running','cancelling')", (project_id,)):
        pages = json.loads((get_job(task['id']) or {}).get('pages_json') or '{}')
        active_pages.update(int(no) for no, event in pages.items() if event.get('status') in ('queued', 'running'))
        if not pages:
            active_pages.update(r['page_no'] for r in rows)
    rows = [r for r in rows if r['page_no'] not in active_pages and os.path.isfile(r["image_path"]) and os.path.getsize(r["image_path"])]
    if not rows:
        raise ValueError("还没有任何已生成的页面")
    if require_review and any(r.get("provider") != "import" and r.get("reviewed_image") != r.get("image_path") for r in rows):
        raise ValueError("生成图片待核对，请确认当前结果后导出")
    style = stylepacks.get_style_pack(proj.get("style_pack_id") or "") or {}
    out_dir = os.path.join(config.FILES_DIR, "exports")
    fname = "%s_%s_%s.pptx" % (proj.get("title") or "deck", kind,
                               db.uid("e"))
    out_path = os.path.join(out_dir, re.sub(r"[^\w.\u4e00-\u9fff-]", "_", fname))
    if kind != "image":
        raise ValueError("可编辑版只走「图片转可编辑」的 editppt 精细重建（kind=editable_hi）；旧原生场景导出已下线")
    meta = export_pptx.export_image_pptx(proj, rows, out_path)
    rec = dict(id=db.uid("e"), project_id=project_id, kind=kind, path=out_path, pages=meta["pages"],
               editable_pages_json=json.dumps(meta["editable_pages"]),
               passthrough_pages_json=json.dumps(meta["passthrough_pages"]),
               size_bytes=meta["size_bytes"], created_at=db.now())
    db.insert("exports", rec)
    return dict(kind=kind, file="/files/exports/" + os.path.basename(out_path), pages=meta["pages"],
                editable_pages=meta["editable_pages"], passthrough_pages=meta["passthrough_pages"],
                native_pages=meta.get("editable_pages", []), skipped_pages=meta.get("skipped_pages", []),
                warnings=meta.get("warnings", []), size_bytes=meta["size_bytes"])


def _export_native_pptx(project: Dict[str, Any], rows: List[Dict[str, Any]], out_path: str,
                        tokens: Dict[str, Any]) -> Dict[str, Any]:
    """调用 PptxGenJS。只传入图片分析结果和独立裁片，绝不嵌入整页 PNG。"""
    renderer = os.path.join(config.ROOT, "server", "pptx", "render_native.mjs")
    if not os.path.exists(renderer):
        raise ValueError("原生 PPTX 导出器未安装")
    slides = []
    for row in rows:
        scene = json.loads(row.get("native_scene_json") or "{}")
        if not scene:
            scene = native_scene(row)
        slides.append(dict(page_no=row["page_no"], layout=scene.get("layout") or row.get("layout"),
                           title=scene.get("title") or row.get("title"), outline=scene.get("outline") or row.get("outline"),
                           points=scene.get("points") or json.loads(row.get("points_json") or "[]"),
                           visual=scene.get("visual") or {}, image_assets=scene.get("image_assets") or [],
                           blocks=scene.get("blocks") or [], block_shapes=scene.get("block_shapes") or [],
                           charts=scene.get("charts") or [],
                           source_image=scene.get("source_image") or {}, vision=scene.get("vision") or {}))
    payload = dict(output=out_path, project=dict(id=project.get("id"), title=project.get("title")), tokens=tokens, slides=slides)
    try:
        proc = subprocess.run(["node", renderer], input=json.dumps(payload, ensure_ascii=False), text=True,
                              capture_output=True, timeout=60, check=False)
    except FileNotFoundError as e:
        raise ValueError("未找到 Node.js，无法运行原生 PPTX 导出器") from e
    except subprocess.TimeoutExpired as e:
        raise ValueError("原生 PPTX 导出超时") from e
    if proc.returncode != 0 or not os.path.exists(out_path):
        raise ValueError("原生 PPTX 导出失败：%s" % (proc.stderr or proc.stdout or "未知错误")[:300])
    try:
        result = json.loads(proc.stdout or "{}")
    except json.JSONDecodeError:
        result = {}
    counts = {int(x.get("page_no")): int(x.get("object_count") or 0) for x in result.get("pages", [])}
    render_warnings = {int(x.get("page_no")): [str(w) for w in (x.get("warnings") or [])] for x in result.get("pages", [])}
    all_warnings: List[str] = []
    for r in rows:
        merged = list(dict.fromkeys(json.loads(r.get("native_warnings_json") or "[]") + render_warnings.get(r["page_no"], [])))
        all_warnings.extend(merged)
        db.update("slides", r["id"], dict(native_object_count=counts.get(r["page_no"], r.get("native_object_count") or 0),
                                          native_warnings_json=json.dumps(merged, ensure_ascii=False)))
    return dict(pages=len(rows), editable_pages=[r["page_no"] for r in rows], passthrough_pages=[],
                size_bytes=os.path.getsize(out_path), warnings=list(dict.fromkeys(all_warnings)))


async def run_beautify_page(project_id: str, page_no: int, style_pack_id: str = '', mode: str = '',
                            size: str = '2K', instruction: str = '') -> str:
    """只重生成**指定一页**（非破坏性）：其它页的美图与导出都不动，只在最后重装配图片版。

    与整批 `run_beautify(phase='preview')` 的关键区别：**不清空** beauty/text/work 目录，也不删导出记录。
    """
    from . import beautify
    proj = dict(db.q1('SELECT * FROM projects WHERE id=?', (project_id,)) or {})
    src = proj.get('source_path') or ''
    old = beautify.read_state(project_id)
    if not old or old.get('phase') not in ('preview', 'full', 'done'):
        raise ValueError('请先生成美化预览，再重生成单页')
    if old.get('source') != [beautify.fingerprint(src)]:
        raise ValueError('原稿已变更，请重新生成预览')
    selected = old.get('page_nos') or []
    if page_no not in selected:
        raise ValueError('该页不在本次所选页面内')
    use_mode = mode or old.get('mode') or 'img2img'
    if use_mode not in ('img2img', 'redesign'):
        raise ValueError('mode 只能是 img2img 或 redesign')
    pack = stylepacks.get_style_pack(style_pack_id or old.get('style_pack_id') or proj.get('style_pack_id') or '')
    if not pack or not os.path.isfile(src) or not src.lower().endswith(('.pptx', '.pdf')):
        raise ValueError('请选择有效风格包并上传 PPTX/PDF 原稿')
    if any(j['project_id'] == project_id and j['kind'] in ('beautify', 'beautify_page') and j['status'] in ('running', 'cancelling')
           for j in JOBS.values()):
        raise ValueError('该项目还有美化作业在跑，请等它结束')
    job = new_job(project_id, 'beautify_page', 1)
    await emit(job['id'], dict(type='progress', page=page_no, total=1, stage='render', status='queued', message='等待重生成'))

    async def worker():
        try:
            await emit(job['id'], dict(type='progress', page=page_no, total=1, stage='render', status='running', message='正在渲染原页'))
            rendered = await asyncio.to_thread(beautify.render_origin, project_id, src, page_no)
            page = next((p for p in rendered['pages'] if p['page_no'] == page_no), None)
            if page is None:
                raise ValueError('原稿没有这一页')
            await emit(job['id'], dict(type='progress', page=page_no, total=1, stage='beauty', status='running',
                                       message='正在按你的修改要求重新设计本页' if instruction.strip() else '正在美化页面'))
            text = await asyncio.to_thread(beautify.page_text_source, src, page_no)
            root = beautify.directory(project_id)
            text_dir = root / 'text'
            text_dir.mkdir(parents=True, exist_ok=True)
            (text_dir / f'p{page_no:02d}.json').write_text(json.dumps(text, ensure_ascii=False), encoding='utf-8')
            planned = {p['page_no']: p for p in (beautify.content_plan(project_id, src).get('pages') or [])}
            planned_page = planned.get(page_no)
            page_mode = ('img2img' if planned_page.get('keep_material') else 'redesign') if planned_page else use_mode
            keep_material = bool(planned_page.get('keep_material')) if planned_page else False
            # 归档的是**上一版**图，条目里记的是那一版的修改要求（首次归档为空）
            previous = {p['page_no']: p for p in (old.get('pages') or [])}.get(page_no) or {}
            archived = await asyncio.to_thread(beautify.archive_version, project_id, page_no,
                                               previous.get('instruction') or '')
            res = await asyncio.to_thread(beautify.beautify_page, project_id, page_no, pack.get('tokens') or {}, page_mode, size, text,
                                          keep_material=keep_material, source_path=src, instruction=instruction)
            if is_cancelled(job['id']):
                _job_update(job['id'], status='cancelled', message='已取消')
                await emit(job['id'], dict(type='cancelled', message='已取消重生成'))
                return
            warning = res.get('warning', '')
            db.log_usage(project_id, page_no, 'beautify', res.get('provider', 'local_render'), res.get('model', 'local'),
                         size, res.get('cost_cny', 0), res.get('latency_ms', 0), res['ok'], warning or '单页重生成')
            state = beautify.read_state(project_id) or {}
            if state.get('source') != [beautify.fingerprint(src)]:
                raise ValueError('原稿在生成过程中被替换，已放弃本次结果')
            pages = {p['page_no']: p for p in state.get('pages', [])}
            pages[page_no] = dict(page_no=page_no, origin=page['path'], beauty=res['path'], beauty_ok=res['ok'],
                                  provider=res.get('provider', 'local_render'), model=res.get('model', 'local'),
                                  cost_cny=res.get('cost_cny', 0), latency_ms=res.get('latency_ms', 0),
                                  text_source=text['source'], keep_material=keep_material,
                                  preserved_pictures=int(res.get('preserved_pictures') or 0),
                                  instruction=(instruction or '').strip()[:200],
                                  versions=len(beautify.read_versions(project_id, page_no)),
                                  archived_version=(archived or {}).get('id', ''))
            state['pages'] = [pages[k] for k in sorted(pages)]
            if warning:
                state['warnings'] = (state.get('warnings') or []) + [warning]
            if text['source'] == 'none':
                state['warnings'] = (state.get('warnings') or []) + ['第 %d 页无可用文字真源，未编造文字' % page_no]
            state['updated_at'] = db.now()
            beautify.write_state(project_id, state)
            # 重装配图片版：只包含当前有结果的页，其它页的图不动
            image_path = str(root / 'image.pptx')
            if state.get('exports', {}).get('image') or os.path.isfile(image_path):
                if is_cancelled(job['id']):
                    _job_update(job['id'], status='cancelled', message='已取消')
                    await emit(job['id'], dict(type='cancelled', message='已取消重生成'))
                    return
                await emit(job['id'], dict(type='progress', page=page_no, total=1, stage='assemble', status='running', message='正在重新装配图片版'))
                await asyncio.to_thread(export_pptx.export_image_pptx, proj,
                                        [dict(p, image_path=p['beauty']) for p in state['pages']], image_path)
                state['exports']['image'] = image_path
                beautify.write_state(project_id, state)
                db.x('DELETE FROM exports WHERE project_id=? AND kind=?', (project_id, 'beautify_image'))
                db.insert('exports', dict(id=db.uid('e'), project_id=project_id, kind='beautify_image', path=image_path,
                                          pages=len(state['pages']), editable_pages_json=json.dumps([]),
                                          passthrough_pages_json=json.dumps([p['page_no'] for p in state['pages']]),
                                          size_bytes=os.path.getsize(image_path), created_at=db.now()))
            db.update('projects', project_id, dict(status='done'))
            _job_update(job['id'], status='done', done=1, message='第 %d 页已重新生成' % page_no)
            await emit(job['id'], dict(type='done', file=_files_url(image_path if os.path.isfile(image_path) else res['path']),
                                       message='第 %d 页已重新生成' % page_no))
        except Exception as exc:
            state = beautify.read_state(project_id) or {}
            state['warnings'] = (state.get('warnings') or []) + [str(exc)]
            state['updated_at'] = db.now()
            beautify.write_state(project_id, state)
            _job_update(job['id'], status='failed', message=str(exc))
            await emit(job['id'], dict(type='error', message=str(exc)))

    asyncio.create_task(worker())
    return job['id']


async def run_beautify_restore(project_id: str, page_no: int, version_id: str) -> str:
    """把某一页恢复到指定历史版本：先归档当前图（可再切回），覆盖后重装配图片版。"""
    from . import beautify
    proj = dict(db.q1('SELECT * FROM projects WHERE id=?', (project_id,)) or {})
    state = beautify.read_state(project_id) or {}
    if state.get('phase') not in ('preview', 'full', 'done'):
        raise ValueError('请先生成美化预览，再恢复历史版本')
    if page_no not in (state.get('page_nos') or []):
        raise ValueError('该页不在本次所选页面内')
    if not any(e['id'] == version_id for e in beautify.read_versions(project_id, page_no)):
        raise ValueError('没有这个历史版本')
    if any(j['project_id'] == project_id and j['kind'] in ('beautify', 'beautify_page', 'beautify_editable', 'beautify_restore')
           and j['status'] in ('running', 'cancelling') for j in JOBS.values()):
        raise ValueError('该项目还有美化作业在跑，请等它结束')
    job = new_job(project_id, 'beautify_restore', 1)

    async def worker():
        try:
            await emit(job['id'], dict(type='progress', page=page_no, total=1, stage='beauty', status='running', message='正在恢复该页历史版本'))
            entry = await asyncio.to_thread(beautify.restore_version, project_id, page_no, version_id)
            if is_cancelled(job['id']):
                _job_update(job['id'], status='cancelled', message='已取消')
                await emit(job['id'], dict(type='cancelled', message='已取消恢复'))
                return
            root = beautify.directory(project_id)
            fresh = beautify.read_state(project_id) or state
            pages = {p['page_no']: p for p in fresh.get('pages', [])}
            page = pages.get(page_no)
            if page:
                page['restored_from'] = version_id
                page['instruction'] = entry.get('instruction', '')
                page['versions'] = len(beautify.read_versions(project_id, page_no))
                pages[page_no] = page
                fresh['pages'] = [pages[k] for k in sorted(pages)]
            fresh['updated_at'] = db.now()
            beautify.write_state(project_id, fresh)
            image_path = str(root / 'image.pptx')
            if fresh.get('exports', {}).get('image') or os.path.isfile(image_path):
                await emit(job['id'], dict(type='progress', page=page_no, total=1, stage='assemble', status='running', message='正在重新装配图片版'))
                await asyncio.to_thread(export_pptx.export_image_pptx, proj,
                                        [dict(p, image_path=p['beauty']) for p in fresh['pages']], image_path)
                fresh['exports']['image'] = image_path
                fresh['updated_at'] = db.now()
                beautify.write_state(project_id, fresh)
                db.x('DELETE FROM exports WHERE project_id=? AND kind=?', (project_id, 'beautify_image'))
                db.insert('exports', dict(id=db.uid('e'), project_id=project_id, kind='beautify_image', path=image_path,
                                          pages=len(fresh['pages']), editable_pages_json=json.dumps([]),
                                          passthrough_pages_json=json.dumps([p['page_no'] for p in fresh['pages']]),
                                          size_bytes=os.path.getsize(image_path), created_at=db.now()))
            _job_update(job['id'], status='done', done=1, message='已恢复历史版本')
            await emit(job['id'], dict(type='done', message='已恢复历史版本', page=page_no))
        except Exception as exc:                     # noqa: BLE001 —— 失败要进 SSE，不能吞
            _job_update(job['id'], status='failed', message=str(exc))
            await emit(job['id'], dict(type='error', message=str(exc)))

    asyncio.create_task(worker())
    return job['id']


async def run_beautify_editable(project_id: str, style_pack_id: str = '') -> str:
    """按需把已生成的图片版转成原生可编辑版（image-to-editable-ppt 精细重建）。

    与 full 阶段的区别：**不在生成图片后自动执行**——用户先看到美化结果，需要时再点
    「转文字可编辑版」；产物写 exports.editable，步骤用 SSE 的 prepare/page/finalize 汇报。
    引擎与「图片转可编辑」模块完全一致（editppt CLI + harness/hermes 逐页重建）。
    """
    from . import beautify
    proj = dict(db.q1('SELECT * FROM projects WHERE id=?', (project_id,)) or {})
    src = proj.get('source_path') or ''
    state = beautify.read_state(project_id) or {}
    if state.get('phase') != 'done':
        raise ValueError('请先生成全部页面的美化图，再转可编辑版')
    if state.get('source') != [beautify.fingerprint(src)]:
        raise ValueError('原稿已变更，请重新生成美化预览')
    pages = [p for p in state.get('pages', []) if os.path.isfile(p.get('beauty') or '')]
    if not pages:
        raise ValueError('还没有可用的美化图')
    if not stylepacks.get_style_pack(style_pack_id or state.get('style_pack_id') or proj.get('style_pack_id') or ''):
        raise ValueError('请选择有效风格包')
    if any(j['project_id'] == project_id and j['kind'] in ('beautify', 'beautify_page', 'beautify_editable')
           and j['status'] in ('running', 'cancelling') for j in JOBS.values()):
        raise ValueError('该项目还有美化作业在跑，请等它结束')
    engine = editppt_engine.available()
    if not engine.get('ok'):
        raise ValueError('精细重建引擎不可用：%s' % engine.get('reason'))
    root = beautify.directory(project_id)
    items = []
    for page in pages:
        text_path = root / 'text' / f"p{page['page_no']:02d}.json"
        try:
            text = json.loads(text_path.read_text(encoding='utf-8'))
        except (OSError, ValueError):
            text = await asyncio.to_thread(beautify.page_text_source, src, page['page_no'])
        items.append(dict(page_no=page['page_no'], image_path=page['beauty'],
                          texts=list(text.get('texts') or [])))
    editppt_engine.clear_cancel(project_id)       # 新作业从干净的取消状态开始（否则上次停止会立即取消本次）
    job = new_job(project_id, 'beautify_editable', len(items))

    async def worker():
        loop = asyncio.get_running_loop()

        def on_event(ev: Dict[str, Any]) -> None:
            """引擎跑在线程里，这里把进度安全地送回事件循环（SSE）。"""
            async def _forward() -> None:
                await emit(job['id'], dict(type='progress', **ev))
                if ev.get('done') is not None and ev.get('total'):
                    _job_update(job['id'], done=int(ev['done']), message=str(ev.get('message') or ''))
            try:
                asyncio.run_coroutine_threadsafe(_forward(), loop)
            except RuntimeError:                           # 事件循环已关闭（服务停止）
                pass

        started = time.time()
        try:
            converted = await asyncio.to_thread(
                editppt_engine.convert_items, project_id, items, on_event, project_id, True)
        except Exception as exc:                             # noqa: BLE001
            converted = dict(ok=False, error='%s: %s' % (type(exc).__name__, str(exc)[:200]), run_dir='')
        if is_cancelled(project_id) or converted.get('cancelled'):
            _job_update(job['id'], status='cancelled', message='已取消')
            await emit(job['id'], dict(type='cancelled', message='已取消重建'))
            return
        seconds = round(time.time() - started, 1)
        fresh = beautify.read_state(project_id) or dict(state)
        info = dict(ok=bool(converted.get('ok')), engine='editppt',
                    run_dir=converted.get('run_dir', ''), seconds=seconds,
                    pages=len(items), warnings=list(converted.get('warnings') or []),
                    message=str(converted.get('error') or '')[:300] if not converted.get('ok') else '')
        fresh['editable_engine'] = info
        fresh['warnings'] = list(fresh.get('warnings') or []) + list(info['warnings'])
        editable = str(root / 'full.pptx')
        if converted.get('ok'):
            shutil.copyfile(str(converted['deck']), editable)
            fresh.setdefault('exports', {})['editable'] = editable
            db.x('DELETE FROM exports WHERE project_id=? AND kind=?', (project_id, 'beautify_editable'))
            db.insert('exports', dict(id=db.uid('e'), project_id=project_id, kind='beautify_editable', path=editable,
                      pages=len(pages), editable_pages_json=json.dumps([p['page_no'] for p in pages]),
                      passthrough_pages_json=json.dumps([]), size_bytes=os.path.getsize(editable), created_at=db.now()))
        fresh['updated_at'] = db.now()
        beautify.write_state(project_id, fresh)
        _job_update(job['id'], status='done' if converted.get('ok') else 'failed', done=len(items),
                    message=info['message'] or ('完成 %d 页精细重建' % len(pages) if converted.get('ok') else '精细重建失败'))
        await emit(job['id'], dict(type='done' if converted.get('ok') else 'error',
                   file=_files_url(editable) if converted.get('ok') else '',
                   message=info['message'], warnings=fresh['warnings'],
                   failures=converted.get('failures') or []))

    async def guarded_worker():
        try:
            await worker()
        except Exception as exc:                             # noqa: BLE001
            message = '重建产物保存失败：' + str(exc)[:300]
            _job_update(job['id'], status='failed', message=message)
            await emit(job['id'], dict(type='error', message=message))

    asyncio.create_task(guarded_worker())
    return job['id']


async def run_beautify(project_id: str, style_pack_id: str, phase: str = 'preview',
                       mode: str = 'img2img', preview_pages: int = 3, size: str = '2K', page_nos=None) -> str:
    from . import beautify
    proj = dict(db.q1('SELECT * FROM projects WHERE id=?', (project_id,)) or {})
    src = proj.get('source_path') or ''
    pack = stylepacks.get_style_pack(style_pack_id)
    if not pack or not os.path.isfile(src) or not src.lower().endswith(('.pptx', '.pdf')):
        raise ValueError('请选择有效风格包并上传 PPTX/PDF 原稿')
    if phase not in ('preview', 'full') or mode not in ('img2img', 'redesign') or not 1 <= preview_pages <= 3:
        raise ValueError('阶段、模式或预览页数无效（预览 1–3 页）')
    if any(j['project_id'] == project_id and j['kind'] == 'beautify' and j['status'] in ('running', 'cancelling') for j in JOBS.values()):
        raise ValueError('美化作业正在运行')
    old = beautify.read_state(project_id)
    source = [beautify.fingerprint(src)]
    if phase == 'full' and (old.get('phase') != 'preview' or not (old.get('exports', {}).get('image') or old.get('cancelled')) or old.get('source') != source
                            or old.get('style_pack_id') != style_pack_id or old.get('mode') != mode):
        raise ValueError('请先完成同一原稿、风格和模式的预览')
    count = await asyncio.to_thread(beautify.page_count, src)
    # Recheck after the await: a concurrent request may have started a job.
    if any(j['project_id'] == project_id and j['kind'] == 'beautify' and j['status'] in ('running', 'cancelling') for j in JOBS.values()):
        raise ValueError('美化作业正在运行')
    with beautify.CONTENT_LOCK:
        if not count:
            raise ValueError('原稿没有页面')
        selected = beautify.validate_page_nos(page_nos, count, page_nos is not None)
        plan = beautify.content_plan(project_id, src)
        signature = beautify.content_signature(plan)
        if plan and selected != plan['page_nos']:
            raise ValueError('选页已变更，请重新确认内容')
        if phase == 'full' and old.get('content_signature', '') != signature:
            raise ValueError('内容或保留原图设置已变更，请重新生成预览')
        planned = {p['page_no']: p for p in plan.get('pages', [])}
        wanted = selected[:preview_pages] if phase == 'preview' else selected
        available = {p['page_no'] for p in old.get('pages', []) if os.path.isfile(p.get('beauty') or '')}
        total = len(wanted) if phase == 'preview' else len(set(wanted) - available)
        job = new_job(project_id, 'beautify', max(0, total))
        resume = old.get('cancelled') and old.get('source') == source and old.get('style_pack_id') == style_pack_id and old.get('mode') == mode and old.get('content_signature', '') == signature
        state = dict(old) if phase == 'full' or resume else {}
        state.update(phase='preview', cancelled=False, mode=mode, style_pack_id=style_pack_id, style_pack_name=pack.get('name', ''),
                     source=source, page_count=count, page_nos=selected, confirmed=phase == 'full', warnings=state.get('warnings', []),
                     exports=dict(state.get('exports', {})), editable_engine=None, updated_at=db.now())
        state['content_signature'] = signature
        root = beautify.directory(project_id)
        if phase == 'preview' and not resume:
            for name in ('beauty', 'text', 'work'):
                import shutil
                shutil.rmtree(root / name, ignore_errors=True)
        if phase == 'preview' and not resume:
            for name in ('preview.pptx', 'full.pptx', 'image.pptx'):
                (root / name).unlink(missing_ok=True)
            db.x('DELETE FROM exports WHERE project_id=? AND kind IN (?,?)',
                       (project_id, 'beautify_editable', 'beautify_image'))
        beautify.write_state(project_id, state)
        db.update('projects', project_id, dict(status='generating', style_pack_id=style_pack_id))

    async def progress(stage, page=0, message=''):
        await emit(job['id'], dict(type='progress', page=page, total=total, stage=stage, status='running', message=message))

    async def cancelled():
        if not is_cancelled(job['id']):
            return False
        state.update(cancelled=True, updated_at=db.now())
        beautify.write_state(project_id, state)
        db.update('projects', project_id, dict(status='cancelled'))
        _job_update(job['id'], status='cancelled', message='已取消')
        await emit(job['id'], dict(type='cancelled', message='已取消生成'))
        return True

    async def worker():
        try:
            await progress('render', message='正在渲染原稿')
            rendered = await asyncio.to_thread(beautify.render_origin, project_id, src,
                                               max(wanted))
            state['rendered'] = len(rendered['pages'])
            if await cancelled():
                return
            previous = {p['page_no']: p for p in state.get('pages', []) if p['page_no'] in wanted}
            semaphore = asyncio.Semaphore(max(1, min(BEAUTIFY_CONCURRENCY, len(wanted))))
            async def page_task(page):
                if is_cancelled(job['id']):
                    return None
                n = page['page_no']
                if n in previous and os.path.isfile(previous[n].get('beauty') or ''):
                    return previous[n]
                async with semaphore:
                    if is_cancelled(job['id']):
                        return None
                    await progress('beauty', n, '正在美化页面')
                    text = planned.get(n) or await asyncio.to_thread(beautify.page_text_source, src, n)
                    text_dir = root / 'text'
                    text_dir.mkdir(parents=True, exist_ok=True)
                    (text_dir / f'p{n:02d}.json').write_text(json.dumps(text, ensure_ascii=False), encoding='utf-8')
                    if is_cancelled(job['id']):
                        return None
                    page_mode = ('img2img' if text['keep_material'] else 'redesign') if n in planned else mode
                    keep_material = bool(text.get('keep_material')) if n in planned else False
                    res = await asyncio.to_thread(beautify.beautify_page, project_id, n, pack.get('tokens') or {}, page_mode, size, text,
                                                  keep_material=keep_material, source_path=src)
                    warning = res.get('warning', '')
                    if warning:
                        state['warnings'].append(warning)
                    if text['source'] == 'none':
                        state['warnings'].append(f'第 {n} 页无可用文字真源，未编造文字')
                    db.log_usage(project_id, n, 'beautify', res.get('provider', 'local_render'), res.get('model', 'local'),
                                 size, res.get('cost_cny', 0), res.get('latency_ms', 0), res['ok'], warning)
                    row = dict(page_no=n, origin=page['path'], beauty=res['path'], beauty_ok=res['ok'],
                               provider=res.get('provider', 'local_render'), model=res.get('model', 'local'),
                               cost_cny=res.get('cost_cny', 0), latency_ms=res.get('latency_ms', 0), text_source=text['source'],
                               keep_material=keep_material,
                               preserved_pictures=int(res.get('preserved_pictures') or 0))
                    previous[n] = row
                    state['pages'] = [previous[k] for k in sorted(previous)]
                    state['updated_at'] = db.now()
                    beautify.write_state(project_id, state)
                    _job_update(job['id'], done=len(set(previous) - available) if phase == 'full' else len(previous))
                    return row
            pages = await asyncio.gather(*(page_task(p) for p in rendered['pages'] if p['page_no'] in wanted))
            if await cancelled():
                return
            pages = [previous[k] for k in sorted(previous)]
            state['pages'] = pages
            items = [dict(page_no=p['page_no'], image=p['beauty'],
                          text=json.loads((root / 'text' / f"p{p['page_no']:02d}.json").read_text(encoding='utf-8'))) for p in pages]
            await progress('assemble', message='正在生成图片版')
            image_path = str(root / 'image.pptx')
            export_pptx.export_image_pptx(proj, [dict(p, image_path=p['beauty']) for p in pages], image_path)
            state['exports']['image'] = image_path
            def register(kind, path, editable):
                db.insert('exports', dict(id=db.uid('e'), project_id=project_id, kind=kind, path=path, pages=len(pages),
                          editable_pages_json=json.dumps([p['page_no'] for p in pages] if editable else []),
                          passthrough_pages_json=json.dumps([] if editable else [p['page_no'] for p in pages]),
                          size_bytes=os.path.getsize(path), created_at=db.now()))
            db.x('DELETE FROM exports WHERE project_id=? AND kind=?', (project_id, 'beautify_image'))
            register('beautify_image', image_path, False)
            if await cancelled():
                return
            converted = dict(ok=True, message='')
            editable = image_path
            if phase == 'full':
                # 转可编辑版改为**按需**：先生成图片、让用户看结果，需要时再点「转文字可编辑版」
                # （POST /api/projects/{id}/beautify/editable），不在这一步自动跑精细重建。
                state['editable_engine'] = dict(ok=False, engine='editppt', message='尚未转换：需要时可点「转文字可编辑版」按需转换')
            state['phase'] = 'preview' if phase == 'preview' else 'done'
            state['updated_at'] = db.now()
            beautify.write_state(project_id, state)
            db.update('projects', project_id, dict(status='done'))
            _job_update(job['id'], status='done' if converted['ok'] else 'failed', done=total, message=converted['message'])
            await emit(job['id'], dict(type='done' if converted['ok'] else 'error',
                       file=_files_url(editable if converted['ok'] else image_path),
                       message=converted['message'], warnings=state['warnings']))
        except Exception as exc:
            state['warnings'].append(str(exc))
            state['editable_engine'] = dict(ok=False, engine='editppt', message=str(exc))
            state['updated_at'] = db.now()
            beautify.write_state(project_id, state)
            db.update('projects', project_id, dict(status='failed'))
            _job_update(job['id'], status='failed', message=str(exc))
            await emit(job['id'], dict(type='error', message=str(exc)))
    asyncio.create_task(worker())
    return job['id']
