from http import HTTPStatus
from typing import Any, cast

import dashscope

from .settings import settings


def summarize(text: str, api_key: str = "") -> str:
    if not settings.enable_cloud_summary:
        return "CLOUD_SUMMARY_DISABLED"

    effective_key = api_key.strip() or settings.dashscope_api_key
    if not effective_key:
        return "MISSING_DASHSCOPE_API_KEY"

    if not text or len(text.strip()) < 10:
        return "TEXT_TOO_SHORT"

    dashscope.api_key = effective_key

    prompt = (
        "你是一个专业的视频内容整理助手。请根据以下视频转写文本，"
        "生成一份简洁的中文摘要。主要包含核心观点和重要细节。\n\n"
        f"文本内容：\n{text[:15000]}"
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
