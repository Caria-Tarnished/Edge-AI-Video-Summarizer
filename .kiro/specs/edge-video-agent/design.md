# 设计文档

## 概述

端侧视频智能助手是一个桌面应用程序，采用 Electron + React 前端和 Python FastAPI 后端的混合架构。所有 AI 处理（语音识别、文本嵌入、大语言模型推理）都在用户本地设备上执行，确保数据隐私。

### 核心设计原则

1. **隐私优先**：所有数据处理在本地完成，零云端传输
2. **渐进式处理**：支持长视频的分段处理和断点续跑
3. **资源自适应**：根据硬件能力提供多档位性能配置
4. **模块化架构**：清晰的组件边界，便于测试和扩展

### 技术栈

- **前端**：Electron + React + TailwindCSS
- **后端**：Python 3.10+ + FastAPI
- **AI 模型**：
  - ASR: Faster-Whisper (CTranslate2)
  - LLM: Qwen2.5-7B-Instruct (GGUF, llama.cpp)
  - Embedding: BGE-M3 或 m3e-base
- **数据存储**：
  - 关系数据：SQLite
  - 向量数据：ChromaDB
  - 文件存储：本地文件系统
- **进程通信**：HTTP/WebSocket (前后端)，multiprocessing (后台任务)

## 架构

### 系统架构图

```
┌─────────────────────────────────────────────────────────────┐
│                        Electron 前端                         │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐   │
│  │ 视频播放器 │  │ 摘要视图  │  │ AI 助手  │  │ 库管理   │   │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘   │
│                          │                                   │
│                    HTTP/WebSocket                            │
└──────────────────────────┼──────────────────────────────────┘
                           │
┌──────────────────────────┼──────────────────────────────────┐
│                    FastAPI 后端                              │
│  ┌────────────────────────────────────────────────────┐     │
│  │              API 路由层                             │     │
│  │  /videos  /transcribe  /summarize  /chat  /jobs    │     │
│  └────────────────────────────────────────────────────┘     │
│                          │                                   │
│  ┌────────────────────────────────────────────────────┐     │
│  │            业务逻辑层（服务层）                      │     │
│  │  VideoService  TranscriptService  SummaryService    │     │
│  │  RAGService    JobService                           │     │
│  └────────────────────────────────────────────────────┘     │
│                          │                                   │
│  ┌────────────────────────────────────────────────────┐     │
│  │              AI 引擎层                              │     │
│  │  ASREngine  LLMEngine  EmbeddingEngine             │     │
│  └────────────────────────────────────────────────────┘     │
│                          │                                   │
│  ┌────────────────────────────────────────────────────┐     │
│  │            后台任务执行器                           │     │
│  │  JobQueue  WorkerPool  ProgressTracker             │     │
│  └────────────────────────────────────────────────────┘     │
└──────────────────────────┼──────────────────────────────────┘
                           │
┌──────────────────────────┼──────────────────────────────────┐
│                      数据层                                  │
│  ┌──────────┐  ┌──────────┐  ┌──────────────────────┐      │
│  │  SQLite  │  │ ChromaDB │  │  本地文件系统         │      │
│  │  元数据  │  │  向量库  │  │  视频/音频/关键帧     │      │
│  └──────────┘  └──────────┘  └──────────────────────┘      │
└─────────────────────────────────────────────────────────────┘
```

### 架构分层说明

1. **表现层（Electron 前端）**
   - 负责用户交互和数据展示
   - 通过 IPC 与 Electron 主进程通信
   - 通过 HTTP/WebSocket 与后端通信

2. **API 层（FastAPI 路由）**
   - RESTful API 端点
   - WebSocket 端点（实时进度推送）
   - 请求验证和错误处理

3. **业务逻辑层（服务层）**
   - 封装核心业务逻辑
   - 协调多个组件完成复杂操作
   - 事务管理和状态维护

4. **AI 引擎层**
   - 封装 AI 模型的加载和推理
   - 提供统一的接口供上层调用
   - 管理模型生命周期

5. **任务执行层**
   - 后台任务队列管理
   - 工作进程池
   - 进度跟踪和状态同步

6. **数据层**
   - SQLite：结构化元数据
   - ChromaDB：向量索引
   - 文件系统：二进制数据

## 组件和接口

### 前端组件

#### 1. VideoPlayer 组件

**职责**：视频播放和字幕显示

**接口**：
```typescript
interface VideoPlayerProps {
  videoId: string;
  videoUrl: string;
  transcript?: Transcript;
  onTimeUpdate?: (currentTime: number) => void;
  onSeek?: (targetTime: number) => void;
}

interface Transcript {
  segments: TranscriptSegment[];
}

interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}
```

**关键功能**：
- 视频播放控制（播放、暂停、跳转、倍速）
- 字幕同步显示
- 智能时间轴（章节标记）
- 键盘快捷键支持

#### 2. SummaryView 组件

**职责**：显示层级摘要和大纲

**接口**：
```typescript
interface SummaryViewProps {
  videoId: string;
  summary: VideoSummary;
  onTimestampClick: (timestamp: number) => void;
  onExport: (format: 'markdown' | 'html') => void;
}

interface VideoSummary {
  overall: string;
  chapters: Chapter[];
  keyEntities: string[];
}

interface Chapter {
  title: string;
  startTime: number;
  endTime: number;
  summary: string;
  keyframes: Keyframe[];
  subsections?: Chapter[];
}

interface Keyframe {
  timestamp: number;
  imagePath: string;
}
```

**关键功能**：
- 层级大纲展示（可展开/折叠）
- 关键帧缩略图显示
- 时间戳点击跳转
- 导出为 Markdown/HTML

#### 3. ChatAssistant 组件

**职责**：AI 问答交互

**接口**：
```typescript
interface ChatAssistantProps {
  videoId: string;
  onTimestampClick: (timestamp: number) => void;
}

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
  references?: TimestampReference[];
}

interface TimestampReference {
  timestamp: number;
  text: string;
}
```

**关键功能**：
- 聊天消息显示
- 流式响应渲染
- 时间戳引用可点击
- 对话历史管理

#### 4. LibraryView 组件

**职责**：视频库管理

**接口**：
```typescript
interface LibraryViewProps {
  videos: VideoMetadata[];
  onVideoSelect: (videoId: string) => void;
  onVideoImport: (file: File) => void;
  onSearch: (query: string) => void;
}

interface VideoMetadata {
  id: string;
  title: string;
  duration: number;
  thumbnailUrl: string;
  status: 'pending' | 'processing' | 'complete' | 'error';
  progress?: number;
  createdAt: Date;
  isFavorite: boolean;
}
```

**关键功能**：
- 视频列表展示
- 搜索和过滤
- 状态和进度显示
- 收藏管理

### 后端服务

#### 1. VideoService

**职责**：视频导入和预处理

**接口**：
```python
class VideoService:
    def import_video(self, file_path: str) -> Video:
        """导入视频文件，计算哈希，存储元数据"""
        pass
    
    def extract_audio(self, video_id: str) -> str:
        """提取音频为 16kHz WAV"""
        pass
    
    def extract_keyframes(
        self, 
        video_id: str, 
        method: str = 'fixed',  # 'fixed' or 'scene'
        interval: int = 10
    ) -> List[Keyframe]:
        """提取关键帧"""
        pass
    
    def get_video(self, video_id: str) -> Video:
        """获取视频元数据"""
        pass
```

#### 2. TranscriptService

**职责**：语音转写和文本处理

**接口**：
```python
class TranscriptService:
    def transcribe(
        self, 
        audio_path: str, 
        video_id: str,
        model_size: str = 'small'
    ) -> Transcript:
        """转写音频为带时间戳的文本"""
        pass
    
    def segment_transcript(
        self, 
        transcript: Transcript,
        segment_duration: int = 60,
        overlap: int = 5
    ) -> List[TranscriptSegment]:
        """将长转写分段"""
        pass
    
    def chunk_text(
        self, 
        transcript: Transcript,
        chunk_size: int = 500,
        overlap: int = 50
    ) -> List[TextChunk]:
        """将转写文本分块用于嵌入"""
        pass
    
    def get_transcript(self, video_id: str) -> Transcript:
        """获取视频的转写文本"""
        pass
```

#### 3. EmbeddingService

**职责**：文本向量化和检索

**接口**：
```python
class EmbeddingService:
    def embed_chunks(
        self, 
        chunks: List[TextChunk],
        video_id: str
    ) -> None:
        """生成嵌入向量并存入 ChromaDB"""
        pass
    
    def search(
        self, 
        query: str,
        video_id: Optional[str] = None,
        top_k: int = 5
    ) -> List[SearchResult]:
        """语义搜索"""
        pass
    
    def get_embedding(self, text: str) -> List[float]:
        """获取单个文本的嵌入向量"""
        pass
```

#### 4. SummaryService

**职责**：摘要生成

**接口**：
```python
class SummaryService:
    def generate_segment_summaries(
        self, 
        segments: List[TranscriptSegment],
        video_id: str
    ) -> List[SegmentSummary]:
        """Map 阶段：生成片段摘要"""
        pass
    
    def generate_chapter_summaries(
        self, 
        segment_summaries: List[SegmentSummary],
        video_id: str
    ) -> List[Chapter]:
        """Reduce 阶段：生成章节摘要"""
        pass
    
    def generate_overall_summary(
        self, 
        chapters: List[Chapter],
        video_id: str
    ) -> str:
        """生成总体摘要"""
        pass
    
    def extract_entities(
        self, 
        transcript: Transcript,
        video_id: str
    ) -> List[str]:
        """提取关键实体"""
        pass
```

#### 5. RAGService

**职责**：检索增强生成问答

**接口**：
```python
class RAGService:
    def answer_question(
        self, 
        question: str,
        video_id: str,
        conversation_history: List[Message] = None
    ) -> Answer:
        """回答用户问题"""
        pass
    
    def _retrieve_context(
        self, 
        question: str,
        video_id: str,
        top_k: int = 5
    ) -> List[TextChunk]:
        """检索相关上下文"""
        pass
    
    def _generate_answer(
        self, 
        question: str,
        context: List[TextChunk],
        history: List[Message]
    ) -> str:
        """生成答案"""
        pass
```

#### 6. JobService

**职责**：后台任务管理

**接口**：
```python
class JobService:
    def create_job(
        self, 
        job_type: str,
        video_id: str,
        params: Dict[str, Any]
    ) -> Job:
        """创建新任务"""
        pass
    
    def cancel_job(self, job_id: str) -> None:
        """取消任务"""
        pass
    
    def get_job_status(self, job_id: str) -> JobStatus:
        """获取任务状态"""
        pass
    
    def list_jobs(
        self, 
        video_id: Optional[str] = None,
        status: Optional[str] = None
    ) -> List[Job]:
        """列出任务"""
        pass
```

### AI 引擎

#### 1. ASREngine

**职责**：语音识别

**实现**：
```python
class ASREngine:
    def __init__(self, model_size: str = 'small', device: str = 'cpu'):
        self.model = WhisperModel(model_size, device=device, compute_type='int8')
    
    def transcribe(
        self, 
        audio_path: str,
        language: str = 'zh'
    ) -> Tuple[List[Segment], TranscribeInfo]:
        """转写音频"""
        segments, info = self.model.transcribe(
            audio_path,
            language=language,
            beam_size=1,
            vad_filter=True
        )
        return list(segments), info
```

**配置**：
- 模型大小：tiny, base, small, medium, large-v3
- 设备：cpu, cuda
- 计算类型：int8, float16, float32

#### 2. LLMEngine

**职责**：大语言模型推理

**实现**：
```python
class LLMEngine:
    def __init__(self, model_path: str, n_ctx: int = 4096):
        from llama_cpp import Llama
        self.model = Llama(
            model_path=model_path,
            n_ctx=n_ctx,
            n_threads=8,
            n_gpu_layers=0  # 根据硬件调整
        )
    
    def generate(
        self, 
        prompt: str,
        max_tokens: int = 2048,
        temperature: float = 0.7,
        stream: bool = False
    ) -> Union[str, Iterator[str]]:
        """生成文本"""
        response = self.model(
            prompt,
            max_tokens=max_tokens,
            temperature=temperature,
            stream=stream
        )
        
        if stream:
            return (chunk['choices'][0]['text'] for chunk in response)
        else:
            return response['choices'][0]['text']
```

**配置**：
- 模型格式：GGUF
- 上下文长度：2048-8192
- 量化：Q4_K_M, Q5_K_M, Q8_0

#### 3. EmbeddingEngine

**职责**：文本嵌入

**实现**：
```python
class EmbeddingEngine:
    def __init__(self, model_name: str = 'BAAI/bge-m3'):
        from sentence_transformers import SentenceTransformer
        self.model = SentenceTransformer(model_name)
    
    def encode(
        self, 
        texts: Union[str, List[str]],
        batch_size: int = 32
    ) -> np.ndarray:
        """生成嵌入向量"""
        return self.model.encode(
            texts,
            batch_size=batch_size,
            show_progress_bar=False
        )
```

**配置**：
- 模型：BGE-M3, m3e-base
- 向量维度：768 或 1024
- 批处理大小：根据内存调整

### 后台任务执行器

#### JobQueue 和 WorkerPool

**设计**：
```python
class JobQueue:
    def __init__(self, db_path: str):
        self.db = sqlite3.connect(db_path)
        self.workers: Dict[str, WorkerProcess] = {}
    
    def enqueue(self, job: Job) -> None:
        """将任务加入队列"""
        self._save_job_to_db(job)
        self._notify_workers()
    
    def start_workers(self, num_workers: int = 1) -> None:
        """启动工作进程"""
        for i in range(num_workers):
            worker = WorkerProcess(self.db_path, worker_id=i)
            worker.start()
            self.workers[worker.id] = worker
    
    def stop_workers(self) -> None:
        """停止所有工作进程"""
        for worker in self.workers.values():
            worker.stop()
            worker.join()

class WorkerProcess(multiprocessing.Process):
    def run(self):
        """工作进程主循环"""
        while not self.should_stop:
            job = self._fetch_next_job()
            if job:
                self._execute_job(job)
            else:
                time.sleep(1)
    
    def _execute_job(self, job: Job) -> None:
        """执行任务"""
        try:
            self._update_job_status(job.id, 'running')
            
            if job.type == 'transcribe':
                self._run_transcribe(job)
            elif job.type == 'embed':
                self._run_embed(job)
            elif job.type == 'summarize':
                self._run_summarize(job)
            
            self._update_job_status(job.id, 'completed')
        except Exception as e:
            self._update_job_status(job.id, 'failed', error=str(e))
```

**并发控制**：
- 根据性能档位限制并发任务数
- 同一视频的任务按依赖顺序执行
- 支持任务优先级

## 数据模型

### SQLite 数据库模式

#### videos 表

```sql
CREATE TABLE videos (
    id TEXT PRIMARY KEY,
    file_path TEXT NOT NULL,
    file_hash TEXT UNIQUE NOT NULL,
    title TEXT NOT NULL,
    duration REAL NOT NULL,
    file_size INTEGER NOT NULL,
    format TEXT NOT NULL,
    thumbnail_path TEXT,
    status TEXT NOT NULL,  -- 'pending', 'processing', 'complete', 'error'
    is_favorite BOOLEAN DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_videos_hash ON videos(file_hash);
CREATE INDEX idx_videos_status ON videos(status);
```

#### transcripts 表

```sql
CREATE TABLE transcripts (
    id TEXT PRIMARY KEY,
    video_id TEXT NOT NULL,
    language TEXT NOT NULL,
    model_version TEXT NOT NULL,
    segments_json TEXT NOT NULL,  -- JSON array of segments
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
);

CREATE INDEX idx_transcripts_video ON transcripts(video_id);
```

#### transcript_segments 表

```sql
CREATE TABLE transcript_segments (
    id TEXT PRIMARY KEY,
    transcript_id TEXT NOT NULL,
    start_time REAL NOT NULL,
    end_time REAL NOT NULL,
    text TEXT NOT NULL,
    segment_index INTEGER NOT NULL,
    FOREIGN KEY (transcript_id) REFERENCES transcripts(id) ON DELETE CASCADE
);

CREATE INDEX idx_segments_transcript ON transcript_segments(transcript_id);
CREATE INDEX idx_segments_time ON transcript_segments(start_time, end_time);
```

#### summaries 表

```sql
CREATE TABLE summaries (
    id TEXT PRIMARY KEY,
    video_id TEXT NOT NULL,
    overall_summary TEXT NOT NULL,
    chapters_json TEXT NOT NULL,  -- JSON array of chapters
    entities_json TEXT,  -- JSON array of key entities
    model_version TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
);

CREATE INDEX idx_summaries_video ON summaries(video_id);
```

#### keyframes 表

```sql
CREATE TABLE keyframes (
    id TEXT PRIMARY KEY,
    video_id TEXT NOT NULL,
    timestamp REAL NOT NULL,
    image_path TEXT NOT NULL,
    image_hash TEXT,
    width INTEGER,
    height INTEGER,
    extraction_method TEXT,  -- 'fixed' or 'scene'
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
);

CREATE INDEX idx_keyframes_video ON keyframes(video_id);
CREATE INDEX idx_keyframes_timestamp ON keyframes(video_id, timestamp);
```

#### jobs 表

```sql
CREATE TABLE jobs (
    id TEXT PRIMARY KEY,
    video_id TEXT NOT NULL,
    job_type TEXT NOT NULL,  -- 'transcribe', 'embed', 'summarize', 'extract_keyframes'
    status TEXT NOT NULL,  -- 'pending', 'running', 'completed', 'failed', 'cancelled'
    progress REAL DEFAULT 0,
    params_json TEXT,
    result_json TEXT,
    error_message TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    started_at TIMESTAMP,
    completed_at TIMESTAMP,
    FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
);

CREATE INDEX idx_jobs_video ON jobs(video_id);
CREATE INDEX idx_jobs_status ON jobs(status);
```

#### conversations 表

```sql
CREATE TABLE conversations (
    id TEXT PRIMARY KEY,
    video_id TEXT NOT NULL,
    messages_json TEXT NOT NULL,  -- JSON array of messages
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
);

CREATE INDEX idx_conversations_video ON conversations(video_id);
```

### ChromaDB 集合模式

#### video_chunks 集合

```python
collection_metadata = {
    "hnsw:space": "cosine",  # 余弦相似度
    "hnsw:construction_ef": 200,
    "hnsw:M": 16
}

# 文档结构
document = {
    "id": "video_id:chunk_index",
    "embedding": [0.1, 0.2, ...],  # 768 或 1024 维向量
    "document": "chunk text content",
    "metadata": {
        "video_id": "uuid",
        "start_time": 120.5,
        "end_time": 180.3,
        "chunk_index": 0,
        "content_hash": "sha256_hash"
    }
}
```

### 文件系统结构

```
~/.edge-video-agent/
├── config/
│   ├── config.yaml          # 应用配置
│   └── models.yaml          # 模型配置
├── data/
│   ├── database.db          # SQLite 数据库
│   └── chromadb/            # ChromaDB 数据
├── models/
│   ├── whisper/             # Whisper 模型
│   ├── llm/                 # LLM 模型 (GGUF)
│   └── embedding/           # Embedding 模型
├── storage/
│   ├── videos/              # 原始视频文件（可选，可引用外部路径）
│   ├── audio/               # 提取的音频文件
│   ├── keyframes/           # 关键帧图片
│   └── exports/             # 导出的摘要文件
└── logs/
    └── app.log              # 应用日志
```
