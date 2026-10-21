# -*- coding: utf-8 -*-
"""Provider 适配器：5 家生图 + DeepSeek 文本。

设计要点（对齐 spec D9/D19/D23/D24）：
  · 三家国内直连、两家境外走代理（proxies 由 config.proxy_for 决定）
  · 每次调用返回 provider/model/size/单价/耗时，由调用方落账本（模型可见）
  · 无 key 时不抛错，由上层降级到本地兜底渲染
  · ⚠️ 诚实标注：除 openai_compatible 的请求形状按官方文档编写外，其余分支**当前无 key，未做端到端实测**
"""
import base64
import json
import re
import time
from typing import Any, Dict, List, Optional, Tuple

import httpx

from . import config

# 统一尺寸语义 → 各家的像素表达（16:9）
SIZE_PX = {"1K": (1024, 576), "2K": (2048, 1152), "3K": (3072, 1728), "4K": (4096, 2304)}


def _size_str(size: str) -> str:
    w, h = SIZE_PX.get(size.upper(), SIZE_PX["2K"])
    return "%dx%d" % (w, h)


from contextvars import ContextVar
quoted_provider = ContextVar("quoted_provider", default=(False, None))


def pick_image_provider() -> Optional[Dict[str, Any]]:
    """按 default_priority 取第一个已配置 key 的供应商。都没有 → None（上层走本地兜底）。"""
    pinned, provider = quoted_provider.get()
    if pinned:
        return provider
    provs = {p["id"]: p for p in config.image_providers(with_keys=True)}
    for pid in config.priority():
        p = provs.get(pid)
        if p and p.get("key"):
            return p
    return None


# ────────────────────────── 生图 ──────────────────────────

def generate_image(prompt: str, size: str = "2K", style_accent: str = "#1E78FA") -> Dict[str, Any]:
    """返回 {ok, image_bytes, provider, model, size, cost_cny, latency_ms, message}。

    无可用 provider → {ok: False, reason: 'not_configured'}（上层降级，不视为错误）。

    瞬态失败（TLS 被重置 / 连接超时 / 5xx / 429）**会重试并切换链路**：直连不通改走代理，代理不通改直连。
    只有所有尝试都失败才返回 ok=False 交给上层降级——避免"一次网络抖动就整页降级成本地渲染"。
    """
    p = pick_image_provider()
    if not p:
        return dict(ok=False, reason="not_configured", provider="local_render", model="local",
                    size=size, cost_cny=0.0, latency_ms=0,
                    message="未配置生图 key，已降级为本地兜底渲染")
    t0 = time.time()
    attempts = max(1, int(_retry_config().get("attempts") or 2))
    errors: List[str] = []
    routes = _attempt_routes(bool(p.get("needs_proxy")))
    for attempt in range(attempts):
        use_proxy = routes[attempt % len(routes)]
        try:
            raw = _call_image_provider(p, prompt, size, use_proxy)
            return dict(ok=True, image_bytes=raw, provider=p["id"], model=p["default_model"], size=size,
                        cost_cny=float(p.get("unit_price_cny") or 0.0),
                        latency_ms=int((time.time() - t0) * 1000), message="",
                        attempts=attempt + 1, route="proxy" if use_proxy else "direct")
        except Exception as e:                     # noqa: BLE001 —— 失败要重试/降级而非中断
            label = "%s（%s）" % (type(e).__name__, "代理" if use_proxy else "直连")
            errors.append("%s: %s" % (label, str(e)[:150]))
            if not _is_transient(e):               # 401/403/400 这类重试也没用，立即停手
                break
            if attempt + 1 < attempts:
                time.sleep(_backoff_seconds(attempt))
    return dict(ok=False, reason="call_failed", provider=p["id"], model=p["default_model"],
                size=size, cost_cny=0.0, latency_ms=int((time.time() - t0) * 1000),
                attempts=len(errors), route="-",
                message="尝试 %d 次仍失败：%s" % (len(errors), "；".join(errors[-2:]))[:400])


RETRY_BACKOFF = (1.5, 4.0)


def _retry_config() -> Dict[str, Any]:
    """重试次数取自 config/providers.yaml 的 common.retry（默认 2 次额外尝试）。"""
    common = (config.load_providers_yaml() or {}).get("common", {}) or {}
    try:
        extra = int(common.get("retry", 2))
    except (TypeError, ValueError):
        extra = 2
    return dict(attempts=max(1, min(4, extra + 1)))


def _backoff_seconds(attempt: int) -> float:
    return RETRY_BACKOFF[min(attempt, len(RETRY_BACKOFF) - 1)]


def _attempt_routes(primary_needs_proxy: bool) -> List[bool]:
    """候选链路：先按配置，再兜底另一条。TLS 被重置时换链路常能救回来。

    代理链路仅在不使用 TUN 且确实配了 http_proxy 时才作为备选（TUN 模式下再走 HTTP 代理必失败）。
    """
    routes = [bool(primary_needs_proxy)]
    alt = not bool(primary_needs_proxy)
    if alt and config.proxy_for(True):          # 备选是"走代理"：确认代理链路可用
        routes.append(alt)
    elif not alt:                               # 备选是"直连"：始终可用
        routes.append(alt)
    return routes


def _is_transient(exc: Exception) -> bool:
    """网络类/服务端类错误值得重试；4xx（除 429）重试只是白等。"""
    status = getattr(getattr(exc, "response", None), "status_code", None)
    if isinstance(status, int):
        return status >= 500 or status == 429
    transient = (getattr(httpx, "TransportError", ()), getattr(httpx, "TimeoutException", ()))
    return isinstance(exc, transient) or exc.__class__.__name__ in (
        "ConnectError", "ReadError", "ReadTimeout", "ConnectTimeout", "RemoteProtocolError", "ProtocolError")


def _call_image_provider(p: Dict[str, Any], prompt: str, size: str, use_proxy: bool) -> bytes:
    if p["api_style"] == "google_genai":
        return _gemini(p, prompt, use_proxy)
    if p["api_style"] == "dashscope_sdk":
        return _dashscope(p, prompt, size, use_proxy)
    return _openai_images(p, prompt, size, use_proxy)   # openai_compatible


def _client_kwargs(needs_proxy: bool, timeout: float = 180.0) -> Dict[str, Any]:
    """httpx>=0.28 用 `proxy=`（旧版是 `proxies=`）；统一 trust_env=False，不让环境变量代理干扰。

    代理由 network.mode 显式决定：境外走 http_proxy，TUN/none 模式一律直连。
    """
    kw: Dict[str, Any] = dict(timeout=timeout, trust_env=False)
    url = (config.proxy_for(needs_proxy) or {}).get("https://")
    if url:
        kw["proxy"] = url
    return kw


def _client(p: Dict[str, Any], use_proxy: Optional[bool] = None) -> httpx.Client:
    """`use_proxy=None` 按 provider 配置；显式 True/False 供重试时切换链路。"""
    needs = bool(p.get("needs_proxy")) if use_proxy is None else bool(use_proxy)
    return httpx.Client(**_client_kwargs(needs))


def _openai_images(p: Dict[str, Any], prompt: str, size: str, use_proxy: Optional[bool] = None) -> bytes:
    """OpenAI 风格 images/generations（openai_official 通用）。"""
    body: Dict[str, Any] = {"model": p["default_model"], "prompt": prompt, "n": 1, "size": _size_str(size)}
    with _client(p, use_proxy) as c:
        r = c.post(p["base_url"].rstrip("/") + "/images/generations",
                   headers={"Authorization": "Bearer %s" % p["key"], "Content-Type": "application/json"},
                   json=body)
        r.raise_for_status()
        data = r.json()
    item = (data.get("data") or [{}])[0]
    if item.get("b64_json"):
        return base64.b64decode(item["b64_json"])
    if item.get("url"):
        with _client(p, use_proxy) as c:
            return c.get(item["url"]).content
    raise RuntimeError("响应里没有 b64_json / url：%s" % str(data)[:200])


def _gemini(p: Dict[str, Any], prompt: str, use_proxy: Optional[bool] = None) -> bytes:
    """Gemini/Nano Banana：generateContent + inlineData。"""
    url = "%s/models/%s:generateContent" % (p["base_url"].rstrip("/"), p["default_model"])
    body = {"contents": [{"parts": [{"text": prompt}]}]}
    with _client(p, use_proxy) as c:
        r = c.post(url, headers={"x-goog-api-key": p["key"], "Content-Type": "application/json"}, json=body)
        r.raise_for_status()
        data = r.json()
    for cand in data.get("candidates", []):
        for part in cand.get("content", {}).get("parts", []):
            inline = part.get("inlineData") or part.get("inline_data")
            if inline and inline.get("data"):
                return base64.b64decode(inline["data"])
    raise RuntimeError("Gemini 响应中没有 inlineData：%s" % str(data)[:200])


def _dashscope(p: Dict[str, Any], prompt: str, size: str, use_proxy: Optional[bool] = None) -> bytes:
    """阿里百炼生图：Qwen-Image 走同步多模态接口，其余模型保持异步任务接口。"""
    if p["default_model"].lower().startswith("qwen-image"):
        return _dashscope_qwen_image(p, prompt, size, use_proxy)

    # Wan / Wanx 等模型继续使用既有异步接口，勿与 Qwen-Image 的同步接口混用。
    w, h = SIZE_PX.get(size.upper(), SIZE_PX["2K"])
    base = p["base_url"].rstrip("/")
    headers = {"Authorization": "Bearer %s" % p["key"], "Content-Type": "application/json",
               "X-DashScope-Async": "enable"}
    body = {"model": p["default_model"], "input": {"prompt": prompt},
            "parameters": {"size": "%d*%d" % (w, h), "n": 1}}
    with _client(p, use_proxy) as c:
        r = c.post(base + "/services/aigc/text2image/image-synthesis", headers=headers, json=body)
        r.raise_for_status()
        task = r.json().get("output", {}).get("task_id")
        if not task:
            raise RuntimeError("未拿到 task_id：%s" % str(r.json())[:200])
        for _ in range(60):
            time.sleep(3)
            rr = c.get(base + "/tasks/%s" % task, headers={"Authorization": "Bearer %s" % p["key"]})
            out = rr.json().get("output", {})
            st = out.get("task_status")
            if st == "SUCCEEDED":
                url = (out.get("results") or [{}])[0].get("url")
                if not url:
                    raise RuntimeError("任务成功但无 url")
                return c.get(url).content
            if st in ("FAILED", "CANCELED", "UNKNOWN"):
                raise RuntimeError("任务失败：%s" % str(out)[:200])
    raise RuntimeError("任务超时")


# Qwen-Image 3.0/2.0 的 DashScope 文生图支持自定义尺寸（512*512 至 2048*2048）。
# 工作台的 K 档位表示输出边长，不沿用通用供应商的 16:9 SIZE_PX 映射。
QWEN_IMAGE_SIZES = {"1K": "1024*1024", "2K": "2048*2048"}
QWEN_IMAGE_DEFAULT_SIZE = "2K"


def _dashscope_qwen_image_size(size: str) -> str:
    """将工作台档位映射为 Qwen-Image 合法尺寸；不支持的档位回落 2K。"""
    return QWEN_IMAGE_SIZES.get((size or "").upper(), QWEN_IMAGE_SIZES[QWEN_IMAGE_DEFAULT_SIZE])


def _dashscope_error_text(response: Any) -> str:
    """提取百炼错误体，避免 HTTPStatusError 丢掉可诊断的 code/message。"""
    try:
        data = response.json()
    except Exception:  # noqa: BLE001 - 错误体可能不是 JSON
        return ""
    if not isinstance(data, dict):
        return ""
    code, message = data.get("code"), data.get("message")
    if code or message:
        return "%s%s" % (code or "", (": " if code and message else "") + str(message or ""))
    return ""


def _dashscope_raise_for_status(response: Any) -> None:
    if response.is_success:
        return
    detail = _dashscope_error_text(response)
    if detail:
        raise RuntimeError("百炼请求失败（HTTP %s）：%s" % (response.status_code, detail))
    response.raise_for_status()


def _dashscope_qwen_image_url(data: Dict[str, Any]) -> str:
    """取同步多模态生成响应中的第一张图片 URL。"""
    try:
        url = data["output"]["choices"][0]["message"]["content"][0]["image"]
    except (KeyError, IndexError, TypeError):
        raise RuntimeError("Qwen-Image 响应中没有 output.choices[0].message.content[0].image：%s" % str(data)[:300])
    if not isinstance(url, str) or not url:
        raise RuntimeError("Qwen-Image 响应中的 image URL 为空")
    return url


def _dashscope_qwen_image(p: Dict[str, Any], prompt: str, size: str,
                          use_proxy: Optional[bool] = None, client_factory: Optional[Any] = None) -> bytes:
    """Qwen-Image 文生图：同步 multimodal-generation，取 URL 后下载 PNG。"""
    base = p["base_url"].rstrip("/")
    headers = {"Authorization": "Bearer %s" % p["key"], "Content-Type": "application/json"}
    body = {
        "model": p["default_model"],
        "input": {"messages": [{"role": "user", "content": [{"text": prompt}]}]},
        "parameters": {"size": _dashscope_qwen_image_size(size), "n": 1,
                       "prompt_extend": False, "watermark": False},
    }
    # client_factory 是测试注入点，保持旧签名（只吃 provider）；生产路径走 _client 并带上链路选择
    with (client_factory(p) if client_factory is not None else _client(p, use_proxy)) as c:
        r = c.post(base + "/services/aigc/multimodal-generation/generation", headers=headers, json=body)
        _dashscope_raise_for_status(r)
        url = _dashscope_qwen_image_url(r.json())
        image = c.get(url)
        _dashscope_raise_for_status(image)
        return image.content


# ────────────────────────── 连通性测试 ──────────────────────────

def test_provider(provider_id: str, api_key: Optional[str] = None) -> Dict[str, Any]:
    """测试供应商连通性；api_key 只覆盖本次请求，绝不持久化或回显。"""
    if provider_id == "local_render":
        return dict(provider_id=provider_id, ok=True, status=200, latency_ms=0, message="本地兜底渲染始终可用")
    provs = {p["id"]: p for p in config.image_providers(with_keys=True)}
    if provider_id == "qwen_vl":
        vp = config.vision_provider(with_keys=True)
        url, key, needs_proxy = vp["base_url"].rstrip("/") + "/models", vp["key"], False
    elif provider_id == "deepseek":
        tp = config.text_provider(with_keys=True)
        url = tp["base_url"].rstrip("/") + "/models"
        key = tp["key"]
        needs_proxy = bool(tp.get("needs_proxy"))
    else:
        p = provs.get(provider_id)
        if not p:
            return dict(provider_id=provider_id, ok=False, status=0, latency_ms=0, message="未知供应商")
        url = p["base_url"].rstrip("/") + "/models"
        key = p["key"]
        needs_proxy = bool(p.get("needs_proxy"))
    if api_key is not None:
        key = api_key
    t0 = time.time()
    try:
        with httpx.Client(**_client_kwargs(needs_proxy, 20.0)) as c:
            r = c.get(url, headers={"Authorization": "Bearer %s" % key} if key else {})
        status = r.status_code
        if status == 200:
            ok, msg = True, "连通且鉴权通过"
        elif status == 401:
            ok, msg = (True, "已连通（未填写 key）") if not key else (False, "鉴权失败：检查 Key 与 API Base URL")
        elif status == 403:
            ok, msg = (True, "已连通（未填写 key 或被风控）") if not key else (False, "访问被拒绝：检查 Key 权限、模型权限或中转站风控")
        elif status == 400:
            ok, msg = False, "请求地址或接口协议不匹配"
        else:
            ok, msg = False, "状态 %d" % status
    except Exception as e:                         # noqa: BLE001
        return dict(provider_id=provider_id, ok=False, status=0,
                    latency_ms=int((time.time() - t0) * 1000),
                    message="不可达：%s（检查代理/网络模式）" % type(e).__name__)
    return dict(provider_id=provider_id, ok=ok, status=status,
                latency_ms=int((time.time() - t0) * 1000), message=msg)


VISION_PROMPT = """分析这张 16:9 PPT 页面，输出严格 JSON（不要 Markdown、不要解释）。字段：
{"texts":[{"text":"原文","x":0-1,"y":0-1,"w":0-1,"h":0-1,"role":"title|body|label","font_size_pt":数字}],
"components":[{"type":"card|shape|chart|icon|image","x":0-1,"y":0-1,"w":0-1,"h":0-1}],
"chart_data":[{"title":"","labels":[],"series":[]}],"warnings":[]}
坐标要求（很重要，用于把文字放回原位重建可编辑 PPT）：
1) 坐标一律用 0-1 的比例（画布左上角为原点），**不要用像素**；例如标题在左上角第三行 → y≈0.12。
2) 每个文本块**只圈住文字本身**，不要包住周围的空白、卡片边框或装饰；框要**紧贴文字**。
3) 一行文字一个块；同一段落的多行分别给块。**相邻文本块的框不要互相重叠**。
4) 字号估算填 font_size_pt（按 16:9 页面高度 7.5 英寸折算：块高约等于字号×1.35/540）。
5) 图表内部的图例、坐标轴刻度、数据值**不要**放进 texts，只把整张图表放进 components(type=chart)。"""

# 思考型视觉模型会把预算先花在推理上，预算偏小时**正文可能为空**（实测 finish_reason=length、
# content=''）→ 给足预算，空正文时再放大一档重试。
VISION_MAX_TOKENS = 8000
VISION_MAX_TOKENS_RETRY = 16000


def _strip_fences(raw: str) -> str:
    s = (raw or "").strip()
    if s.startswith("```"):
        s = re.sub(r"^```[a-zA-Z]*\s*", "", s)
        s = re.sub(r"\s*```$", "", s)
    return s.strip()


def _close_unterminated(s: str) -> str:
    """把被截断的 JSON 片段补成可解析：补上未闭合的字符串与括号。"""
    out, stack, in_str, esc = [], [], False, False
    for ch in s:
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
        else:
            if ch == '"':
                in_str = True
            elif ch == "{":
                stack.append("}")
            elif ch == "[":
                stack.append("]")
            elif ch in "}]" and stack:
                stack.pop()
        out.append(ch)
    text = "".join(out)
    if in_str:
        text += '"'
    return text + "".join(reversed(stack))


def parse_vision_json(raw: str) -> Optional[Dict[str, Any]]:
    """宽容解析视觉模型输出：严格 JSON → 去代码围栏 → 裁到最外层 {} → 按逗号截断补齐。

    模型实测会返回带解释的文字、被 max_tokens 截断、或把整个对象包在 markdown 里；
    这些都不该让整次视觉解析白跑（原来会静默降级成「未做视觉解析」）。
    """
    s = _strip_fences(raw)
    start = s.find("{")
    if start < 0:
        return None
    s = s[start:]
    try:
        v = json.loads(s)
        if isinstance(v, dict):
            return v
    except json.JSONDecodeError:
        pass
    try:
        v = json.loads(_close_unterminated(s))
        if isinstance(v, dict):
            return v
    except json.JSONDecodeError:
        pass
    cuts = [m.start() for m in re.finditer(r"[,}\]]", s)][-40:]      # 只从尾部试有限次，避免长文本反复解析
    for cut in reversed(cuts):
        try:
            v = json.loads(_close_unterminated(s[: cut + 1]))
            if isinstance(v, dict):
                return v
        except json.JSONDecodeError:
            continue
    return None


def normalize_chart_data(raw: Any) -> List[Dict[str, Any]]:
    """把视觉模型返回的图表数据规整成**唯一形状**：{title, labels[str], series:[{name, values[float]}]}。

    真机实测（同一模型、不同页也会不同）：
      · `series:[{"name":"试点校区一","data":[800,…]}]`  ← 键名是 data 不是 values
      · `series:[8.5, 2.1]`                              ← 直接给数字数组
      · `series:[{"name":"订单量","values":[…]}]`         ← 与契约一致
    原来的实现只认最后一种，前面两种会让识别结果**被静默丢弃**（页面照旧不画图）——
    所以这里统一归一化，把「脏」挡在入库之前，下游只处理一种形状。
    """
    out: List[Dict[str, Any]] = []
    for entry in raw or []:
        if not isinstance(entry, dict):
            continue
        labels = [str(x) for x in (entry.get("labels") or []) if str(x).strip()]
        if len(labels) < 2:
            continue
        series_in = entry.get("series")
        if not isinstance(series_in, list):
            continue
        # 真机形状②：series 本身就是数值数组（如 [8.5, 2.1]）→ 视作单系列
        if series_in and all(isinstance(x, (int, float)) and not isinstance(x, bool) for x in series_in):
            series_in = [dict(name="", values=series_in)]
        series: List[Dict[str, Any]] = []
        for s in series_in:
            if isinstance(s, dict):
                vals = s.get("values", s.get("data", s.get("points")))
                name = str(s.get("name") or s.get("label") or "")
            else:                               # 真机形状③：series 是裸数组（含「数组的数组」）
                vals, name = s, ""
            if not isinstance(vals, list):
                continue
            try:
                nums = [float(v) for v in vals]
            except (TypeError, ValueError):
                continue
            if len(nums) != len(labels):        # 长度对不上就不画，别硬凑
                continue
            series.append(dict(name=name or "数值", values=nums))
        if not series:
            continue
        n = min(len(labels), 8)                 # 归一化时统一截断，保证 labels 与每条 values 等长
        out.append(dict(title=str(entry.get("title") or ""), labels=labels[:n],
                        series=[dict(name=s["name"], values=s["values"][:n]) for s in series[:3]]))
    return out


def _vision_call(vp: Dict[str, Any], data_url: str, max_tokens: int) -> Dict[str, Any]:
    body = dict(model=vp["default_model"], messages=[dict(role="user", content=[
        dict(type="image_url", image_url=dict(url=data_url)), dict(type="text", text=VISION_PROMPT),
    ])], temperature=0.0, max_tokens=max_tokens)
    # 代理策略跟随端点：百炼官方端点直连；自定义端点按 network.mode 决定（TUN/none 模式下自然直连）。
    with httpx.Client(**_client_kwargs(bool(vp.get("needs_proxy")), 180.0)) as c:
        r = c.post(vp["base_url"].rstrip("/") + "/chat/completions",
                   headers={"Authorization": "Bearer %s" % vp["key"], "Content-Type": "application/json"}, json=body)
        r.raise_for_status()
        choice = r.json()["choices"][0]
    return dict(content=(choice.get("message") or {}).get("content") or "", finish_reason=choice.get("finish_reason"))


def analyze_slide_with_qwen(image_path: str) -> Dict[str, Any]:
    """调用视觉模型（默认百炼 Qwen-VL，OpenAI 兼容）。未配置或解析失败由调用方安全降级。"""
    vp = config.vision_provider(with_keys=True)
    if not vp.get("key"):
        return dict(ok=False, reason="not_configured", message="未配置视觉模型 API Key（设置页「视觉模型」）")
    t0 = time.time()
    try:
        with open(image_path, "rb") as f:
            data_url = "data:image/png;base64," + base64.b64encode(f.read()).decode("ascii")
        res = _vision_call(vp, data_url, VISION_MAX_TOKENS)
        if not res["content"].strip() and res.get("finish_reason") == "length":
            res = _vision_call(vp, data_url, VISION_MAX_TOKENS_RETRY)     # 预算被推理吃光 → 放大重试一次
        scene = parse_vision_json(res["content"])
        if scene is None:
            return dict(ok=False, reason="bad_json",
                        message="视觉模型返回内容无法解析为 JSON（finish_reason=%s，%d 字符）"
                                % (res.get("finish_reason"), len(res["content"])),
                        latency_ms=int((time.time() - t0) * 1000))
        # 图表数据归一化：原始形状留档（可审计），下游只读规整后的 chart_data。
        if isinstance(scene.get("chart_data"), list):
            scene["chart_data_raw"] = scene["chart_data"]
            scene["chart_data"] = normalize_chart_data(scene["chart_data"])
        return dict(ok=True, scene=scene,
                    provider="guaihub_vision" if vp.get("fallback")
                    else "qwen_vl" if vp.get("is_bailian") else "custom_vision",
                    model=vp["default_model"], finish_reason=res.get("finish_reason"),
                    latency_ms=int((time.time() - t0) * 1000))
    except Exception as e:  # noqa: BLE001
        return dict(ok=False, reason="call_failed", message="%s: %s" % (type(e).__name__, str(e)[:180]),
                    latency_ms=int((time.time() - t0) * 1000))


# ────────────────────────── 文本（DeepSeek）──────────────────────────

def edit_image(image_bytes: bytes, prompt: str, size: str = "2K", mime: str = "image/png",
               timeout: float = 420.0) -> Dict[str, Any]:
    """**图生图**：把一张参考图交给生图模型按 prompt 重绘（OpenAI 兼容的 `/images/edits`）。

    与 `generate_image()` 同源地复用重试/链路切换策略：瞬态失败退避重试，代理↔直连自动切换。
    返回 {ok, image_bytes, provider, model, size, cost_cny, latency_ms, message}。
    """
    p = pick_image_provider()
    if not p:
        return dict(ok=False, reason="not_configured", provider="local_render", model="local",
                    size=size, cost_cny=0.0, latency_ms=0, message="未配置生图 key，无法重绘")
    t0 = time.time()
    attempts = max(1, int(_retry_config().get("attempts") or 2))
    errors: List[str] = []
    routes = _attempt_routes(bool(p.get("needs_proxy")))
    for attempt in range(attempts):
        use_proxy = routes[attempt % len(routes)]
        try:
            raw = _call_edit_provider(p, image_bytes, prompt, size, use_proxy, mime, timeout)
            return dict(ok=True, image_bytes=raw, provider=p["id"], model=p["default_model"], size=size,
                        cost_cny=float(p.get("unit_price_cny") or 0.0),
                        latency_ms=int((time.time() - t0) * 1000), message="",
                        attempts=attempt + 1, route="proxy" if use_proxy else "direct")
        except Exception as exc:                                    # noqa: BLE001
            label = "%s（%s）" % (type(exc).__name__, "代理" if use_proxy else "直连")
            errors.append("%s: %s" % (label, str(exc)[:150]))
            if not _is_transient(exc):
                break
            if attempt + 1 < attempts:
                time.sleep(_backoff_seconds(attempt))
    return dict(ok=False, reason="call_failed", provider=p["id"], model=p["default_model"], size=size,
                cost_cny=0.0, latency_ms=int((time.time() - t0) * 1000), attempts=len(errors), route="-",
                message="尝试 %d 次仍失败：%s" % (len(errors), "；".join(errors[-2:]))[:400])


def _call_edit_provider(p: Dict[str, Any], image_bytes: bytes, prompt: str, size: str,
                        use_proxy: bool, mime: str, timeout: float) -> bytes:
    """OpenAI 兼容 /images/edits（multipart 上传参考图）。"""
    w, h = SIZE_PX.get(size.upper(), SIZE_PX["2K"])
    ext = "png" if "png" in mime else ("jpg" if "jpeg" in mime or "jpg" in mime else "png")
    files = {"image": ("ref.%s" % ext, image_bytes, mime)}
    data = {"model": p["default_model"], "prompt": prompt, "n": "1", "size": "%dx%d" % (w, h)}
    with _client(p, use_proxy) as c:
        r = c.post("%s/images/edits" % p["base_url"].rstrip("/"),
                   headers={"Authorization": "Bearer %s" % p["key"]}, files=files, data=data,
                   timeout=timeout)
        if r.status_code >= 400:
            msg = r.text[:200]
            if r.status_code in (401, 403):
                raise ValueError("鉴权失败 %s：%s" % (r.status_code, msg))
            if r.status_code < 500 and r.status_code not in (408, 429):
                raise ValueError("请求被拒 %s：%s" % (r.status_code, msg))
            raise ConnectionError("HTTP %s：%s" % (r.status_code, msg))     # 可重试
        body = r.json()
    item = (body.get("data") or [{}])[0]
    if item.get("b64_json"):
        return base64.b64decode(item["b64_json"])
    if item.get("url"):
        with _client(p, use_proxy) as c:
            rr = c.get(item["url"], timeout=timeout)
            rr.raise_for_status()
            return rr.content
    raise ValueError("返回里没有图片：%s" % json.dumps(body)[:180])


def text_configured() -> bool:
    return bool(config.text_provider(with_keys=True).get("key"))


def call_text(system: str, user: str, max_tokens: int = 4000) -> Tuple[bool, str, Dict[str, Any]]:
    """返回 (ok, content, meta)。无 key → ok=False, meta.reason=not_configured（上层本地兜底）。"""
    tp = config.text_provider(with_keys=True)
    if not tp.get("key"):
        return False, "", dict(reason="not_configured", provider="local_split", model="local", cost_cny=0.0)
    model = tp.get("model") or "deepseek-chat"      # 模型名允许留空，由 /models 拉取后填入
    body = {"model": model, "messages": [{"role": "system", "content": system},
                                         {"role": "user", "content": user}], "max_tokens": max_tokens}
    t0 = time.time()
    try:
        with httpx.Client(**_client_kwargs(False)) as c:   # DeepSeek 国内直连（不设代理）
            r = c.post(tp["base_url"].rstrip("/") + "/chat/completions",
                       headers={"Authorization": "Bearer %s" % tp["key"]}, json=body)
            r.raise_for_status()
            data = r.json()
        content = data["choices"][0]["message"]["content"]
        usage = data.get("usage", {}) or {}
        cost = (usage.get("prompt_tokens", 0) / 1_000_000) * 1.0 + (usage.get("completion_tokens", 0) / 1_000_000) * 2.0
        return True, content, dict(provider="deepseek", model=model, cost_cny=round(cost, 6),
                                   latency_ms=int((time.time() - t0) * 1000), usage=usage)
    except Exception as e:                         # noqa: BLE001
        return False, "", dict(reason="call_failed", provider="deepseek", model=model, cost_cny=0.0,
                               message="%s: %s" % (type(e).__name__, str(e)[:200]),
                               latency_ms=int((time.time() - t0) * 1000))


def capabilities() -> Dict[str, Any]:
    return dict(
        image={p["id"]: p["key_set"] for p in config.image_providers()} | {"local_render": True},
        text={"deepseek": text_configured()},
        picked=(pick_image_provider() or {}).get("id", "local_render"),
    )
