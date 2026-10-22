"""内容梳理「删除此页 + 撤销」回归（离线、函数级）。

需求（用户 2026-10-22）：③内容梳理的页面标题栏要有删除功能，点击后删除该页，带确认弹窗与撤销。
实现口径：硬删除 + 快照恢复（不引入 deleted 列）。本回归锁定：
  · 删除后页面真的消失、剩余页码重排为 1..N、项目 page_drafts/target_pages 同步、内容确认失效
  · 删除返回的快照带完整内容，撤销后按原页码插回且标题/摘要/原文不变
  · 至少保留 1 页的约束
"""
import json
import os
import sys
import tempfile

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, ROOT)

TMP = tempfile.mkdtemp(prefix="df-slide-del-")
os.environ["DECKFORGE_DATA"] = TMP
os.environ.setdefault("DECKFORGE_SKIP_AGENT_INSTALL", "1")

from fastapi import HTTPException  # noqa: E402

from server.app import db, main  # noqa: E402

PASS, FAIL = [], []


def check(name, ok, detail=""):
    (PASS if ok else FAIL).append(name)
    print("  %s %s%s" % ("✅" if ok else "❌", name, (" — " + detail) if detail else ""))


def make_project(titles):
    db.init_db()
    pid = db.uid("p_test")
    db.insert("projects", dict(id=pid, title="删页回归", source_type="md", intake_mode="doc",
                               style_pack_id="tech-deepblue", status="outlined", created_at=db.now(),
                               content_confirmed_at=db.now(), target_pages=len(titles)))
    ids = []
    for no, title in enumerate(titles, 1):
        sid = db.uid("s")
        db.insert("slides", dict(id=sid, project_id=pid, page_no=no, display_order=no, title=title,
                                 role="content", layout="cards_4", outline="摘要-" + title,
                                 points_json=json.dumps(["原文-" + title], ensure_ascii=False),
                                 must_keep_json="[]", modules_json="[]", content_revision=1, keep=1,
                                 status="pending", created_at=db.now(), updated_at=db.now()))
        ids.append(sid)
    main._sync_pages_after_mutation(pid)
    return pid, ids


def titles(pid):
    return [r["title"] for r in db.q("SELECT title FROM slides WHERE project_id=? ORDER BY page_no", (pid,))]


def pages(pid):
    return [r["page_no"] for r in db.q("SELECT page_no FROM slides WHERE project_id=? ORDER BY page_no", (pid,))]


def main_():
    pid, ids = make_project(["第一章", "第二章", "第三章"])

    print("[1] 删除第 2 页：剩 2 页、页码重排 1..2、项目侧同步")
    res = main.delete_slide(pid, ids[1])
    check("返回删除前快照", res["deleted"]["title"] == "第二章" and res["page_no"] == 2, json.dumps(res["deleted"], ensure_ascii=False)[:60])
    check("页面已消失", titles(pid) == ["第一章", "第三章"], str(titles(pid)))
    check("页码重排为 1..2", pages(pid) == [1, 2], str(pages(pid)))
    project = db.q1("SELECT target_pages, page_drafts_json, content_confirmed_at FROM projects WHERE id=?", (pid,))
    drafts = json.loads(project["page_drafts_json"] or "[]")
    check("项目 target_pages = 2", project["target_pages"] == 2, str(project["target_pages"]))
    check("page_drafts 同步为 2 条", len(drafts) == 2 and [d["title"] for d in drafts] == ["第一章", "第三章"],
          str([d["title"] for d in drafts]))
    check("内容确认已失效（需重新确认）", not (project["content_confirmed_at"] or ""),
          repr(project["content_confirmed_at"]))

    print("[2] 撤销删除：按原页码插回，内容逐字段还原")
    main.restore_deleted_slide(pid, dict(page=res["deleted"], page_no=res["page_no"]))
    check("页面已恢复且顺序正确", titles(pid) == ["第一章", "第二章", "第三章"], str(titles(pid)))
    check("页码恢复为 1..3", pages(pid) == [1, 2, 3], str(pages(pid)))
    restored = db.q1("SELECT * FROM slides WHERE project_id=? AND page_no=2", (pid,))
    check("标题/摘要/原文逐字段还原",
          restored["title"] == "第二章" and restored["outline"] == "摘要-第二章"
          and json.loads(restored["points_json"]) == ["原文-第二章"],
          json.dumps(dict(title=restored["title"], outline=restored["outline"]), ensure_ascii=False))
    check("恢复的是新的 slide_id（旧 id 不复用）", restored["id"] not in ids, restored["id"])

    print("[3] 至少保留 1 页：只剩 1 页时拒绝删除")
    del_res = main.delete_slide(pid, db.q1("SELECT id FROM slides WHERE project_id=? AND page_no=2", (pid,))["id"])
    main.delete_slide(pid, db.q1("SELECT id FROM slides WHERE project_id=? AND page_no=2", (pid,))["id"])
    remaining = db.q1("SELECT id FROM slides WHERE project_id=?", (pid,))
    raised = False
    try:
        main.delete_slide(pid, remaining["id"])
    except HTTPException as exc:
        raised = exc.status_code == 400
    check("只剩 1 页时返回 400", raised)
    check("该页仍在", len(db.q("SELECT id FROM slides WHERE project_id=?", (pid,))) == 1)


if __name__ == "__main__":
    print("== 内容梳理删除此页 / 撤销 回归 ==")
    main_()
    print("\n%d 通过 / %d 失败" % (len(PASS), len(FAIL)))
    if FAIL:
        print("失败项：", FAIL)
        sys.exit(1)
