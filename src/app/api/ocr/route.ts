import { NextResponse } from "next/server";
import { convertToSearchablePdf } from "@/lib/ocr";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const file = formData.get("file");
    const langInput = formData.get("lang");

    if (!(file instanceof File)) {
      return NextResponse.json({ error: "No file uploaded." }, { status: 400 });
    }

    const tooLarge = file.size > 10 * 1024 * 1024;
    const isImage = file.type.startsWith("image/");
    const isPdf = file.type === "application/pdf";

    if (!isImage && !isPdf) {
      return NextResponse.json(
        { error: "Only images or PDFs are supported for on-device OCR." },
        { status: 415 },
      );
    }

    if (tooLarge) {
      return NextResponse.json(
        { error: "File is too large. Max size is 10MB." },
        { status: 413 },
      );
    }

    const lang =
      typeof langInput === "string" && langInput.trim()
        ? langInput.trim()
        : "eng";

    const bytes = new Uint8Array(await file.arrayBuffer());
    const { text, pdfBase64 } = await convertToSearchablePdf({
      bytes,
      filename: file.name,
      mimeType: file.type,
      lang,
    });

    return NextResponse.json({
      filename: file.name,
      text,
      pdfBase64,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
