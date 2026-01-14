import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type VideoItem } from "../api/backend";

type UiLang = "zh" | "en";

type Props = {
  uiLang?: UiLang;
  onOpenVideo: (videoId: string) => void;
};

function fmtBytes(n: number | null | undefined): string {
  const v = typeof n === "number" && isFinite(n) ? n : 0;
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  if (v < 1024 * 1024 * 1024) return `${(v / (1024 * 1024)).toFixed(1)} MB`;
  return `${(v / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function fmtDuration(seconds: number | null | undefined): string {
  const v = typeof seconds === "number" && isFinite(seconds) ? seconds : 0;
  const s = Math.max(0, Math.floor(v));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  if (hh > 0)
    return `${hh}:${String(mm).padStart(2, "0")}:${String(ss).padStart(
      2,
      "0"
    )}`;
  return `${mm}:${String(ss).padStart(2, "0")}`;
}

export default function LibraryPage({ uiLang = "zh", onOpenVideo }: Props) {
  const [items, setItems] = useState<VideoItem[]>([]);
  const [total, setTotal] = useState<number>(0);
  const [busy, setBusy] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const canPickFile = !!window.electronAPI?.openVideoFile;

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.listVideos({ limit: 50, offset: 0 });
      setItems(Array.isArray(res.items) ? res.items : []);
      setTotal(typeof res.total === "number" ? res.total : 0);
    } catch (e: any) {
      const msg = e && e.message ? String(e.message) : String(e);
      setError(msg);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const onDelete = useCallback(
    async (videoId: string) => {
      setInfo(null);
      setError(null);

      const ok = window.confirm(
        uiLang === "en"
          ? "Delete this workspace item? This will remove app-generated data (transcripts/summaries/keyframes/index) but will NOT delete the original video file."
          : "\u5220\u9664\u8be5\u5de5\u4f5c\u533a\u4efb\u52a1\uff1f\u8fd9\u4f1a\u5220\u9664\u5e94\u7528\u751f\u6210\u7684\u6570\u636e\uff08\u8f6c\u5199/\u6458\u8981/\u5173\u952e\u5e27/\u7d22\u5f15\u7b49\uff09\uff0c\u4f46\u4e0d\u4f1a\u5220\u9664\u539f\u59cb\u89c6\u9891\u6587\u4ef6\u3002"
      );
      if (!ok) return;

      const deleteFile = window.confirm(
        uiLang === "en"
          ? "Also delete the original video file from disk? (Default: Cancel = keep file)"
          : "\u662f\u5426\u540c\u65f6\u5220\u9664\u78c1\u76d8\u4e0a\u7684\u539f\u59cb\u89c6\u9891\u6587\u4ef6\uff1f\uff08\u9ed8\u8ba4\u70b9\u53d6\u6d88 = \u4fdd\u7559\u6587\u4ef6\uff09"
      );

      setBusy(true);
      try {
        const res = await api.deleteVideo(videoId, {
          delete_file: deleteFile,
        });

        if (deleteFile) {
          if (res.file_deleted) {
            setInfo(
              uiLang === "en"
                ? "Deleted (workspace + file removed)"
                : "\u5df2\u5220\u9664\uff08\u5de5\u4f5c\u533a + \u6587\u4ef6\u5df2\u5220\u9664\uff09"
            );
          } else if (res.file_delete_error) {
            setInfo(
              uiLang === "en"
                ? `Deleted (workspace). File delete failed: ${res.file_delete_error}`
                : `\u5df2\u5220\u9664\uff08\u5de5\u4f5c\u533a\uff09\uff0c\u6587\u4ef6\u5220\u9664\u5931\u8d25\uff1a${res.file_delete_error}`
            );
          } else {
            setInfo(
              uiLang === "en"
                ? "Deleted (workspace). File not deleted."
                : "\u5df2\u5220\u9664\uff08\u5de5\u4f5c\u533a\uff09\uff0c\u672a\u5220\u9664\u6587\u4ef6\u3002"
            );
          }
        } else {
          setInfo(uiLang === "en" ? "Deleted" : "\u5df2\u5220\u9664");
        }
        await load();
      } catch (e: any) {
        const msg = e && e.message ? String(e.message) : String(e);
        setError(msg);
      } finally {
        setBusy(false);
      }
    },
    [load, uiLang]
  );

  const onImport = useCallback(async () => {
    setInfo(null);
    setError(null);
    if (!window.electronAPI?.openVideoFile) {
      setError("Electron API not available");
      return;
    }

    const p = await window.electronAPI.openVideoFile();
    if (!p) {
      return;
    }

    setBusy(true);
    try {
      const v = await api.importVideo(p);
      const title = v && (v as any).title ? String((v as any).title) : "";
      setInfo(title ? `Imported: ${title}` : "Imported");
      await load();
    } catch (e: any) {
      const msg = e && e.message ? String(e.message) : String(e);
      setError(msg);
    } finally {
      setBusy(false);
    }
  }, [load]);

  const summaryText = useMemo(() => {
    const n = items.length;
    return `Total: ${total} | Loaded: ${n}`;
  }, [items.length, total]);

  return (
    <div className="stack">
      <div className="card">
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
          }}
        >
          <h2 style={{ margin: 0 }}>{uiLang === "en" ? "Workspace" : "\u5de5\u4f5c\u533a"}</h2>
          <div className="row" style={{ marginTop: 0 }}>
            <button className="btn" onClick={load} disabled={busy}>
              {"\u5237\u65b0"}
            </button>
            <button
              className="btn primary"
              onClick={onImport}
              disabled={busy || !canPickFile}
            >
              {"\u5bfc\u5165\u89c6\u9891"}
            </button>
          </div>
        </div>

        <div className="muted" style={{ marginTop: 8 }}>
          {summaryText}
        </div>

        {!canPickFile ? (
          <div className="alert alert-error">
            {
              "\u5f53\u524d\u4e0d\u662f Electron \u73af\u5883\uff0c\u65e0\u6cd5\u4f7f\u7528\u6587\u4ef6\u9009\u62e9\u5bf9\u8bdd\u6846\u3002"
            }
          </div>
        ) : null}

        {error ? <div className="alert alert-error">{error}</div> : null}
        {info ? <div className="alert alert-info">{info}</div> : null}
      </div>

      {items.length === 0 ? (
        <div className="card">
          <div className="muted">
            {
              "\u6682\u65e0\u89c6\u9891\u3002\u53ef\u70b9\u51fb\u300c\u5bfc\u5165\u89c6\u9891\u300d\u6dfb\u52a0\u4e00\u4e2a\u672c\u5730\u89c6\u9891\u6587\u4ef6\u3002"
            }
          </div>
        </div>
      ) : (
        <div className="card">
          {items.map((v) => (
            <div key={v.id} className="subcard">
              <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10 }}>
                <div style={{ fontWeight: 700, minWidth: 0, flex: 1 }}>{String(v.title || v.id)}</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div className={String(v.status) === 'completed' ? 'v ok' : 'v'}>{String(v.status)}</div>
                  <button className="btn" onClick={() => onOpenVideo(String(v.id))} disabled={busy}>
                    {'\u8be6\u60c5'}
                  </button>
                  <button
                    className="btn"
                    onClick={() => onDelete(String(v.id))}
                    disabled={busy}
                  >
                    {uiLang === 'en' ? 'Delete' : '\u5220\u9664'}
                  </button>
                </div>
              </div>

              <div className="kv">
                <div className="k">id</div>
                <div className="v">{String(v.id)}</div>
              </div>
              <div className="kv">
                <div className="k">duration</div>
                <div className="v">{fmtDuration(Number(v.duration))}</div>
              </div>
              <div className="kv">
                <div className="k">size</div>
                <div className="v">{fmtBytes(Number(v.file_size))}</div>
              </div>
              <div className="kv">
                <div className="k">created_at</div>
                <div className="v">{String(v.created_at || "")}</div>
              </div>

              <div
                className="muted"
                style={{ marginTop: 8, wordBreak: "break-all" }}
              >
                {String(v.file_path || "")}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
