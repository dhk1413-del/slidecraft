# SlideCraft v0.6.0

自托管的「输入内容 → 一整套风格统一 PPT」工作台。

## 本版亮点

- **内容梳理可以删页了**：页面标题栏新增「删除此页」，带确认弹窗和 **10 秒撤销**；删除后页码自动前移，
  至少保留 1 页。撤销会把这一页按原位置重建回来。
- **编辑大纲和内容梳理终于一致了**：在大纲里改的标题 / 摘要 / 原文、新增或删除的页面，
  现在都会同步到内容梳理（含页码重排），不用再手动改两遍。
- **多机「图片转可编辑」更省 token**：远端 worker 改用平台的包装提示，保留「先加载 skill / 文字真源 /
  token 纪律」等约束（此前实测远端页 token 高 3–6 倍）。

## 这个版本能做什么（总览）

- **文档生成**：上传 Markdown / TXT / DOCX / PDF / PPTX 或粘贴文本 → 编辑大纲 → 内容梳理 → 选风格 → 生成 → 导出整套 PPT。
- **PPT 美化**：拿参考图重做每一页，再按需转成可编辑版。
- **图片转可编辑**：把整页图转成以文字/形状为原生对象的 PPTX，支持多机并发。
- **讲稿备注**：为每一页生成备注，历史任务可回看、逐页复核可看原页。
- **两条导出路线**：图片版 PPTX（整页图铺底）与**原生可编辑** PPTX。
- **零密钥可体验**：不填模型 key 也能浏览/上传/梳理；生成时引导去配置，或显式选择「先用本地演示」。

## 升级

- **无新增 Python / Node 依赖**：替换代码后重启后端即可。
- `data/` 目录、`DECKFORGE_*` 环境变量、数据库文件名都**没有变**，已有项目、草稿与账本原样保留。
- **无数据迁移**：删除页是真实删除（10 秒内可撤销，撤销后该页以新 `slide_id` 重建）。
- 接口新增：`DELETE /api/projects/{pid}/slides/{slide_id}`、`POST /api/projects/{pid}/slides/restore`
  （详见 `docs/API.md`）。

## 质量

- 离线回归 **21 套全过（22 项检查）** + 前端构建 + `m5/m6/m7`；`make verify-fast` 全绿。
- 本版新增回归：`test_outline_sync`、`test_slide_delete`、`test_pages_reconcile`；
  `test_editppt_engine` 增至 66 项。
- 仓库自带密钥门禁（pre-commit / pre-push），历史与远端经全量扫描确认不含任何密钥。

## 许可证

**AGPL-3.0**（见 `LICENSE`）。依赖 PyMuPDF 本身即 AGPL-3.0 / 商业双授权，因此本项目的许可证选择与依赖义务一致。

---

安装与常见问题见 [README](https://github.com/dhk1413-del/slidecraft) 与
[使用说明](https://github.com/dhk1413-del/slidecraft/blob/main/docs/使用说明.md)。
