"""「编辑大纲 → 内容梳理」内容同步回归（离线、纯函数级）。

历史 bug（用户 2026-10-22 反馈）：在②编辑大纲里改过的页面标题/摘要/原文，进③内容梳理后看不到。
根因有两处：
  1. 前端 pagePayload() 只提交 title/keep/layout/章节，漏了 outline 与 points；
  2. 后端 PUT /pages 只落库 keep/title/layout/章节，没有 outline/points 的写入。
本回归锁定后端契约：PUT /pages 带来的标题/摘要/原文必须写进 slides（内容梳理读的就是 slides），
且内容变更只 bump 一次 content_revision、重复提交相同内容不再 bump。
"""
import json
import os
import sys
import tempfile

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, ROOT)

TMP = tempfile.mkdtemp(prefix="df-outline-sync-")
os.environ["DECKFORGE_DATA"] = TMP
os.environ.setdefault("DECKFORGE_SKIP_AGENT_INSTALL", "1")

from server.app import db, main  # noqa: E402

PASS, FAIL = [], []


def check(name, ok, detail=""):
    (PASS if ok else FAIL).append(name)
    print("  %s %s%s" % ("✅" if ok else "❌", name, (" — " + detail) if detail else ""))


def make_project(pages=2):
    db.init_db()
    pid = db.uid("p_test")
    db.insert("projects", dict(id=pid, title="大纲同步回归", source_type="md", intake_mode="doc",
                               style_pack_id="tech-deepblue", status="outlined", created_at=db.now()))
    for no in range(1, pages + 1):
        db.insert("slides", dict(id=db.uid("s"), project_id=pid, page_no=no, display_order=no,
                                 title="旧标题%d" % no, role="content", layout="cards_4",
                                 outline="旧摘要%d" % no, points_json=json.dumps(["旧原文%d" % no], ensure_ascii=False),
                                 must_keep_json="[]", modules_json="[]", content_revision=1, keep=1,
                                 status="pending", created_at=db.now(), updated_at=db.now()))
    return pid


def slide(pid, no):
    return db.q1("SELECT * FROM slides WHERE project_id=? AND page_no=?", (pid, no))


def put(pid, payload_pages):
    db.update("projects", pid, dict(pages_confirmed_at=None))  # 清掉前置状态，避免重复确认干扰
    return main.put_pages(pid, dict(pages=payload_pages))


def main_():
    pid = make_project()

    print("[1] 大纲编辑改标题/摘要/原文 → PUT /pages 必须全部落库到 slides")
    pages = [dict(page_no=1, title="新标题", keep=True, layout="cards_4", revision=1,
                  chapter_no=1, chapter_title="第一章", outline="新摘要", points=["新原文A", "新原文B"]),
             dict(page_no=2, title="旧标题2", keep=True, layout="cards_4", revision=1,
                  chapter_no=1, chapter_title="第一章", outline="旧摘要2", points=["旧原文2"])]
    put(pid, pages)
    s1 = slide(pid, 1)
    check("标题已落库", s1["title"] == "新标题", s1["title"])
    check("摘要(outline)已落库", (s1["outline"] or "") == "新摘要", repr(s1["outline"]))
    check("原文(points)已落库", json.loads(s1["points_json"]) == ["新原文A", "新原文B"],
          s1["points_json"])
    check("章节字段仍正常", s1["chapter_no"] == 1 and s1["chapter_title"] == "第一章")
    check("未改动的第 2 页保持不变", (slide(pid, 2)["outline"] or "") == "旧摘要2")

    print("[2] 内容变更只 bump 一次修订号，并留原文快照")
    check("修订号 1 → 2", s1["content_revision"] == 2, str(s1["content_revision"]))
    snapshot = json.loads(s1["source_content_json"] or "{}")
    check("原文快照记录的是改动前内容", snapshot.get("outline") == "旧摘要1" and
          snapshot.get("points") == ["旧原文1"], json.dumps(snapshot, ensure_ascii=False)[:80])

    print("[3] 重复提交相同内容不再 bump（避免误判内容已变）")
    put(pid, pages)
    s1b = slide(pid, 1)
    check("修订号保持 2", s1b["content_revision"] == 2, str(s1b["content_revision"]))

    print("[4] 只改摘要里的一行也要落库并 bump")
    pages2 = [dict(page) for page in pages]
    pages2[0]["outline"] = "再改一次摘要"
    put(pid, pages2)
    s1c = slide(pid, 1)
    check("摘要变更落库", (s1c["outline"] or "") == "再改一次摘要")
    check("修订号 2 → 3", s1c["content_revision"] == 3, str(s1c["content_revision"]))

    print("[5] page_drafts 里也保留完整内容（向导恢复时用）")
    row = db.q1("SELECT page_drafts_json FROM projects WHERE id=?", (pid,))
    drafts = json.loads(row["page_drafts_json"] or "[]")
    draft = [d for d in drafts if d.get("page_no") == 1][0]
    check("drafts 含 outline/points", draft.get("outline") == "再改一次摘要" and
          draft.get("points") == ["新原文A", "新原文B"], json.dumps(draft, ensure_ascii=False)[:80])


if __name__ == "__main__":
    print("== 编辑大纲 → 内容梳理 内容同步回归 ==")
    main_()
    print("\n%d 通过 / %d 失败" % (len(PASS), len(FAIL)))
    if FAIL:
        print("失败项：", FAIL)
        sys.exit(1)
