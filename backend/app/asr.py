import os
from typing import TYPE_CHECKING, Iterable, Optional, Tuple

from .settings import settings

if TYPE_CHECKING:
    from faster_whisper import WhisperModel


class ASR:
    def __init__(self) -> None:
        self._model: Optional["WhisperModel"] = None

    def _ensure_loaded(self) -> None:
        if self._model is not None:
            return

        if os.name == "nt":
            os.environ.setdefault("KMP_DUPLICATE_LIB_OK", "TRUE")

        from faster_whisper import WhisperModel

        self._model = WhisperModel(
            settings.asr_model,
            device=settings.asr_device,
            compute_type=settings.asr_compute_type,
        )

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
