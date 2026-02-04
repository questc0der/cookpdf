import { PDFDocument, rgb, StandardFonts } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import fs from "fs";
import path from "path";
import { createRequire } from "module";
// We require via createRequire to get CJS exports reliably under Next.js
import type { Worker } from "tesseract.js";

export type OcrResult = {
  text: string;
  pdfBase64: string | null;
};

const WORKER_OPTS = {
  workerPath: undefined as unknown as string,
  corePath: undefined as unknown as string,
};

const nodeRequire = createRequire(process.cwd() + "/dummy.js");
let pdfjsLibPromise: Promise<any> | null = null;

async function getPdfJs() {
  if (!pdfjsLibPromise) {
    pdfjsLibPromise = import("pdfjs-dist/legacy/build/pdf.mjs").then((mod) => {
      mod.GlobalWorkerOptions.workerSrc =
        "pdfjs-dist/legacy/build/pdf.worker.min.mjs";
      mod.GlobalWorkerOptions.workerPort = null;
      return mod;
    });
  }
  return pdfjsLibPromise;
}

class NodeCanvasFactory {
  create(width: number, height: number) {
    const canvasMod = nodeRequire("@napi-rs/canvas");
    const createCanvasFn = (canvasMod.createCanvas ||
      canvasMod.default?.createCanvas) as
      | ((w: number, h: number) => any)
      | undefined;
    if (!createCanvasFn) {
      throw new Error("createCanvas not available from @napi-rs/canvas");
    }
    const canvas = createCanvasFn(width, height);
    const context = canvas.getContext("2d");
    return { canvas, context } as const;
  }
  reset(target: { canvas: any; context: any }, width: number, height: number) {
    target.canvas.width = width;
    target.canvas.height = height;
  }
  destroy(target: { canvas: any; context: any }) {
    target.canvas.width = 0;
    target.canvas.height = 0;
  }
}

const workerCache: Record<string, Promise<Worker>> = {};
const fontCache: Record<string, Uint8Array> = {};

async function rasterizePdfPages(
  pdfBytes: Uint8Array,
  maxPages?: number,
): Promise<Uint8Array[]> {
  try {
    const pdfjsLib = await getPdfJs();
    const canvasFactory = new NodeCanvasFactory();
    const loadingTask = pdfjsLib.getDocument({
      data: pdfBytes,
      disableWorker: true,
      isEvalSupported: false,
      canvasFactory,
    });
    const pdf = await loadingTask.promise;
    const pages: Uint8Array[] = [];
    const pageCount = maxPages
      ? Math.min(pdf.numPages, maxPages)
      : pdf.numPages;

    for (let i = 1; i <= pageCount; i++) {
      const page = await pdf.getPage(i);
      const viewport = page.getViewport({ scale: 2 });
      const { canvas, context } = canvasFactory.create(
        viewport.width,
        viewport.height,
      );

      await page.render({ canvasContext: context, viewport, canvasFactory })
        .promise;

      pages.push(new Uint8Array(canvas.toBuffer("image/png")));
      canvasFactory.destroy({ canvas, context });
    }

    return pages;
  } catch (error) {
    console.error(
      "PDF rasterization failed; falling back to original bytes",
      error,
    );
    return [];
  }
}

async function getWorker(lang: string) {
  if (!workerCache[lang]) {
    workerCache[lang] = (async () => {
      const req = createRequire(process.cwd() + "/dummy.js");
      const { createWorker } = req("tesseract.js");
      const workerPath = req.resolve(
        "tesseract.js/src/worker-script/node/index.js",
      );
      const corePath = req.resolve("tesseract.js-core/tesseract-core.wasm.js");

      const worker = await createWorker(lang, undefined, {
        ...WORKER_OPTS,
        workerPath,
        corePath,
      });
      return worker;
    })();
  }
  return workerCache[lang];
}

async function ocrImage(bytes: Uint8Array, lang: string): Promise<string> {
  const worker = await getWorker(lang);
  const { data } = await worker.recognize(bytes, { lang });
  return data.text?.trim() ?? "";
}

async function loadFontData(): Promise<Uint8Array> {
  if (!fontCache["noto-ethiopic"]) {
    const localPath = path.join(
      process.cwd(),
      "public",
      "fonts",
      "NotoSansEthiopic-Regular.otf",
    );
    if (fs.existsSync(localPath)) {
      const buf = fs.readFileSync(localPath);
      fontCache["noto-ethiopic"] = new Uint8Array(buf);
    } else {
      const url =
        "https://github.com/googlefonts/noto-fonts/raw/main/hinted/ttf/NotoSansEthiopic/NotoSansEthiopic-Regular.ttf?raw=1";
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`Font download failed: ${res.status}`);
      }
      const buf = new Uint8Array(await res.arrayBuffer());
      fontCache["noto-ethiopic"] = buf;
    }
  }

  return fontCache["noto-ethiopic"];
}

async function buildSearchablePdf(
  pageTexts: string[],
  lang: string,
): Promise<string> {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);

  const width = 595.28; // A4 width in points
  const height = 841.89; // A4 height in points

  const fontData = await loadFontData();
  const font = await pdf.embedFont(fontData, { subset: true });

  for (const rawText of pageTexts.length ? pageTexts : ["(empty)"]) {
    const cleaned = rawText
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
      .replace(/\uFFFD/g, " ");

    const page = pdf.addPage([width, height]);

    const paragraphs = cleaned
      .split(/\n{2,}/)
      .map((p) => p.trim().replace(/\s+/g, " "))
      .filter(Boolean);
    const normalizedText = paragraphs.join("\n\n");

    const margin = 72; // 1 inch
    page.drawText(normalizedText || cleaned || "(empty)", {
      x: margin,
      y: height - margin,
      size: 14,
      font,
      color: rgb(0, 0, 0),
      lineHeight: 18,
      maxWidth: width - margin * 2,
    });
  }

  const base64 = await pdf.saveAsBase64();
  return base64;
}

export async function convertToSearchablePdf(params: {
  bytes: Uint8Array;
  filename: string;
  mimeType?: string;
  lang?: string;
}): Promise<OcrResult> {
  const lang = params.lang && params.lang.trim() ? params.lang.trim() : "eng";
  const isPdf =
    params.mimeType === "application/pdf" ||
    params.filename.toLowerCase().endsWith(".pdf");

  if (isPdf) {
    const pageImages = await rasterizePdfPages(params.bytes);
    if (pageImages.length === 0) {
      const text = await ocrImage(params.bytes, lang);
      const pdfBase64 = await buildSearchablePdf([text], lang);
      return { text, pdfBase64 };
    }

    const texts: string[] = [];
    for (let i = 0; i < pageImages.length; i++) {
      const pageText = await ocrImage(pageImages[i], lang);
      texts.push(pageText || "");
    }

    const pdfBase64 = await buildSearchablePdf(texts, lang);
    const combinedText = texts
      .map((t, idx) => `Page ${idx + 1}\n${t}`.trim())
      .join("\n\n");
    return { text: combinedText, pdfBase64 };
  }

  const text = await ocrImage(params.bytes, lang);
  const pdfBase64 = await buildSearchablePdf([text], lang);

  return { text, pdfBase64 };
}
