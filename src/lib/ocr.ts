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

const RENDER_SCALE = (() => {
  const raw = process.env.OCR_RENDER_SCALE;
  const n = raw ? Number(raw) : NaN;
  if (!Number.isFinite(n) || n <= 0) return 2;
  // Limit to a reasonable range to avoid excessive memory/CPU usage.
  return Math.min(Math.max(n, 1.5), 3);
})();

// For Amharic and other complex scripts, use lower scale for speed
const AMHARIC_RENDER_SCALE = 1.5;

const BINARIZE_ENABLED = (() => {
  const raw = process.env.OCR_BINARIZE;
  if (!raw) return false;
  const val = raw.toLowerCase();
  return val === "1" || val === "true" || val === "yes";
})();

// Enable binarization by default for Amharic for better OCR quality
const AMHARIC_BINARIZE_ENABLED = true;

const BINARIZE_THRESHOLD = (() => {
  const raw = process.env.OCR_BINARIZE_THRESHOLD;
  const n = raw ? Number(raw) : NaN;
  if (!Number.isFinite(n)) return 180;
  return Math.min(Math.max(n, 0), 255);
})();

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
  lang?: string,
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
    
    // Limit pages for initial testing to avoid extremely long processing
    const defaultMaxPages = 10;
    const pageCount = maxPages
      ? Math.min(pdf.numPages, maxPages)
      : Math.min(pdf.numPages, defaultMaxPages);
    
    // Use lower scale for Amharic to speed up processing
    const isAmharic = lang?.includes("amh");
    const scale = isAmharic ? AMHARIC_RENDER_SCALE : RENDER_SCALE;

    for (let i = 1; i <= pageCount; i++) {
      const page = await pdf.getPage(i);
      // Render at configurable DPI for accuracy vs speed trade-off.
      const viewport = page.getViewport({ scale });
      const { canvas, context } = canvasFactory.create(
        viewport.width,
        viewport.height,
      );

      await page.render({ canvasContext: context, viewport, canvasFactory })
        .promise;

      // Apply binarization for better OCR, especially for Amharic
      const shouldBinarize = isAmharic ? AMHARIC_BINARIZE_ENABLED : BINARIZE_ENABLED;
      if (shouldBinarize) {
        const imgData = context.getImageData(0, 0, canvas.width, canvas.height);
        const data = imgData.data;
        for (let idx = 0; idx < data.length; idx += 4) {
          const r = data[idx];
          const g = data[idx + 1];
          const b = data[idx + 2];
          const gray = 0.299 * r + 0.587 * g + 0.114 * b;
          const v = gray >= BINARIZE_THRESHOLD ? 255 : 0;
          data[idx] = data[idx + 1] = data[idx + 2] = v;
        }
        context.putImageData(imgData, 0, 0);
      }

      pages.push(new Uint8Array(canvas.toBuffer("image/png")));
      canvasFactory.destroy({ canvas, context });
    }

    return pages;
  } catch (error) {
    console.error(
      "PDF rasterization failed; returning empty array",
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
      
      // Optimize settings based on language
      const isAmharic = lang.includes("amh");
      await worker.setParameters({
        // Page segmentation mode: 3=auto without OSD, 1=auto with OSD (orientation/script detection)
        tessedit_pageseg_mode: isAmharic ? "3" : "6",
        // Preserve spaces for Amharic syllables
        preserve_interword_spaces: "1",
        // Improve character segmentation
        textord_heavy_nr: "1",
        // Better handling of joined/overlapping characters
        textord_force_make_prop_words: isAmharic ? "1" : "0",
        // Character whitelisting disabled to allow all Ethiopic Unicode
        tessedit_char_whitelist: "",
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
    // Try TTF first as pdf-lib handles it better than OTF
    const ttfPath = path.join(
      process.cwd(),
      "public",
      "fonts",
      "NotoSansEthiopic-Regular.ttf",
    );
    const otfPath = path.join(
      process.cwd(),
      "public",
      "fonts",
      "NotoSansEthiopic-Regular.otf",
    );
    
    if (fs.existsSync(ttfPath)) {
      console.log("Loading TTF font for Amharic");
      const buf = fs.readFileSync(ttfPath);
      fontCache["noto-ethiopic"] = new Uint8Array(buf);
    } else if (fs.existsSync(otfPath)) {
      console.log("Loading OTF font for Amharic");
      const buf = fs.readFileSync(otfPath);
      fontCache["noto-ethiopic"] = new Uint8Array(buf);
    } else {
      console.log("Downloading TTF font for Amharic");
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

// Preload font at module initialization to reduce first-run latency
loadFontData().catch((err) =>
  console.warn("Font preload failed, will load on-demand:", err),
);

async function buildSearchablePdf(
  pageTexts: string[],
  lang: string,
): Promise<string> {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);

  const width = 595.28; // A4 width in points
  const height = 841.89; // A4 height in points

  const fontData = await loadFontData();
  // CRITICAL: Disable subsetting for Amharic to ensure all characters are embedded
  const isAmharic = lang.includes("amh");
  const font = await pdf.embedFont(fontData, { subset: !isAmharic });

  console.log(`Building PDF with ${pageTexts.length} pages for language: ${lang}`);

  for (const rawText of pageTexts.length ? pageTexts : ["(empty)"]) {
    // Clean control characters but preserve Ethiopic/Amharic Unicode range (U+1200-U+137F)
    let cleaned = rawText
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
      // Don't replace replacement character for Amharic as it might be valid
      .replace(/\uFFFD/g, isAmharic ? "" : " ");

    // For Amharic, filter out characters that the font might not support
    if (isAmharic) {
      // Log sample of text for debugging
      const sample = cleaned.substring(0, 100);
      console.log(`Sample text (first 100 chars): ${sample}`);
      console.log(`Text length: ${cleaned.length} characters`);
      
      // Remove zero-width characters and other problematic Unicode that might cause boxes
      cleaned = cleaned
        .replace(/[\u200B-\u200D\uFEFF]/g, "") // Zero-width spaces
        .replace(/[\u202A-\u202E]/g, ""); // Bidirectional text controls
    }

    const page = pdf.addPage([width, height]);

    const paragraphs = cleaned
      .split(/\n{2,}/)
      .map((p) => p.trim().replace(/\s+/g, " "))
      .filter(Boolean);
    const normalizedText = paragraphs.join("\n\n");

    const margin = 72; // 1 inch
    const fontSize = isAmharic ? 16 : 14; // Larger font for Amharic for better readability
    const lineHeight = isAmharic ? 22 : 18;
    
    try {
      page.drawText(normalizedText || cleaned || "(empty)", {
        x: margin,
        y: height - margin,
        size: fontSize,
        font,
        color: rgb(0, 0, 0),
        lineHeight,
        maxWidth: width - margin * 2,
      });
    } catch (error) {
      console.error("Error drawing text on PDF page:", error);
      // Fallback: try to draw a simplified version
      const fallbackText = "[Error rendering text - possible unsupported characters]";
      page.drawText(fallbackText, {
        x: margin,
        y: height - margin,
        size: 12,
        font,
        color: rgb(1, 0, 0),
      });
    }
  }

  const base64 = await pdf.saveAsBase64();
  return base64;
}

// Batch size for parallel OCR processing
const OCR_BATCH_SIZE = (() => {
  const raw = process.env.OCR_BATCH_SIZE;
  const n = raw ? Number(raw) : NaN;
  if (!Number.isFinite(n) || n <= 0) return 3;
  return Math.min(Math.max(n, 1), 5);
})();

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
    const pageImages = await rasterizePdfPages(params.bytes, undefined, lang);
    if (pageImages.length === 0) {
      const text = await ocrImage(params.bytes, lang);
      const pdfBase64 = await buildSearchablePdf([text], lang);
      return { text, pdfBase64 };
    }

    console.log(`Processing ${pageImages.length} pages with ${lang} OCR...`);
    
    // Process pages in parallel batches for better performance
    const texts: string[] = [];
    for (let i = 0; i < pageImages.length; i += OCR_BATCH_SIZE) {
      const batch = pageImages.slice(i, i + OCR_BATCH_SIZE);
      console.log(`Processing pages ${i + 1}-${Math.min(i + OCR_BATCH_SIZE, pageImages.length)} of ${pageImages.length}`);
      const batchTexts = await Promise.all(
        batch.map((pageImage) => ocrImage(pageImage, lang).catch(err => {
          console.error("OCR failed for page:", err);
          return "[OCR failed for this page]";
        })),
      );
      texts.push(...batchTexts);
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
