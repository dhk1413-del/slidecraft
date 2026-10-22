# -*- coding: utf-8 -*-
"""agent 链自动安装器离线回归：不联网、不真的安装，只验证判定与行为。

锁定的是「别人部署时全自动装 Harness」最容易出问题的地方：
- 三件套 + Harness CLI 的可用性判定要准（ok / missing 说清楚）
- 缺件时**尽力而为**：逐项尝试、失败不阻断启动（退出码 0）
- 可整条跳过（DECKFORGE_SKIP_AGENT_INSTALL=1）
- 状态文件不能卡在 running（异常中止也要 finalize）
- 能真的把 skill 链接进 Harness 技能目录

全部在临时 HOME 里跑，不碰本机真实安装。
"""
import os
import shutil
import stat
import subprocess
import sys
import tempfile

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
SCRIPT = os.path.join(ROOT, "tools", "install_agent.sh")

PASS, FAIL = [], []


def check(name, ok, detail=""):
    (PASS if ok else FAIL).append(name)
    print("  %s %s%s" % ("✅" if ok else "❌", name, (" — " + detail) if detail else ""))


def write_exec(path, body):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(body)
    os.chmod(path, os.stat(path).st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)


def build_env(tmp, *, complete=True, linked=True):
    """构造一个隔离的「机器」：HOME、editppt venv、skill、npm 全局目录。"""
    home = os.path.join(tmp, "home")
    venv = os.path.join(tmp, "editppt-venv")
    skill_repo = os.path.join(tmp, "skills-repos", "skill-repo")
    skill_dir = os.path.join(skill_repo, "skills", "image-to-editable-ppt")
    agents_skill = os.path.join(home, ".agents", "skills", "image-to-editable-ppt")
    npm_prefix = os.path.join(tmp, "npm-global")
    logs = os.path.join(tmp, "logs")
    os.makedirs(home, exist_ok=True)
    os.makedirs(logs, exist_ok=True)
    if complete:
        write_exec(os.path.join(venv, "bin", "editppt"), "#!/bin/sh\necho editppt-test\n")
        os.makedirs(skill_dir, exist_ok=True)
        with open(os.path.join(skill_dir, "SKILL.md"), "w", encoding="utf-8") as fh:
            fh.write("# test skill\n")
        write_exec(os.path.join(npm_prefix, "bin", "dsh"), "#!/bin/sh\necho 9.9.9-test\n")
        if linked:                                   # 模拟「已链接进 Harness 技能目录」
            os.makedirs(agents_skill, exist_ok=True)
            with open(os.path.join(agents_skill, "SKILL.md"), "w", encoding="utf-8") as fh:
                fh.write("# test skill\n")
    env = dict(os.environ)
    env.update({
        "HOME": home,
        "PATH": "/usr/bin:/bin",
        "DECKFORGE_EDITPPT_VENV": venv,
        "DECKFORGE_SKILL_REPO": skill_repo,
        "DECKFORGE_SKILL_DIR": skill_dir,
        "DECKFORGE_AGENTS_SKILL_DIR": agents_skill,
        "DECKFORGE_NPM_PREFIX": npm_prefix,
        "DECKFORGE_NPM_CACHE": os.path.join(tmp, "npm-cache"),
        "DECKFORGE_AGENT_LOG_DIR": logs,
        "DECKFORGE_AGENT_INSTALL_TIMEOUT": "20",
        "DECKFORGE_SKILL_REPO_URL": "file:///nonexistent-agent-test.git",
        "DECKFORGE_DSH_VERSION": "9.9.9-test",
    })
    for key in ("DECKFORGE_SKIP_AGENT_INSTALL", "DECKFORGE_SKIP_HARNESS", "DECKFORGE_GIT_PROXY"):
        env.pop(key, None)
    return env, dict(home=home, venv=venv, skill_dir=skill_dir,
                     agents_skill=agents_skill, npm_prefix=npm_prefix, logs=logs)


def run(args, env, timeout=120):
    return subprocess.run(["bash", SCRIPT] + args, env=env, capture_output=True,
                          text=True, timeout=timeout)


def read_status(paths):
    path = os.path.join(paths["logs"], "agent-install.status")
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return fh.read()
    except OSError:
        return ""


def main():
    tmp = tempfile.mkdtemp(prefix="agent-install-test-")
    try:
        print("[1] 四件套齐全 → --check 判 ok")
        env, paths = build_env(tmp)
        proc = run(["--check"], env)
        check("齐全时退出码 0", proc.returncode == 0, "exit=%s" % proc.returncode)
        check("输出 overall ok", "overall        ok" in proc.stdout, proc.stdout.strip().splitlines()[-1] if proc.stdout else "")

        print("[2] 缺件 → --check 判 missing 且 exit=1")
        env2, paths2 = build_env(tmp + "/missing", complete=False)
        proc = run(["--check"], env2)
        check("缺件时退出码 1", proc.returncode == 1, "exit=%s" % proc.returncode)
        check("逐项指出 missing", proc.stdout.count("missing") >= 4, "missing 行数=%d" % proc.stdout.count("missing"))

        print("[3] DECKFORGE_SKIP_AGENT_INSTALL=1 → 整条跳过")
        env3, paths3 = build_env(tmp + "/skip", complete=False)
        env3["DECKFORGE_SKIP_AGENT_INSTALL"] = "1"
        proc = run(["--install"], env3)
        check("跳过时退出码 0", proc.returncode == 0, "exit=%s" % proc.returncode)
        check("输出说明已跳过", "跳过" in proc.stdout, proc.stdout.strip()[:80])
        check("状态落盘 overall=skipped", "overall=skipped" in read_status(paths3), read_status(paths3).strip())

        print("[4] 干净机器 + 无 npm：尽力而为，逐项失败但不阻断")
        env4, paths4 = build_env(tmp + "/clean", complete=False)
        proc = run(["--install"], env4)
        check("失败也退出码 0（不阻断部署）", proc.returncode == 0, "exit=%s" % proc.returncode)
        check("四项都有结论", all(("%s:" % k) in proc.stdout for k in
                              ("harness_cli", "skill_repo", "editppt_cli", "harness_skill")),
              proc.stdout.strip().replace("\n", " | ")[:120])
        status = read_status(paths4)
        check("状态 overall=partial", "overall=partial" in status, status.strip())
        check("状态不卡在 running", "overall=running" not in status, status.strip())

        print("[5] 只缺 Harness 技能目录 → 真的把 skill 链进去")
        env5, paths5 = build_env(tmp + "/link", linked=False)
        proc = run(["--install"], env5)
        linked = os.path.join(paths5["agents_skill"], "SKILL.md")
        check("退出码 0", proc.returncode == 0, "exit=%s" % proc.returncode)
        check("技能目录已可被 Harness 发现", os.path.isfile(linked), linked)
        check("状态 overall=ok", "overall=ok" in read_status(paths5), read_status(paths5).strip())

        print("[6] 已就绪时 --background 立即返回、不派生安装")
        proc = run(["--background"], env5)
        check("退出码 0 且提示无需安装", proc.returncode == 0 and "无需安装" in proc.stdout,
              proc.stdout.strip()[:80])
        lock = os.path.join(paths5["logs"], ".agent-install.lock")
        check("无锁残留", not os.path.isdir(lock), lock)

        print("[7] 本机真实环境 --check 可跑（只读，不改机器）")
        real = dict(os.environ)
        proc = run(["--check"], real)
        check("真实环境 --check 有结论", "overall" in proc.stdout, proc.stdout.strip().splitlines()[-1] if proc.stdout else "")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    print("\n通过 %d 项，失败 %d 项" % (len(PASS), len(FAIL)))
    if FAIL:
        print("失败项：" + "；".join(FAIL))
    return 0 if not FAIL else 1


if __name__ == "__main__":
    sys.exit(main())
