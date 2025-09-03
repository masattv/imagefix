'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Cropper from 'react-easy-crop';
import type { Area } from 'react-easy-crop';
import NextImage from 'next/image';

const TARGET_WIDTH = 320;
const TARGET_HEIGHT = 366;
const TARGET_AR = TARGET_WIDTH / TARGET_HEIGHT;
const MAX_BYTES = 2 * 1024 * 1024;

// 初期合わせ（顔を大きめ）
const DEFAULT_FACE_Y_FRACTION = 0.38; // 顔中心をやや上に
const DESIRED_FACE_FRAC = 0.48;       // 顔の高さ ≒ 出力高さの48%

// FaceDetector 型を宣言（ts-ignore不要化）
declare global {
  interface Window {
    FaceDetector?: new (opts?: { fastMode?: boolean; maxDetectedFaces?: number }) => {
      detect: (source: CanvasImageSource) => Promise<Array<{ boundingBox: { x: number; y: number; width: number; height: number } }>>;
    };
  }
}

type DetectBox = { x: number; y: number; width: number; height: number } | null;

// Canvas 2D の拡張: imageSmoothingQuality を型で安全に扱う
type Ctx2DWithQuality = CanvasRenderingContext2D & {
  imageSmoothingQuality?: 'low' | 'medium' | 'high';
};

export default function Page() {
  // 画像 & Cropper
  const [srcUrl, setSrcUrl] = useState<string | null>(null);
  const [imgEl, setImgEl] = useState<HTMLImageElement | null>(null);
  const [crop, setCrop] = useState<{ x: number; y: number }>({ x: 0, y: 0 }); // %
  const [zoom, setZoom] = useState<number>(1);
  const [croppedAreaPx, setCroppedAreaPx] = useState<Area | null>(null);
  const [faceYFrac, setFaceYFrac] = useState<number>(DEFAULT_FACE_Y_FRACTION);

  // 出力
  const [outUrl, setOutUrl] = useState<string | null>(null);
  const [outInfo, setOutInfo] = useState<{ bytes: number; q: number } | null>(null);
  const [busy, setBusy] = useState<boolean>(false);
  const [msg, setMsg] = useState<string>('');

  /* -------------------- 画像ロード -------------------- */
  const onPick = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setOutUrl(null); setOutInfo(null); setMsg('');
    const f = e.target.files?.[0];
    if (!f) return;
    const url = URL.createObjectURL(f);
    setSrcUrl(url);
  }, []);

  useEffect(() => {
    if (!srcUrl) return;
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => setImgEl(img);
    img.src = srcUrl;
    return () => setImgEl(null);
  }, [srcUrl]);

  /* -------------------- 顔検出（対応ブラウザのみ） -------------------- */
  const detectFace = useCallback(async (source: HTMLImageElement): Promise<DetectBox> => {
    try {
      if (typeof window !== 'undefined' && typeof window.FaceDetector === 'function') {
        const det = new window.FaceDetector({ fastMode: true, maxDetectedFaces: 1 });
        const faces = await det.detect(source);
        if (faces && faces[0]?.boundingBox) {
          const b = faces[0].boundingBox;
          return { x: b.x, y: b.y, width: b.width, height: b.height };
        }
      }
    } catch {
      // 対応外 or 例外時は null でフォールバック
    }
    return null;
  }, []);

  /* -------------------- 初期オート合わせ -------------------- */
  const autoAlign = useCallback(async () => {
    if (!imgEl) return;
    const W = imgEl.naturalWidth, H = imgEl.naturalHeight;

    // zoom=1 の視野高さ（アスペクト固定）だけ計算
    const baseH = (W / TARGET_AR <= H) ? Math.round(W / TARGET_AR) : H;

    const face = await detectFace(imgEl);
    let desiredH = baseH;

    if (face) {
      const faceH = face.height;
      desiredH = Math.max(32, Math.min(H, Math.round(faceH / DESIRED_FACE_FRAC)));
    }
    const initZoom = Math.max(1, Math.min(5, baseH / desiredH));

    let cx = W / 2, cy = H / 2;
    if (face) {
      cx = face.x + face.width / 2;
      cy = face.y + face.height / 2;
    }

    const viewH = baseH / initZoom;
    const viewW = viewH * TARGET_AR;

    let left = cx - viewW / 2;
    let top  = cy - faceYFrac * viewH;

    // 画像内に収める
    left = Math.max(0, Math.min(left, W - viewW));
    top  = Math.max(0, Math.min(top,  H - viewH));

    const offsetX = - (left / W) * 100;
    const offsetY = - (top  / H) * 100;

    setZoom(initZoom);
    setCrop({ x: offsetX, y: offsetY });
  }, [imgEl, detectFace, faceYFrac]);

  useEffect(() => { if (imgEl) autoAlign(); }, [imgEl, autoAlign]);

  /* -------------------- 顔Y位置スライダ：Yのみ微調整 -------------------- */
  const nudgeFaceY = useCallback((v: number) => {
    setFaceYFrac(v);
    if (!imgEl) return;
    const W = imgEl.naturalWidth, H = imgEl.naturalHeight;

    const baseH = (W / TARGET_AR <= H) ? Math.round(W / TARGET_AR) : H;
    const viewH = baseH / zoom;

    const curLeft = -crop.x * 0.01 * W;
    const curTop  = -crop.y * 0.01 * H;

    const cyApprox = curTop + faceYFrac * viewH;
    const newTop = Math.max(0, Math.min(cyApprox - v * viewH, H - viewH));

    const offsetX = - (curLeft / W) * 100;
    const offsetY = - (newTop  / H) * 100;
    setCrop({ x: offsetX, y: offsetY });
  }, [imgEl, zoom, crop, faceYFrac]);

  /* -------------------- Cropper 完了 -------------------- */
  const onCropComplete = useCallback((_area: Area, areaPx: Area) => {
    setCroppedAreaPx(areaPx);
  }, []);

  /* -------------------- JPG 圧縮（≤2MB） -------------------- */
  const dataURLtoBlob = (dataUrl: string) => {
    const arr = dataUrl.split(',');
    const mime = arr[0].match(/:(.*?);/)?.[1] || 'image/jpeg';
    const bstr = atob(arr[1]);
    let n = bstr.length;
    const u8 = new Uint8Array(n);
    while (n--) u8[n] = bstr.charCodeAt(n);
    return new Blob([u8], { type: mime });
  };

  const makeJpegBlob = useCallback((canvas: HTMLCanvasElement, q: number) =>
    new Promise<Blob>(res => {
      canvas.toBlob(b => {
        if (b) res(b);
        else res(dataURLtoBlob(canvas.toDataURL('image/jpeg', q)));
      }, 'image/jpeg', q);
    }), []);

  const encodeJpegUnder2MB = useCallback(async (canvas: HTMLCanvasElement) => {
    let lo = 0.5, hi = 0.95;
    let best: { blob: Blob; q: number } | null = null;
    for (let i = 0; i < 8; i++) {
      const q = (lo + hi) / 2;
      const blob = await makeJpegBlob(canvas, q);
      if (blob.size <= MAX_BYTES) { best = { blob, q }; lo = q; } else { hi = q; }
    }
    if (!best) {
      const blob = await makeJpegBlob(canvas, 0.5);
      best = { blob, q: 0.5 };
    }
    return best;
  }, [makeJpegBlob]);

  /* -------------------- 書き出し -------------------- */
  const doExport = useCallback(async () => {
    if (!imgEl || !croppedAreaPx) return;
    setBusy(true);
    setMsg('書き出し中…');
    try {
      const { x, y, width, height } = croppedAreaPx;

      const canvas = document.createElement('canvas');
      canvas.width = TARGET_WIDTH;
      canvas.height = TARGET_HEIGHT;
      const ctx = canvas.getContext('2d') as Ctx2DWithQuality;
      ctx.imageSmoothingEnabled = true;
      if (typeof ctx.imageSmoothingQuality !== 'undefined') {
        ctx.imageSmoothingQuality = 'high';
      }
      ctx.drawImage(imgEl, x, y, width, height, 0, 0, TARGET_WIDTH, TARGET_HEIGHT);

      const best = await encodeJpegUnder2MB(canvas);
      const url = URL.createObjectURL(best.blob);
      setOutUrl(url);
      setOutInfo({ bytes: best.blob.size, q: best.q });
      setMsg('完了！プレビューを確認してください。');
    } catch (e) {
      console.error(e);
      setMsg('処理に失敗しました。別の画像でお試しください。');
    } finally {
      setBusy(false);
    }
  }, [imgEl, croppedAreaPx, encodeJpegUnder2MB]);

  const prettySize = useMemo(() => outInfo ? (outInfo.bytes / (1024 * 1024)).toFixed(2) + ' MB' : '—', [outInfo]);

  const onDownload = useCallback(() => {
    if (!outUrl) return;
    const a = document.createElement('a');
    a.href = outUrl;
    a.download = `id-photo_${TARGET_WIDTH}x${TARGET_HEIGHT}.jpg`;
    a.click();
  }, [outUrl]);

  const clearAll = useCallback(() => {
    setSrcUrl(null); setImgEl(null); setOutUrl(null); setOutInfo(null); setMsg('');
    setZoom(1); setCrop({ x: 0, y: 0 }); setFaceYFrac(DEFAULT_FACE_Y_FRACTION);
  }, []);

  /* -------------------- UI -------------------- */
  return (
    <div className="app">
      <header className="header">
        <div className="brand">
          <LogoIcon /> <b>ID Photo Maker</b>
          <span className="pill">{TARGET_WIDTH}×{TARGET_HEIGHT} / JPG / ≤2MB</span>
        </div>
        <a href="#guide" className="link">ガイド</a>
      </header>

      <main className="container">
        <section className="col">
          <div className="card">
            <ol className="steps">
              <li><span>1</span> アップロード</li>
              <li><span>2</span> 位置あわせ</li>
              <li><span>3</span> 書き出し</li>
            </ol>
          </div>

          <div className="card">
            <div className="card-head">
              <div className="row"><UploadIcon /> 画像をアップロードしてトリミング</div>
              <small className="muted">JPG / PNG / HEIC 推奨</small>
            </div>

            <div className="grid2">
              {/* ドロップゾーン */}
              <div>
                <label htmlFor="file" className="dropzone">
                  <div className="dz-icon"><UploadIcon /></div>
                  <div className="dz-title">ドラッグ＆ドロップ / クリックして選択</div>
                  <div className="dz-sub">顔と上半身が写っている写真を選んでください</div>
                </label>
                <input id="file" type="file" accept="image/*" className="hidden" onChange={onPick} />

                <div className="note">
                  <p className="note-title">ヒント</p>
                  <ul>
                    <li>明るい場所・正面・無表情がベスト</li>
                    <li>帽子/サングラスは避ける（公的用途想定）</li>
                    <li>肩が少し入る程度が自然です</li>
                  </ul>
                </div>
              </div>

              {/* Cropper */}
              <div className="cropbox">
                {srcUrl ? (
                  <>
                    <Cropper
                      image={srcUrl}
                      crop={crop}
                      zoom={zoom}
                      aspect={TARGET_AR}
                      onCropChange={setCrop}
                      onZoomChange={setZoom}
                      onCropComplete={onCropComplete}
                      restrictPosition
                      showGrid={false}
                      zoomWithScroll
                    />
                    {/* 目線ガイド */}
                    <div className="guide-line" style={{ top: `${faceYFrac * 100}%` }} />
                  </>
                ) : (
                  <div className="placeholder">ここにトリミングエリアが表示されます</div>
                )}
              </div>
            </div>
          </div>

          <div className="card">
            <div className="row head"><TunerIcon /> <b>調整</b></div>

            <div className="grid3">
              <div>
                <label className="label">出力サイズ</label>
                <select className="select" value={`${TARGET_WIDTH}x${TARGET_HEIGHT}`} onChange={() => alert('今回は 320×366 固定です')}>
                  <option>{TARGET_WIDTH} × {TARGET_HEIGHT}（推奨）</option>
                </select>
                <small className="hint">比率は自動で維持されます</small>
              </div>

              <div>
                <label className="label">ズーム</label>
                <input type="range" min={1} max={5} step={0.01} className="range" value={zoom} onChange={(e) => setZoom(parseFloat(e.target.value))} />
                <small className="hint">ホイール / ピンチでも操作可</small>
              </div>

              <div>
                <label className="label">顔の位置（縦）</label>
                <input type="range" min={0.32} max={0.44} step={0.005} className="range" value={faceYFrac} onChange={(e) => nudgeFaceY(parseFloat(e.target.value))} />
                <small className="hint">目〜鼻がやや上に来るのが自然</small>
              </div>
            </div>

            <div className="actions">
              <button onClick={doExport} disabled={!srcUrl || !imgEl || !croppedAreaPx || busy} className="btn primary">
                <PlayIcon /> 320×366 に書き出し
              </button>
              <button onClick={autoAlign} disabled={!imgEl} className="btn outline">
                <WandIcon /> 自動合わせ
              </button>
              <button onClick={clearAll} className="btn outline">
                <TrashIcon /> クリア
              </button>
              <span className="muted">JPG / ≤ 2 MB に自動調整</span>
            </div>

            {msg && <div className="msg">{msg}</div>}
          </div>
        </section>

        {/* 右：プレビュー */}
        <section className="col">
          <div className="card">
            <div className="row between">
              <div className="row"><EyeIcon /> <b>出力プレビュー</b></div>
              <small className="muted">背景はそのまま</small>
            </div>

            <div className="out">
              <div className="out-box">
                {outUrl ? (
                  <NextImage
                    src={outUrl}
                    alt="output"
                    width={TARGET_WIDTH}
                    height={TARGET_HEIGHT}
                    unoptimized
                    priority
                  />
                ) : (
                  <div className="placeholder">まだ出力がありません</div>
                )}
              </div>
              <div className="out-info">
                <div className="ibox"><div className="cap">サイズ</div><div className="val">{TARGET_WIDTH} × {TARGET_HEIGHT} px</div></div>
                <div className="ibox"><div className="cap">形式</div><div className="val">JPEG（自動圧縮）</div></div>
                <div className="ibox"><div className="cap">ファイルサイズ</div><div className="val">{prettySize}</div></div>
                <div className="ibox"><div className="cap">品質</div><div className="val">{outInfo ? outInfo.q.toFixed(2) : '—'}</div></div>

                <div className="actions mt">
                  <button onClick={onDownload} disabled={!outUrl} className="btn success">
                    <DownloadIcon /> JPG をダウンロード
                  </button>
                </div>
              </div>
            </div>
          </div>

          <div id="guide" className="card">
            <div className="row"><InfoIcon /> <b>ガイドライン</b></div>
            <ul className="list">
              <li>顔（顎〜頭頂）が高さの 65–75% に収まるのが目安</li>
              <li>目のラインはやや上（全高の約 60%）が自然です</li>
              <li>背景は変更せず、露出の極端な変化を避けてください</li>
            </ul>
          </div>
        </section>
      </main>

      <footer className="footer">
        画像はすべてブラウザ内で処理され、サーバにアップロードされません。
      </footer>

      {/* ===== CSS（バニラ / styled-jsx global）===== */}
      <style jsx global>{`
        :root { --bg:#f7f7f8; --card:#fff; --bd:#e5e7eb; --txt:#171717; --muted:#6b7280; --accent:#0a0a0a; --ok:#059669; }
        *{box-sizing:border-box}
        html,body{height:100%}
        body{margin:0;background:var(--bg);color:var(--txt);font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif}
        .hidden{display:none}

        .header{position:sticky;top:0;z-index:10;backdrop-filter:saturate(180%) blur(8px);background:rgba(255,255,255,.8);border-bottom:1px solid var(--bd);display:flex;justify-content:space-between;align-items:center}
        .brand{display:flex;align-items:center;gap:8px;padding:10px 16px}
        .pill{display:inline-block;font-size:12px;color:#52525b;background:#f4f4f5;border:1px solid #e4e4e7;border-radius:9999px;padding:2px 8px;margin-left:8px}
        .link{margin-right:16px;border:1px solid var(--bd);padding:6px 8px;border-radius:8px;color:#52525b;text-decoration:none}
        .link:hover{background:#fafafa}

        .container{max-width:1100px;margin:16px auto;padding:0 16px;display:grid;grid-template-columns:1.1fr .9fr;gap:16px}
        @media (max-width: 900px){ .container{grid-template-columns:1fr} }

        .card{background:var(--card);border:1px solid var(--bd);border-radius:16px;box-shadow:0 1px 2px rgba(0,0,0,.03);padding:12px}
        .card-head{display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid var(--bd);padding:8px 0 10px 0;margin:-12px -12px 12px -12px;padding-left:12px;padding-right:12px}
        .muted{color:var(--muted);font-size:12px}

        .steps{display:flex;gap:8px;list-style:none;margin:0;padding:0}
        .steps li{display:flex;align-items:center;gap:8px}
        .steps li span{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border:1px solid var(--bd);border-radius:9999px;background:#fff;font-weight:600}

        .grid2{display:grid;gap:12px;grid-template-columns:1fr 1fr}
        @media (max-width: 900px){ .grid2{grid-template-columns:1fr} }
        .grid3{display:grid;gap:12px;grid-template-columns:repeat(3,1fr)}
        @media (max-width: 900px){ .grid3{grid-template-columns:1fr} }

        .dropzone{display:block;text-align:center;border:1px dashed var(--bd);border-radius:12px;background:#fafafa;padding:18px;cursor:pointer}
        .dz-icon{margin:0 auto 8px;display:grid;place-items:center;width:40px;height:40px;border-radius:9999px;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.05)}
        .dz-title{font-weight:600}
        .dz-sub{font-size:12px;color:#6b7280;margin-top:4px}

        .note{background:#f8fafc;border:1px solid var(--bd);border-radius:8px;padding:8px;margin-top:10px;font-size:13px;color:#334155}
        .note-title{font-weight:600;margin:0 0 6px 0}
        .note ul{margin:0;padding-left:16px}

        .cropbox{position:relative;aspect-ratio:${TARGET_WIDTH}/${TARGET_HEIGHT};overflow:hidden;border:1px solid var(--bd);border-radius:12px;background:#f1f5f9}
        .placeholder{position:absolute;inset:0;display:grid;place-items:center;color:#6b7280;font-size:14px}
        .guide-line{position:absolute;left:0;right:0;border-top:1px dashed rgba(16,185,129,.8);pointer-events:none}

        .row{display:flex;align-items:center;gap:8px}
        .row.between{justify-content:space-between}
        .head{margin-bottom:4px}
        .label{display:block;font-size:12px;color:#475569;margin-bottom:4px}
        .select,.range{width:100%}
        .select{padding:8px 10px;border:1px solid var(--bd);border-radius:10px;background:#fff}
        .range{accent-color:#111}

        .actions{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:10px}
        .btn{display:inline-flex;align-items:center;gap:8px;border-radius:12px;padding:10px 14px;font-size:14px;border:1px solid var(--bd);background:#fff;cursor:pointer}
        .btn svg{width:16px;height:16px}
        .btn:hover{background:#f8fafc}
        .btn.primary{background:#111;color:#fff;border-color:#111}
        .btn.primary:hover{background:#000}
        .btn.success{background:#059669;color:#fff;border-color:#059669}
        .btn.success:hover{background:#047857}
        .btn.outline{background:#fff}
        .btn:disabled{opacity:.5;cursor:not-allowed}
        .mt{margin-top:8px}
        .msg{margin-top:8px;font-size:14px}

        .out{display:flex;gap:12px;align-items:flex-start}
        @media (max-width: 900px){ .out{flex-direction:column} }
        .out-box{position:relative;width:${TARGET_WIDTH}px;aspect-ratio:${TARGET_WIDTH}/${TARGET_HEIGHT};border:1px solid var(--bd);border-radius:8px;background:#fff;overflow:hidden}
        .out-info{flex:1}
        .ibox{background:#f8fafc;border:1px solid var(--bd);border-radius:8px;padding:8px;margin-bottom:8px}
        .ibox .cap{font-size:12px;color:#64748b}
        .ibox .val{font-weight:600}

        .list{margin:8px 0 0 16px}
        .list li{margin-bottom:4px}

        .footer{max-width:1100px;margin:12px auto 28px auto;padding:0 16px;color:#6b7280;font-size:12px}
      `}</style>
    </div>
  );
}

/* ====== SVG Icons ====== */
function LogoIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" {...props} width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="4" />
      <path d="M8 13h8M8 9h5" />
    </svg>
  );
}
function UploadIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" {...props} width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="M7 10l5-5 5 5" />
      <path d="M12 15V5" />
    </svg>
  );
}
function TunerIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" {...props} width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 21v-7" /><path d="M4 10V3" /><path d="M12 21v-9" /><path d="M12 8V3" /><path d="M20 21V8" /><path d="M20 5V3" />
    </svg>
  );
}
function PlayIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" {...props} width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="5 3 19 12 5 21 5 3" />
    </svg>
  );
}
function WandIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" {...props} width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M15 7l-1 2-2 1 2 1 1 2 1-2 2-1-2-1-1-2z" />
      <path d="M2 22l8-8" />
    </svg>
  );
}
function EyeIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" {...props} width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}
function DownloadIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" {...props} width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="M7 10l5 5 5-5" />
      <path d="M12 15V3" />
    </svg>
  );
}
function TrashIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" {...props} width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /><path d="M10 11v6" /><path d="M14 11v6" /><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
    </svg>
  );
}
function InfoIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" {...props} width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" /><path d="M12 16v-4" /><path d="M12 8h.01" />
    </svg>
  );
}
