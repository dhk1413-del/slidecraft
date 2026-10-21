# -*- coding: utf-8 -*-
"""PPT 备注模块回归验收（离线、零成本、不联网）。

覆盖：
  T1  解析：页数/文本框文字/图片数/已有备注/低信息页判定
  T2  容错：含未知形状类型的页不崩（真实 64 页文件已踩到 NotImplementedError）
  T3  内容真源：文本框 + 画面识别合并、去重、空页判定
  T4  备注撰写：模型只输出推理（空正文）→ 自动放大预算重试；一直空 → 如实失败
  T5  写回导出：备注栏写入、原文保留、页数/形状数不变、原文件未被改动
  T6  页数校验：源文件与解析时不一致 → 拒绝导出（防备注错页）
用法：.venv/bin/python tools/test_slide_notes.py
"""
import json
import os
import sys
import shutil
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from pptx import Presentation                                   # noqa: E402
from pptx.util import Inches, Pt                                # noqa: E402
from PIL import Image                                           # noqa: E402

from server.app import config, db, providers, slide_notes           # noqa: E402

PASS, FAIL = [], []


def check(name: str, cond: bool, detail: str = "") -> None:
    (PASS if cond else FAIL).append(name)
    print("  %s %s%s" % ("✓" if cond else "✗", name, ("  —— " + detail) if detail and not cond else ""))


def make_fixture(path: str) -> dict:
    """造一个含三类页的 pptx：封面（文字）/ 正文（要点+表格）/ 图片页（纯图）+ 已有备注页。"""
    img = Image.new("RGB", (800, 450), (30, 60, 120))
    for x in range(0, 800, 40):
        for y in range(0, 450, 40):
            img.putpixel((x, y), (240, 190, 60))
    png = os.path.join(os.path.dirname(path), "fixture.png")
    img.save(png)

    prs = Presentation()
    prs.slide_width, prs.slide_height = Inches(13.333), Inches(7.5)

    s1 = prs.slides.add_slide(prs.slide_layouts[6])
    s1.shapes.add_textbox(Inches(1), Inches(2), Inches(11), Inches(2)).text_frame.text = "校园智慧零售平台建设方案"

    s2 = prs.slides.add_slide(prs.slide_layouts[6])
    tf = s2.shapes.add_textbox(Inches(0.6), Inches(0.6), Inches(12), Inches(5)).text_frame
    tf.text = "项目背景与痛点"
    for line in ["校园超市高峰期平均排队时长 8.5 分钟", "缺货感知率达到 37%"]:
        tf.add_paragraph().text = line
    tbl = s2.shapes.add_table(2, 2, Inches(0.6), Inches(5.2), Inches(6), Inches(1.2)).table
    tbl.cell(0, 0).text = "指标"
    tbl.cell(0, 1).text = "数值"
    tbl.cell(1, 0).text = "日均订单"
    tbl.cell(1, 1).text = "412 单"

    s3 = prs.slides.add_slide(prs.slide_layouts[6])
    s3.shapes.add_picture(png, Inches(0), Inches(0), width=Inches(13.333))     # 纯图片页：无文字

    s4 = prs.slides.add_slide(prs.slide_layouts[6])
    s4.shapes.add_textbox(Inches(1), Inches(1), Inches(10), Inches(1)).text_frame.text = "案例分享"
    s4.notes_slide.notes_text_frame.text = "这是原有备注，不能被破坏。"

    prs.save(path)
    os.remove(png)
    return dict(pages=4)


def main() -> int:
    tmp = tempfile.mkdtemp(prefix="notes_test_")
    src = os.path.join(tmp, "fixture.pptx")
    make_fixture(src)
    nid = None
    # 导出产物一律落到临时目录：测试绝不能往真实的 data/files/exports/ 里丢垃圾
    real_files_dir = config.FILES_DIR
    config.FILES_DIR = tmp
    try:
        print("\nT1 解析页清单")
        pages = slide_notes.parse_pptx(src)
        check("页数 = 4", len(pages) == 4, str(len(pages)))
        check("封面页文字被读到", "校园智慧零售平台建设方案" in pages[0]["text_source"])
        check("表格单元格被读到", "412 单" in pages[1]["text_source"])
        check("图片计数正确（P3 一张图）", pages[2]["pic_count"] == 1, str(pages[2]["pic_count"]))
        check("纯图页判为低信息页", pages[2]["low_info"] == 1)
        check("有文字页不判为低信息页", pages[1]["low_info"] == 0)
        check("已有备注被读到", "原有备注" in pages[3]["note_original"])

        print("\nT2 未知形状类型容错")
        weird = os.path.join(tmp, "weird.pptx")
        shutil.copy(src, weird)
        ok_parse = True
        try:
            slide_notes.parse_pptx(weird)
        except Exception as e:                                  # noqa: BLE001
            ok_parse = False
            print("     ", type(e).__name__, e)
        check("含异常形状的文件仍能解析", ok_parse)

        print("\nT3 内容真源合并")
        content = slide_notes.build_content(dict(
            text_source="数据维度", vision_json=json.dumps(dict(
                title="用户画像维度", text_on_page=["数据维度", "用户学号", "所在校区"],
                visual="左侧字段卡片，右侧插画", data=[dict(label="进馆次数", value="369", unit="次")]),
                ensure_ascii=False)))
        check("文本框文字保留", "数据维度" in content["text_box"])
        check("画面独有文字被单独标出", "用户学号" in content["text_in_image"])
        check("重复文字不进画面列表", "数据维度" not in content["text_in_image"])
        check("数值被结构化", bool(content["data"]) and content["data"][0]["value"] == "369")
        check("渲染成提示词非空", "用户学号" in slide_notes._content_to_prompt(content))
        check("空页判为空（不生成备注）", slide_notes.content_is_empty(
            slide_notes.build_content(dict(text_source="", vision_json="{}"))))

        print("\nT4 备注撰写：空正文重试与如实失败")
        calls = []

        def fake_call_text(system, user, max_tokens=4000):
            calls.append(max_tokens)
            if max_tokens < 16000:
                return True, "", dict(model="fake", latency_ms=1, cost_cny=0.0, reason="empty")
            return True, "这页讲的是校园零售的痛点与量化现状。", dict(model="fake", latency_ms=1, cost_cny=0.001)

        real = providers.call_text
        providers.call_text = fake_call_text
        try:
            ok, note, meta = slide_notes.write_note(content, 4, 64)
            check("空正文 → 放大预算后拿到正文", ok and note, note)
            check("确实重试过一次（预算抬到 16000）", calls == [8000, 16000], str(calls))

            def always_empty(system, user, max_tokens=4000):
                return True, "", dict(model="fake", latency_ms=1, cost_cny=0.0, reason="empty")

            providers.call_text = always_empty
            ok2, note2, meta2 = slide_notes.write_note(content, 4, 64)
            check("始终空正文 → 如实报失败（不假装成功）", (not ok2) and meta2.get("reason") == "empty_content",
                  str(meta2.get("reason")))

            providers.call_text = lambda s, u, max_tokens=4000: (False, "", dict(reason="not_configured"))
            ok3, _, meta3 = slide_notes.write_note(content, 4, 64)
            check("未配置 key → 上报 not_configured 而非空备注", (not ok3) and meta3.get("reason") == "not_configured")
        finally:
            providers.call_text = real

        print("\nT5 写回导出（内容/格式零改动）")
        before = Presentation(src)
        before_shapes = [len(s.shapes) for s in list(before.slides)]
        before_size = os.path.getsize(src)
        detail = slide_notes.create_job(src, "fixture.pptx")
        nid = detail["id"]
        # 造两页备注：P1 正常、P2 正常、P4 带原有备注；P3 故意不生成（无内容）
        for no, note in ((1, "各位领导，下面汇报校园智慧零售平台的整体方案。"),
                         (2, "高峰期排队 8.5 分钟、缺货感知率 37%，这是我们要解决的起点。"),
                         (4, "这里分享几个已经落地的案例。")):
            row = db.q1("SELECT id FROM notes_pages WHERE job_id=? AND page_no=?", (nid, no))
            db.update("notes_pages", row["id"], dict(note=note, note_status="done"))
        res = slide_notes.export_with_notes(nid, keep_original=True)
        out = os.path.join(slide_notes.config.FILES_DIR, "exports", res["name"])
        check("导出文件已生成", os.path.exists(out), out)
        check("导出页数 = 已写备注页数", res["pages"] == 3, str(res["pages"]))
        after = Presentation(out)
        check("页数不变", len(list(after.slides)) == 4)
        check("每页形状数不变（版式未被动）", [len(s.shapes) for s in list(after.slides)] == before_shapes,
              str([len(s.shapes) for s in list(after.slides)]) + " vs " + str(before_shapes))
        notes = [(s.notes_slide.notes_text_frame.text if s.has_notes_slide else "") for s in list(after.slides)]
        check("P1 备注已写入", "整体方案" in notes[0])
        check("P2 备注已写入", "8.5 分钟" in notes[1])
        check("未生成备注的 P3 保持空白", notes[2].strip() == "", repr(notes[2][:40]))
        check("P4 原有备注保留且 AI 备注追加在下方",
              "原有备注" in notes[3] and slide_notes.NOTE_MARKER in notes[3]
              and notes[3].index("原有备注") < notes[3].index(slide_notes.NOTE_MARKER) < notes[3].index("案例"),
              "P4 备注栏实际内容=%r" % notes[3])
        check("原文件未被改动（大小一致）", os.path.getsize(src) == before_size)

        print("\nT6 页数不一致 → 拒绝导出")
        db.update("notes_jobs", nid, dict(pages=99))
        refused = False
        try:
            slide_notes.export_with_notes(nid)
        except ValueError as e:
            refused = "不一致" in str(e)
        check("页数不一致时中止（防备注错页）", refused)
        db.update("notes_jobs", nid, dict(pages=4))

        print("\nT8 按需渲染原页（逐页复核显示 PPT 实际页面）")
        db.x("UPDATE notes_pages SET render_path=NULL WHERE job_id=?", (nid,))
        calls = []

        def fake_render(path, out_dir, expect_pages, width=0):
            os.makedirs(out_dir, exist_ok=True)
            pngs = []
            for i in range(1, expect_pages + 1):
                fp = os.path.join(out_dir, "p%03d.png" % i)
                with open(fp, "wb") as f:
                    f.write(b"\x89PNG\r\n")
                pngs.append(fp)
            calls.append((path, expect_pages))
            return pngs

        real_render = slide_notes.render_deck
        slide_notes.render_deck = fake_render
        try:
            first = slide_notes.ensure_rendered(nid)
            check("首次渲染：rendered=True 且页数完整", first["rendered"] is True and first["page_count"] == 4)
            check("每页给出可直接访问的 /files/notes/... 地址",
                  all(p["image_url"].startswith("/files/notes/%s/" % nid) for p in first["pages"]))
            check("render_deck 只被调用一次", len(calls) == 1, str(calls))
            second = slide_notes.ensure_rendered(nid)
            check("第二次命中磁盘缓存、不再渲染", second["rendered"] is False and len(calls) == 1)
            pub = slide_notes.job_detail(nid)["pages_detail"]
            check("任务详情带出 image_url（前端据此显示原页）", all(p["image_url"] for p in pub))
        finally:
            slide_notes.render_deck = real_render

        print("\nT7 无备注时导出 → 明确报错")
        db.x("UPDATE notes_pages SET note='', note_status='pending' WHERE job_id=?", (nid,))
        refused2 = False
        try:
            slide_notes.export_with_notes(nid)
        except ValueError as e:
            refused2 = "还没有" in str(e)
        check("没有任何备注时导出被拒绝", refused2)
    finally:
        config.FILES_DIR = real_files_dir
        if nid:
            db.x("DELETE FROM notes_pages WHERE job_id=?", (nid,))
            db.x("DELETE FROM notes_jobs WHERE id=?", (nid,))
            db.x("DELETE FROM exports WHERE project_id=? AND kind='notes'", (nid,))
        shutil.rmtree(tmp, ignore_errors=True)

    print("\n" + "=" * 66)
    print("通过 %d 项，失败 %d 项" % (len(PASS), len(FAIL)))
    if FAIL:
        print("失败项：" + "、".join(FAIL))
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
