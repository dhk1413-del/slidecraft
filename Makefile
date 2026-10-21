# SlideCraft 常用命令。
# 本仓没有 pytest / CI / linter 配置，所以 **`make verify` 就是规范验收入口**：
# 它只是编排（跑 tools/ 下已有的离线回归 + 前端构建），断言仍写在各自的 tools/test_*.py 里，
# 不复制第二套真相。详见 tools/verify_all.py。

PY   := .venv/bin/python
PORT := 8641

.PHONY: help verify verify-fast test build lint guard hooks release-check run stop restart sync-nas

help:                ## 列出可用命令
	@grep -E '^[a-z][a-z-]*:.*##' Makefile | sed 's/:.*##/\t/' | column -t -s "$$(printf '\t')"

# 便宜的健全性检查放最前面：回归一旦有红，后面的检查照样能先跑完并报出来。
verify:              ## 规范验收：离线回归 + 前端构建 + 线上只读冒烟（需服务在跑）
	@task_data=$$(mktemp -d); trap 'rm -rf "$$task_data"' EXIT; $(PY) tools/check_version_sync.py && $(PY) tools/check_no_secrets.py --head && DECKFORGE_DATA="$$task_data" $(PY) tools/verify_all.py --live && $(PY) tools/check_standalone_sync.py && $(PY) -m server.tests.test_m5 && $(PY) -m server.tests.test_m6 && $(PY) -m server.tests.test_m7

verify-fast:         ## 只跑离线回归 + 前端构建（不碰网络/不调模型）
	@task_data=$$(mktemp -d); trap 'rm -rf "$$task_data"' EXIT; $(PY) tools/check_version_sync.py && $(PY) tools/check_no_secrets.py --head && DECKFORGE_DATA="$$task_data" $(PY) tools/verify_all.py && $(PY) tools/check_standalone_sync.py && $(PY) -m server.tests.test_m5 && $(PY) -m server.tests.test_m6 && $(PY) -m server.tests.test_m7

test: verify-fast    ## verify-fast 的别名

build:               ## 前端构建（含 typecheck）
	npm --prefix web run build

lint:                ## 静态体检：后端字节码编译 + 前端 tsc + 版本号一致性
	$(PY) -m compileall -q server tools && npm --prefix web run typecheck && $(PY) tools/check_version_sync.py

guard:               ## 密钥门禁：索引 + HEAD + 全历史（模型 key 绝不入库/上传）
	$(PY) tools/check_no_secrets.py --staged
	$(PY) tools/check_no_secrets.py --head
	$(PY) tools/check_no_secrets.py --all

hooks:               ## 启用仓库自带 git 钩子（每个克隆执行一次）
	bash tools/install_hooks.sh

release-check:       ## 发版前检查：版本号一致 + 密钥门禁 + 全历史体检（不代替 make verify）
	@echo "准备发布的版本：$$(cat VERSION)"
	$(PY) tools/check_version_sync.py
	$(PY) tools/check_no_secrets.py --head
	$(PY) tools/check_no_secrets.py --all
	@echo "下一步（人工确认 CHANGELOG/RELEASE_NOTES 后执行）："
	@echo "  git tag -a v$$(cat VERSION) -m \"SlideCraft v$$(cat VERSION)\""
	@echo "  git -c http.proxy=http://127.0.0.1:65532 push origin main --follow-tags"

run:                 ## 启动服务（脱终端常驻，日志 data/server.log）
	bash server/start-lan.sh

stop:                ## 停止服务
	bash server/stop-daemon.sh

restart: stop run    ## 重启服务（改后端后必须走这条，别在终端里前台起）

sync-nas:            ## 同步本机改动到 NAS 虚拟机（保留 VM 的 data/.env）并重建重启
	bash tools/sync_to_nas.sh
