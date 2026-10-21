# -*- coding: utf-8 -*-
"""配置层：读 config/providers.yaml + .env + 数据库设置覆盖；解析 key、网络模式、代理策略。

对外能力：
  ROOT / CONFIG_DIR / STYLE_DIR / DATA_DIR / FILES_DIR
  image_providers()      生图供应商 + local_render 的能力与 key 状态
  text_provider()        DeepSeek 能力与 key 状态
  network_mode()         http_proxy | tun | none
  proxy_for(needs_proxy) 返回给 httpx 的 proxies（境外走代理、国内直连）
  set_setting(...)       key/模型/网络模式的热加载写入
"""
import io
import os
from typing import Any, Dict, List, Optional

import yaml

from . import db
from .paths import (CONFIG_DIR, DATA_DIR, ENV_FILES, FILES_DIR, ROOT,   # noqa: F401（对外仍以 config.* 暴露）
                    STYLE_DIR, UI_DIR, load_env)

PROVIDERS_YAML = os.path.join(CONFIG_DIR, "providers.yaml")
TEXT_YAML = os.path.join(CONFIG_DIR, "text-models.yaml")
_load_env = load_env             # 解析逻辑统一放在 paths.py（paths ← config，无循环）


def load_providers_yaml() -> Dict[str, Any]:
    with io.open(PROVIDERS_YAML, encoding="utf-8") as f:
        return yaml.safe_load(f) or {}


def load_text_yaml() -> Dict[str, Any]:
    with io.open(TEXT_YAML, encoding="utf-8") as f:
        return yaml.safe_load(f) or {}


def _key_for(provider: Dict[str, Any]) -> str:
    """优先级：数据库设置（界面填写）> .env > providers.yaml 内联（后者通常为空）。"""
    pid = provider["id"]
    v = db.setting_get("key:%s" % pid, "")
    if v:
        return v
    env = _load_env()
    return env.get(provider.get("api_key_env", ""), "") or provider.get("api_key", "") or ""


def mask(key: str) -> str:
    if not key:
        return ""
    return key[:3] + "*" * max(4, len(key) - 7) + key[-4:] if len(key) > 8 else "***"


def network_mode() -> str:
    return db.setting_get("network:mode", "") or (load_providers_yaml().get("network", {}) or {}).get("mode", "http_proxy")


def http_proxy_url() -> str:
    return db.setting_get("network:http_proxy", "") or (load_providers_yaml().get("network", {}) or {}).get(
        "http_proxy", "http://127.0.0.1:7897")


def proxy_for(needs_proxy: bool) -> Optional[Dict[str, str]]:
    """境外 provider 按 network.mode 决定代理；国内 provider 一律直连。

    TUN 模式下必须直连（代理已在系统路由层生效，再设 HTTP 代理会失败）。
    """
    if not needs_proxy:
        return None
    mode = network_mode()
    if mode != "http_proxy":
        return None
    url = http_proxy_url()
    return {"http://": url, "https://": url}


def image_providers(with_keys: bool = False) -> List[Dict[str, Any]]:
    cfg = load_providers_yaml()
    out = []
    for p in cfg.get("providers", []):
        key = _key_for(p)
        base_url = db.setting_get("base_url:%s" % p["id"], "") or p.get("base_url", "")
        model = db.setting_get("model:%s" % p["id"], "") or p.get("default_model", "")
        size = db.setting_get("size:%s" % p["id"], "") or p.get("default_size", "2K")
        out.append(dict(id=p["id"], label=p.get("label", p["id"]), base_url=base_url,
                        api_style=p.get("api_style", ""), needs_proxy=bool(p.get("needs_proxy")),
                        default_model=model, default_size=size, models=p.get("models", []),
                        notes=p.get("notes", ""), key_set=bool(key), key_masked=mask(key),
                        usage_api=p.get("usage_api", ""),
                        key=key if with_keys else "", unit_price_cny=_price_of(p, model, size)))
    return out


def _price_of(provider: Dict[str, Any], model: str, size: str) -> Optional[float]:
    """单价优先级：设置页填的覆盖值 > providers.yaml > None（未填）。

    None 表示**单价未知**：账本金额会记 0，但那不代表免费——界面必须如实说明。
    """
    override = db.setting_get("price:%s" % provider.get("id", ""), "")
    if override:
        try:
            return float(override)
        except ValueError:
            pass
    for m in provider.get("models", []):
        if m.get("id") == model:
            up = m.get("unit_price_cny")
            if isinstance(up, dict):
                return up.get(size)
            return up
    return None


def text_provider(with_keys: bool = False) -> Dict[str, Any]:
    cfg = load_text_yaml()
    p = (cfg.get("providers") or [{}])[0]
    key = _key_for(p) if p else ""
    return dict(id=p.get("id", "deepseek"), label=p.get("label", "DeepSeek"),
                base_url=p.get("base_url", "https://api.deepseek.com"),
                model=db.setting_get("model:deepseek", "") or p.get("model", ""),
                needs_proxy=bool(p.get("needs_proxy", False)),
                key_set=bool(key), key_masked=mask(key), key=key if with_keys else "")


GUAIHUB_VISION_MODEL = "gemini-2.5-flash"


def _guaihub_vision_fallback() -> Optional[Dict[str, Any]]:
    """没有单独填视觉 key 时，复用 GuaiHub 中转的生图 key 做视觉识别。

    GuaiHub 是 New API 中转站（OpenAI 兼容 /chat/completions）。实测 gemini-2.5-flash
    能按本项目的 VISION_PROMPT 返回可解析 JSON（2026-10-21 实测 3.2s）。这样只配了中转
    key 的机器，备注识别 / 风格构建 / 图片重建也能用，不必再单独申请百炼 key。
    """
    key = db.setting_get("key:guaihub", "") or _load_env().get("GUAIHUB_API_KEY", "")
    if not key:
        return None
    configured = db.setting_get("base_url:guaihub", "")
    if not configured:
        configured = next((p.get("base_url", "") for p in load_providers_yaml().get("providers", [])
                           if p.get("id") == "guaihub"), "")
    return dict(key=key, base_url=(configured or "https://api.guaihub.cc/v1").rstrip("/"))


def vision_provider(with_keys: bool = False) -> Dict[str, Any]:
    """视觉模型（默认百炼 Qwen-VL）用于图片/版式页的文字、图表与布局识别。

    · 端点可改：把 base_url 指向任意 OpenAI 兼容视觉端点（例如中转站上的视觉模型）也能用。
    · 代理由端点决定：百炼是国内官方端点 → 直连；自定义端点按 network.mode 走代理（TUN/none 下自然直连）。
    · 名称随端点变：指向自定义端点时不再自称「阿里百炼」，避免界面骗人。
    · 兜底：没填视觉 key 但配了 GuaiHub（New API 中转）时，复用它的 key + 默认 gemini-2.5-flash，
      并在返回里标 `fallback: true`，界面据此提示「复用了生图 key」。
    """
    key = db.setting_get("key:qwen_vl", "") or _load_env().get("DASHSCOPE_API_KEY", "")
    default_base = "https://dashscope.aliyuncs.com/compatible-mode/v1"
    base_url = (db.setting_get("base_url:qwen_vl", "") or default_base).rstrip("/")
    is_bailian = "dashscope.aliyuncs.com" in base_url
    model = db.setting_get("model:qwen_vl", "") or ("qwen-vl-plus" if is_bailian else "")
    fallback = None
    if not key:
        fallback = _guaihub_vision_fallback()
        if fallback:
            key, base_url, is_bailian = fallback["key"], fallback["base_url"], False
            model = db.setting_get("model:qwen_vl", "") or GUAIHUB_VISION_MODEL
    if fallback:
        label = "GuaiHub · 视觉识别（复用生图 key）"
    else:
        label = "阿里百炼 · Qwen-VL（图片理解）" if is_bailian else "自定义视觉模型（OpenAI 兼容）"
    models = [dict(id="qwen-vl-plus"), dict(id="qwen-vl-max")] if is_bailian else ([dict(id=model)] if model else [])
    return dict(id="qwen_vl", label=label,
                base_url=base_url, default_model=model, default_size="-", models=models, is_bailian=is_bailian,
                needs_proxy=bool(fallback) or not is_bailian, key_set=bool(key), key_masked=mask(key),
                key=key if with_keys else "", fallback=bool(fallback),
                notes=("未单独填写视觉 key：当前复用 GuaiHub 中转 key（模型 %s，可改默认模型）。"
                       "填了「视觉模型」自己的 key 后优先用它。" % GUAIHUB_VISION_MODEL) if fallback else
                      "用于识别图片版 PPT 的文字、版式、图表与插画区域；百炼官方端点直连，自定义端点按网络模式走代理。")


def priority() -> List[str]:
    return db.setting_get("network:priority", "").split(",") if db.setting_get("network:priority", "") \
        else load_providers_yaml().get("default_priority", [])


def set_setting(key: str, value: str) -> None:
    db.setting_set(key, value)
