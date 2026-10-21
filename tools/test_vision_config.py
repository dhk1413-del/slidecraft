# -*- coding: utf-8 -*-
"""视觉模型配置回归（离线、不联网）：没填视觉 key 时复用 GuaiHub 中转 key 的兜底逻辑。

覆盖：
  V1 无任何 key：视觉不可用（key_set=False），不编造可用状态
  V2 只配 GuaiHub：复用其 key + gemini-2.5-flash，标 fallback=True，走代理
  V3 默认模型可被 model:qwen_vl 覆盖
  V4 单独填百炼 key：优先百炼（直连、不再走兜底）
  V5 自定义 Base URL + key：is_bailian=False、按网络模式走代理
  V6 脱敏：不含 with_keys 时绝不返回 key 本体
  V7 GuaiHub base_url 设置项优先于 yaml

用法：.venv/bin/python tools/test_vision_config.py
"""
import json
import os
import shutil
import sys
import tempfile
from unittest.mock import patch

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
SANDBOX = tempfile.mkdtemp(prefix="deckforge-vision-config-")
os.environ["DECKFORGE_DATA"] = SANDBOX                  # 必须在导入 server.app 之前
sys.path.insert(0, ROOT)

from server.app import config, db                        # noqa: E402

PASS, FAIL = [], []
GUAIHUB_KEY = "test-guaihub-key-0001"                    # 非真实密钥
BAILIAN_KEY = "test-bailian-key-0001"


def check(name, cond, detail=""):
    (PASS if cond else FAIL).append(name)
    print("  %s %s%s" % ("✓" if cond else "✗", name, ("  —— " + detail) if detail and not cond else ""))


def clear_settings():
    for key in ("key:guaihub", "key:qwen_vl", "base_url:guaihub", "base_url:qwen_vl", "model:qwen_vl"):
        db.x("DELETE FROM settings WHERE key=?", (key,))


def vision(with_keys=False):
    """屏蔽 .env，避免本机环境变量影响断言。"""
    with patch.object(config, "_load_env", return_value={}):
        return config.vision_provider(with_keys=with_keys)


def main():
    db.init_db()

    print("[V1] 没有任何 key：如实不可用")
    clear_settings()
    v = vision()
    check("key_set=False", v["key_set"] is False)
    check("fallback=False（不假装有兜底）", v["fallback"] is False)
    check("label 仍是默认视觉模型", "百炼" in v["label"] or "自定义" in v["label"], v["label"])

    print("[V2] 只配 GuaiHub：复用中转 key + gemini-2.5-flash")
    clear_settings()
    db.setting_set("key:guaihub", GUAIHUB_KEY)
    v = vision(with_keys=True)
    check("key_set=True", v["key_set"] is True)
    check("fallback=True", v["fallback"] is True)
    check("复用 GuaiHub 的 key", v["key"] == GUAIHUB_KEY)
    check("label 标明复用", "GuaiHub" in v["label"] and "复用" in v["label"], v["label"])
    check("默认模型 gemini-2.5-flash", v["default_model"] == config.GUAIHUB_VISION_MODEL,
          v["default_model"])
    check("base_url 指向 GuaiHub", "guaihub" in v["base_url"], v["base_url"])
    check("境外中转需要代理", v["needs_proxy"] is True)

    print("[V3] model:qwen_vl 可覆盖兜底模型")
    db.setting_set("model:qwen_vl", "gemini-3-flash")
    v = vision(with_keys=True)
    check("覆盖生效", v["default_model"] == "gemini-3-flash", v["default_model"])
    check("仍是兜底态", v["fallback"] is True)

    print("[V4] 单独填百炼 key：优先百炼、退出兜底")
    clear_settings()
    db.setting_set("key:guaihub", GUAIHUB_KEY)
    db.setting_set("key:qwen_vl", BAILIAN_KEY)
    v = vision(with_keys=True)
    check("fallback=False", v["fallback"] is False)
    check("用视觉自己的 key", v["key"] == BAILIAN_KEY)
    check("百炼官方端点", v["is_bailian"] is True and "dashscope" in v["base_url"], v["base_url"])
    check("国内直连不需要代理", v["needs_proxy"] is False)
    check("默认 qwen-vl-plus", v["default_model"] == "qwen-vl-plus", v["default_model"])

    print("[V5] 自定义 Base URL + key：按网络模式走代理")
    clear_settings()
    db.setting_set("key:qwen_vl", "test-custom-key-0001")
    db.setting_set("base_url:qwen_vl", "https://relay.example.com/v1")
    v = vision(with_keys=True)
    check("fallback=False", v["fallback"] is False)
    check("is_bailian=False", v["is_bailian"] is False)
    check("自定义端点需要代理", v["needs_proxy"] is True)

    print("[V6] 脱敏：不带 with_keys 时绝不返回 key 本体")
    clear_settings()
    db.setting_set("key:guaihub", GUAIHUB_KEY)
    v = vision(with_keys=False)
    dumped = json.dumps(v, ensure_ascii=False)
    check("key 字段为空", v["key"] == "")
    check("响应里没有完整 key", GUAIHUB_KEY not in dumped)
    check("仍给出掩码", bool(v["key_masked"]) and GUAIHUB_KEY not in v["key_masked"])

    print("[V7] base_url:guaihub 设置项优先于 yaml")
    clear_settings()
    db.setting_set("key:guaihub", GUAIHUB_KEY)
    db.setting_set("base_url:guaihub", "https://relay2.example.com/v1")
    v = vision(with_keys=True)
    check("使用设置里的中转地址", v["base_url"] == "https://relay2.example.com/v1", v["base_url"])


if __name__ == "__main__":
    try:
        main()
    finally:
        shutil.rmtree(SANDBOX, ignore_errors=True)
    print("\n通过 %d 项，失败 %d 项" % (len(PASS), len(FAIL)))
    if FAIL:
        print("失败项：" + "；".join(FAIL))
    sys.exit(1 if FAIL else 0)
