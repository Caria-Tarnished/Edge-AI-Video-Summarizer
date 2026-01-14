from http import HTTPStatus
from typing import Any, cast

import dashscope

from .settings import settings


def _looks_like_zh(s: str) -> bool:
    s2 = str(s or "")
    for ch in s2[:400]:
        if "\u4e00" <= ch <= "\u9fff":
            return True
    return False


def _normalize_output_language(
    v: str,
    hint_text: str = "",
) -> str:
    lang = str(v or "").strip().lower() or "zh"
    if lang not in ("zh", "en", "auto"):
        lang = "zh"
    if lang == "auto":
        if _looks_like_zh(hint_text):
            return "zh"
        return "en"
    return lang


def summarize(
    text: str,
    api_key: str = "",
    output_language: str = "zh",
) -> str:
    if not settings.enable_cloud_summary:
        return "CLOUD_SUMMARY_DISABLED"

    effective_key = api_key.strip() or settings.dashscope_api_key
    if not effective_key:
        return "MISSING_DASHSCOPE_API_KEY"

    if not text or len(text.strip()) < 10:
        return "TEXT_TOO_SHORT"

    dashscope.api_key = effective_key

    transcript_text = text[:15000]

    lang = _normalize_output_language(
        output_language,
        hint_text=text,
    )
    if lang == "en":
        prompt = (
            "You are a professional video content assistant. "
            "Based on the following transcript, write a concise "
            "English summary covering the main points and important "
            "details.\n\n"
            "Transcript:\n"
            + transcript_text
        )
    else:
        prompt = (
            "\u4f60\u662f\u4e00\u4e2a\u4e13\u4e1a\u7684"
            "\u89c6\u9891\u5185\u5bb9"
            "\u6574\u7406\u52a9\u624b\u3002\u8bf7\u6839\u636e\u4ee5\u4e0b"
            "\u89c6\u9891\u8f6c\u5199\u6587\u672c\uff0c"
            "\u751f\u6210\u4e00\u4efd"
            "\u7b80\u6d01\u7684\u4e2d\u6587\u6458\u8981\u3002"
            "\u4e3b\u8981\u5305\u542b\u6838\u5fc3\u89c2\u70b9\u548c"
            "\u91cd\u8981"
            "\u7ec6\u8282\u3002\n\n"
            "\u6587\u672c\u5185\u5bb9\uff1a\n"
            + transcript_text
        )

    resp = dashscope.Generation.call(
        model=settings.cloud_llm_model,
        messages=cast(Any, [{"role": "user", "content": prompt}]),
        result_format="message",
    )
    resp = cast(Any, resp)

    if resp.status_code == HTTPStatus.OK:
        return resp.output.choices[0]["message"]["content"]

    return f"ERROR: {resp.code} - {resp.message}"
