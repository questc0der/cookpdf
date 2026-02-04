"use client";

import { useMemo, useRef, useState } from "react";

type UploadState =
  | { status: "idle" }
  | { status: "ready"; file: File }
  | { status: "uploading"; file: File }
  | { status: "error"; message: string }
  | { status: "done"; file: File; text: string; pdfBase64: string | null };

function base64ToBlob(base64: string, type: string) {
  // Decode base64 into a Blob for download.
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type });
}

export default function Home() {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [upload, setUpload] = useState<UploadState>({ status: "idle" });
  const [previewName, setPreviewName] = useState<string | null>(null);
  const [lang, setLang] = useState("eng");

  const helperText = useMemo(() => {
    if (upload.status === "uploading") return "Cooking your searchable PDF...";
    if (upload.status === "done")
      return upload.pdfBase64
        ? "OCR complete. Download the searchable PDF or preview the text."
        : "OCR complete. Preview the extracted text below.";
    if (upload.status === "error") return upload.message;
    if (upload.status === "ready") return "Tap convert to kick off OCR.";
    return "Drop a scan or PDF. We handle OCR and return a searchable PDF.";
  }, [upload]);

  async function handleFileSelect(fileList: FileList | null) {
    const file = fileList?.[0];
    if (!file) return;
    const isImage = file.type.startsWith("image/");
    const isPdf = file.type === "application/pdf";
    if (!isImage && !isPdf) {
      setUpload({
        status: "error",
        message: "Only images or PDFs are supported (PNG, JPG, PDF).",
      });
      setPreviewName(null);
      return;
    }

    const tooLarge = file.size > 10 * 1024 * 1024;
    if (tooLarge) {
      setUpload({
        status: "error",
        message: "File is too large. Max size is 10MB.",
      });
      setPreviewName(null);
      return;
    }

    setUpload({ status: "ready", file });
    setPreviewName(file.name);
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (upload.status !== "ready" && upload.status !== "done") return;

    const activeFile =
      upload.status === "ready" || upload.status === "done"
        ? upload.file
        : null;
    if (!activeFile) return;

    const formData = new FormData();
    formData.append("file", activeFile);
    formData.append("lang", lang);

    setUpload({ status: "uploading", file: activeFile });

    try {
      // Calls the API route, which currently returns stubbed OCR output.
      const response = await fetch("/api/ocr", {
        method: "POST",
        body: formData,
      });

      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || "Upload failed");
      }

      const body = (await response.json()) as {
        text: string;
        pdfBase64: string | null;
      };
      setUpload({
        status: "done",
        file: activeFile,
        text: body.text,
        pdfBase64: body.pdfBase64,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Upload error";
      setUpload({ status: "error", message });
    }
  }

  function handleDownload(pdfBase64: string | null) {
    if (!pdfBase64) return;
    const blob = base64ToBlob(pdfBase64, "application/pdf");
    const href = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = href;
    link.download =
      upload.status === "done"
        ? `${upload.file.name}-searchable.pdf`
        : "searchable.pdf";
    link.click();
    URL.revokeObjectURL(href);
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-zinc-950 via-slate-900 to-zinc-950 text-zinc-50">
      <div className="mx-auto flex min-h-screen w-full max-w-6xl flex-col gap-12 px-6 py-14 sm:px-10 lg:py-20">
        <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div className="space-y-2">
            <p className="text-sm uppercase tracking-[0.2em] text-zinc-400">
              CookPDF
            </p>
            <h1 className="text-4xl font-semibold leading-tight sm:text-5xl">
              Turn scans into searchable PDFs in one drop
            </h1>
            <p className="max-w-2xl text-lg text-zinc-400">
              Upload a PDF or image. We run OCR on-device, bake a searchable
              PDF, and serve you the text.
            </p>
          </div>
          <div className="rounded-full bg-white/5 px-5 py-2 text-sm text-zinc-200 ring-1 ring-white/10">
            Deploy-ready Next.js + Tailwind
          </div>
        </header>

        <main className="grid gap-10 lg:grid-cols-[2fr,1fr]">
          <section className="relative overflow-hidden rounded-3xl border border-white/10 bg-white/5 p-8 shadow-2xl shadow-black/30 backdrop-blur">
            <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_20%_20%,rgba(255,255,255,0.08),transparent_35%),radial-gradient(circle_at_80%_0%,rgba(255,255,255,0.05),transparent_30%)]" />

            <form
              className="relative z-10 flex flex-col gap-6"
              onSubmit={handleSubmit}
            >
              <div className="flex flex-col gap-3">
                <p className="text-sm font-medium text-zinc-200">Upload</p>
                <label
                  htmlFor="file"
                  className="group flex min-h-[180px] cursor-pointer flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-white/20 bg-black/30 px-6 text-center transition hover:border-white/40 hover:bg-black/20"
                >
                  <input
                    id="file"
                    ref={inputRef}
                    type="file"
                    accept="application/pdf,image/*"
                    className="hidden"
                    onChange={(event) => handleFileSelect(event.target.files)}
                  />
                  <div className="flex h-12 w-12 items-center justify-center rounded-full bg-white/10 text-sm font-semibold text-white">
                    ⇪
                  </div>
                  <div className="space-y-1">
                    <p className="text-base font-medium text-white">
                      {previewName || "Drop an image or PDF (PNG, JPG, PDF)"}
                    </p>
                    <p className="text-sm text-zinc-400">
                      Max 10MB · PNG, JPG, PDF
                    </p>
                  </div>
                  <span className="text-xs uppercase tracking-[0.3em] text-zinc-500 transition group-hover:text-zinc-300">
                    Browse files
                  </span>
                </label>
              </div>

              <div className="flex flex-wrap items-center gap-3 text-sm text-zinc-400">
                <span className="rounded-full bg-white/10 px-3 py-1 text-xs font-semibold text-white">
                  Step 1
                </span>
                Upload a scan or PDF.
                <span className="rounded-full bg-white/10 px-3 py-1 text-xs font-semibold text-white">
                  Step 2
                </span>
                We run OCR on-device.
                <span className="rounded-full bg-white/10 px-3 py-1 text-xs font-semibold text-white">
                  Step 3
                </span>
                Download your searchable PDF.
              </div>

              <div className="flex flex-col gap-4 rounded-2xl bg-black/40 p-4 ring-1 ring-white/5">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm text-zinc-300">Status</p>
                  <span className="rounded-full bg-white/10 px-3 py-1 text-xs font-semibold text-white">
                    {upload.status === "uploading"
                      ? "Uploading"
                      : upload.status === "done"
                        ? "Done"
                        : upload.status === "error"
                          ? "Error"
                          : "Ready"}
                  </span>
                </div>
                <p className="text-sm text-zinc-300">{helperText}</p>
                {upload.status === "uploading" && (
                  <div className="h-2 w-full overflow-hidden rounded-full bg-white/10">
                    <div className="h-full w-1/3 animate-[pulse_1.2s_ease-in-out_infinite] rounded-full bg-emerald-400/80" />
                  </div>
                )}
                <div className="flex flex-wrap gap-3">
                  <button
                    type="button"
                    onClick={() => inputRef.current?.click()}
                    className="rounded-full bg-white text-sm font-semibold text-black transition hover:bg-zinc-200 disabled:cursor-not-allowed disabled:opacity-40"
                    disabled={upload.status === "uploading"}
                  >
                    <span className="px-5 py-2">Choose file</span>
                  </button>
                  <button
                    type="submit"
                    disabled={
                      upload.status === "uploading" || upload.status === "idle"
                    }
                    className="rounded-full bg-emerald-500 px-5 py-2 text-sm font-semibold text-emerald-950 shadow-lg shadow-emerald-500/25 transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {upload.status === "uploading"
                      ? "Converting..."
                      : "Convert to searchable PDF"}
                  </button>
                  {upload.status === "done" && (
                    <button
                      type="button"
                      onClick={() => handleDownload(upload.pdfBase64)}
                      disabled={!upload.pdfBase64}
                      className="rounded-full border border-white/20 px-5 py-2 text-sm font-semibold text-white transition hover:border-white/40 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {upload.pdfBase64
                        ? "Download searchable PDF"
                        : "Download pending"}
                    </button>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-3 text-sm text-zinc-300">
                  <span className="rounded-full bg-white/10 px-3 py-1 text-xs font-semibold text-white">
                    Language
                  </span>
                  <select
                    value={lang}
                    onChange={(event) => setLang(event.target.value)}
                    className="rounded-xl bg-white/10 px-3 py-2 text-sm text-white outline-none ring-1 ring-white/10"
                    disabled={upload.status === "uploading"}
                  >
                    <option value="eng" className="text-black">
                      English (eng)
                    </option>
                    <option value="amh" className="text-black">
                      Amharic (amh)
                    </option>
                    <option value="eng+amh" className="text-black">
                      Mixed (eng+amh)
                    </option>
                  </select>
                  <span className="text-xs text-zinc-400">
                    First run for a language downloads its model; expect a
                    slower request.
                  </span>
                </div>
              </div>

              {upload.status === "done" && (
                <div className="rounded-2xl bg-white/5 p-4 ring-1 ring-white/10">
                  <p className="text-sm font-medium text-white">
                    Extracted text preview
                  </p>
                  <p className="mt-2 text-sm leading-6 text-zinc-200 whitespace-pre-wrap">
                    {upload.text}
                  </p>
                </div>
              )}

              {upload.status === "error" && (
                <div className="rounded-2xl bg-red-500/10 p-4 text-sm text-red-200 ring-1 ring-red-500/40">
                  {upload.message}
                </div>
              )}
            </form>
          </section>

          <aside className="flex flex-col gap-4 rounded-3xl border border-white/10 bg-white/5 p-6 shadow-xl shadow-black/30 backdrop-blur">
            <p className="text-sm uppercase tracking-[0.2em] text-zinc-400">
              Flow
            </p>
            <div className="space-y-4 text-sm text-zinc-200">
              <div className="rounded-2xl bg-black/40 p-4 ring-1 ring-white/5">
                <p className="text-white">1) Upload</p>
                <p className="text-zinc-400">
                  Client posts FormData to /api/ocr.
                </p>
              </div>
              <div className="rounded-2xl bg-black/40 p-4 ring-1 ring-white/5">
                <p className="text-white">2) Process</p>
                <p className="text-zinc-400">
                  API invokes the OCR helper. Swap in your provider.
                </p>
              </div>
              <div className="rounded-2xl bg-black/40 p-4 ring-1 ring-white/5">
                <p className="text-white">3) Deliver</p>
                <p className="text-zinc-400">
                  Return extracted text and a searchable PDF download.
                </p>
              </div>
            </div>
            <div className="rounded-2xl bg-emerald-500/10 p-4 text-sm text-emerald-100 ring-1 ring-emerald-500/30">
              Swap the stub in src/lib/ocr.ts with your OCR engine (Tesseract,
              Azure AI Vision, or Cloud Vision). Return a base64 PDF for instant
              download.
            </div>
          </aside>
        </main>
      </div>
    </div>
  );
}
