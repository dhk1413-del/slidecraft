"""②编辑大纲 ⇄ ③内容梳理 页集合对账回归（离线、函数级）。

用户反馈（2026-10-22）：在编辑大纲里删除或新增的页面，内容梳理对不上（删了还在、加了不出现）。
根因：PUT /pages 只按 page_no 更新已有 slides，新增页不创建、删掉的页不删；
且按 page_no 匹配时，删中间页会让后面的页内容张冠李戴。

本回归锁定 put_pages 的对账语义（按 slide_id）：
  · 删页 → 那一行被删、页码重排、**幸存页内容不串位**
  · 新增页 → 建出 slides 行（source_available=1、keep=1，能出现在内容梳理/生成清单）
  · 重排 → 只改 page_no/display_order，内容跟着 slide 走
"""
import json
import os
import sys
import tempfile

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, ROOT)

TMP = tempfile.mkdtemp(prefix="df-pages-reconcile-")
os.environ["DECKFORGE_DATA"] = TMP
os.environ.setdefault("DECKFORGE_SKIP_AGENT_INSTALL", "1")

from server.app import db, main  # noqa: E402

PASS, FAIL = [], []


def check(name, ok, detail=""):
    (PASS if ok else FAIL).append(name)
    print("  %s %s%s" % ("✅" if ok else "❌", name, (" — " + detail) if detail else ""))


def make_project(titles):
    db.init_db()
    pid = db.uid("p_test")
    db.insert("projects", dict(id=pid, title="页集合对账", source_type="md", intake_mode="doc",
                               style_pack_id="tech-deepblue", status="outlined", created_at=db.now(),
                               target_pages=len(titles)))
    rows = []
    for no, title in enumerate(titles, 1):
        sid = db.uid("s")
        db.insert("slides", dict(id=sid, project_id=pid, page_no=no, display_order=no, title=title,
                                 role="content", layout="cards_4", outline="摘要-" + title,
                                 points_json=json.dumps(["原文-" + title], ensure_ascii=False),
                                 must_keep_json="[]", modules_json="[]", content_revision=1, keep=1,
                                 source_available=1, status="pending",
                                 created_at=db.now(), updated_at=db.now()))
        rows.append(dict(id=sid, page_no=no, title=title))
    return pid, rows


def payload_from_slides(pid, extra=None, drop_page_no=None):
    """按当前 slides 构造 PUT /pages 的载荷（模拟前端大纲编辑器提交）。"""
    out = []
    for row in db.q("SELECT * FROM slides WHERE project_id=? ORDER BY page_no", (pid,)):
        if drop_page_no is not None and row["page_no"] == drop_page_no:
            continue
        out.append(dict(slide_id=row["id"], page_no=row["page_no"], title=row["title"], role=row["role"],
                        keep=bool(row["keep"]), layout=row["layout"], revision=row["content_revision"],
                        chapter_no=row["chapter_no"] or 0, chapter_title=row["chapter_title"] or "",
                        outline=row["outline"] or "", points=json.loads(row["points_json"] or "[]")))
    if extra:
        out.extend(extra)
    for index, page in enumerate(sorted(out, key=lambda p: p["page_no"]), 1):
        page["page_no"] = index
    return out


def titles(pid):
    return [(r["page_no"], r["title"]) for r in db.q("SELECT page_no, title FROM slides WHERE project_id=? ORDER BY page_no", (pid,))]


def main_():
    pid, rows = make_project(["第一章", "第二章", "第三章"])

    print("[1] 删除中间页：剩下的页内容不能串位")
    main.put_pages(pid, dict(pages=payload_from_slides(pid, drop_page_no=2)))
    check("页集合变为 第一章/第三章", [t for _, t in titles(pid)] == ["第一章", "第三章"], str(titles(pid)))
    check("页码重排为 1/2", [no for no, _ in titles(pid)] == [1, 2], str(titles(pid)))
    third = db.q1("SELECT * FROM slides WHERE project_id=? AND page_no=2", (pid,))
    check("幸存页仍是「第三章」且摘要/原文未被覆盖",
          third["title"] == "第三章" and third["outline"] == "摘要-第三章"
          and json.loads(third["points_json"]) == ["原文-第三章"],
          "%s / %s / %s" % (third["title"], third["outline"], third["points_json"]))
    check("被删页的 slide 行已不存在", not db.q1("SELECT id FROM slides WHERE id=?", (rows[1]["id"],)))
    project = db.q1("SELECT target_pages FROM projects WHERE id=?", (pid,))
    check("项目 target_pages 同步为 2", project["target_pages"] == 2, str(project["target_pages"]))

    print("[2] 新增页：编辑大纲里加的一页要真的建成 slides（内容梳理/生成都能看到）")
    new_page = dict(slide_id=None, page_no=2, title="新增过渡页", role="section", keep=True, layout="section",
                    revision=None, chapter_no=1, chapter_title="第一章",
                    outline="过渡到第二章", points=["承上启下"])
    payload = payload_from_slides(pid)
    payload.insert(1, new_page)          # 插到第 2 位（按列表顺序，不靠撞 page_no）
    for index, page in enumerate(payload, 1):
        page["page_no"] = index
    res = main.put_pages(pid, dict(pages=payload))
    check("后端报告新增 1 页", res.get("created") == 1, str(res.get("created")))
    check("页集合为 第一章/新增过渡页/第三章", [t for _, t in titles(pid)] == ["第一章", "新增过渡页", "第三章"], str(titles(pid)))
    created = db.q1("SELECT * FROM slides WHERE project_id=? AND title=?", (pid, "新增过渡页"))
    check("新页 source_available=1（否则会被 valid/keep 过滤掉）", created and created["source_available"] == 1,
          str(created["source_available"]) if created else "缺失")
    check("新页 keep=1（能进内容梳理与生成清单）", created and created["keep"] == 1,
          str(created["keep"]) if created else "缺失")
    check("新页内容落库", created and created["outline"] == "过渡到第二章"
          and json.loads(created["points_json"]) == ["承上启下"])

    print("[3] 重排：只动页码，内容跟着 slide 走")
    payload = payload_from_slides(pid)
    first = [p for p in payload if p["title"] == "第一章"][0]
    thirdp = [p for p in payload if p["title"] == "第三章"][0]
    first["page_no"], thirdp["page_no"] = thirdp["page_no"], first["page_no"]
    for index, page in enumerate(sorted(payload, key=lambda p: p["page_no"]), 1):
        page["page_no"] = index
    main.put_pages(pid, dict(pages=payload))
    check("顺序按提交的来", [t for _, t in titles(pid)] == ["第三章", "新增过渡页", "第一章"], str(titles(pid)))
    moved = db.q1("SELECT * FROM slides WHERE project_id=? AND title=?", (pid, "第三章"))
    check("移动后内容仍属「第三章」", moved["outline"] == "摘要-第三章" and json.loads(moved["points_json"]) == ["原文-第三章"])


if __name__ == "__main__":
    print("== 编辑大纲 ⇄ 内容梳理 页集合对账回归 ==")
    main_()
    print("\n%d 通过 / %d 失败" % (len(PASS), len(FAIL)))
    if FAIL:
        print("失败项：", FAIL)
        sys.exit(1)
