import os
import threading
from typing import TYPE_CHECKING, Iterable, Optional, Tuple

from .settings import settings

if TYPE_CHECKING:
    from faster_whisper import WhisperModel


class ASR:
    """
    【AI引擎封装：语音识别 (ASR)】
    封装了 faster-whisper 模型，用于将提取的音频 (Wav) 转录为文本。
    - 使用单例/实例级别的按需加载机制 `_ensure_loaded`。
    - 使用 `threading.Lock()` 确保在多线程环境下 (因为 JobWorker 是在线程中运行的) 模型实例只被加载一次，防止并发抢占显存。
    """
    def __init__(self) -> None:
        self._model: Optional["WhisperModel"] = None
        self._loaded_model_name: Optional[str] = None
        self._loaded_device: Optional[str] = None
        self._loaded_compute_type: Optional[str] = None
        self._lock = threading.Lock()

    def _ensure_loaded(self) -> None:
        model_name = os.getenv("ASR_MODEL", settings.asr_model)
        device = os.getenv("ASR_DEVICE", settings.asr_device)
        compute_type = os.getenv("ASR_COMPUTE_TYPE", settings.asr_compute_type)

        with self._lock:
            if self._model is not None:
                if (
                    str(self._loaded_model_name or "") == str(model_name or "")
                    and str(self._loaded_device or "") == str(device or "")
                    and str(self._loaded_compute_type or "")
                    == str(compute_type or "")
                ):
                    return

                self._model = None
                self._loaded_model_name = None
                self._loaded_device = None
                self._loaded_compute_type = None

            if os.name == "nt":
                os.environ.setdefault("KMP_DUPLICATE_LIB_OK", "TRUE")

            from faster_whisper import WhisperModel

            self._model = WhisperModel(
                str(model_name or settings.asr_model),
                device=str(device or "cpu"),
                compute_type=str(compute_type or "int8"),
            )
            self._loaded_model_name = str(model_name or "")
            self._loaded_device = str(device or "")
            self._loaded_compute_type = str(compute_type or "")

    def transcribe_wav(
        self,
        wav_path: str,
    ) -> Tuple[Iterable, object]:
        self._ensure_loaded()
        assert self._model is not None
        return self._model.transcribe(
            wav_path,
            language=settings.asr_language,
            beam_size=1,
            vad_filter=True,
        )
