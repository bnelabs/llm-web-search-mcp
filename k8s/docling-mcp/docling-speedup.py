#!/usr/local/bin/python
"""Wrapper entrypoint for docling-mcp-server with CPU speedups + PyMuPDF fast path.

Two things happen before the upstream server is imported and started:

1. Docling's _get_converter is monkey-patched to use CPU-friendly defaults:
     - do_ocr=False (born-digital PDFs; flip via DOCLING_DO_OCR=1)
     - do_table_structure controlled by DOCLING_DO_TABLES (default on)
     - AcceleratorOptions.num_threads = DOCLING_NUM_THREADS (default 12)
     - layout_options.model_spec = DOCLING_LAYOUT_EGRET_MEDIUM
       (smaller/faster than default heron; flip via DOCLING_FAST_LAYOUT=0)
     - Image inputs use ImageFormatOption (the modern, non-deprecated path).

2. A new MCP tool, `convert_url_fast`, is registered on the same FastMCP
   instance. It uses PyMuPDF4LLM (+ pymupdf-layout) to convert a URL or path
   to markdown in ~10-30x less time than docling on born-digital PDFs.
   The tool reports avg chars/page so callers can detect scanned docs and
   cascade to the full docling tool when needed.
"""
import os
import sys
import tempfile
import urllib.parse
from dataclasses import dataclass
from functools import lru_cache


def _truthy(val: str) -> bool:
    return val.strip().lower() in ("1", "true", "yes", "on")


NUM_THREADS = int(os.environ.get("DOCLING_NUM_THREADS", "12"))
DO_OCR = _truthy(os.environ.get("DOCLING_DO_OCR", "false"))
DO_TABLES = _truthy(os.environ.get("DOCLING_DO_TABLES", "true"))
USE_FAST_LAYOUT = _truthy(os.environ.get("DOCLING_FAST_LAYOUT", "true"))


def _install_docling_patch() -> None:
    from docling.datamodel.base_models import InputFormat
    from docling.datamodel.layout_model_specs import DOCLING_LAYOUT_EGRET_MEDIUM
    from docling.datamodel.pipeline_options import (
        AcceleratorDevice,
        AcceleratorOptions,
        PdfPipelineOptions,
    )
    from docling.document_converter import (
        DocumentConverter,
        FormatOption,
        ImageFormatOption,
        PdfFormatOption,
    )

    from docling_mcp.tools import conversion as _conv

    @lru_cache
    def _fast_get_converter() -> DocumentConverter:
        po = PdfPipelineOptions()
        po.do_ocr = DO_OCR
        po.do_table_structure = DO_TABLES
        po.accelerator_options = AcceleratorOptions(
            device=AcceleratorDevice.CPU,
            num_threads=NUM_THREADS,
        )
        if USE_FAST_LAYOUT:
            po.layout_options.model_spec = DOCLING_LAYOUT_EGRET_MEDIUM
        po.generate_page_images = _conv.settings.keep_images

        format_options: dict[InputFormat, FormatOption] = {
            InputFormat.PDF: PdfFormatOption(pipeline_options=po),
            InputFormat.IMAGE: ImageFormatOption(pipeline_options=po),
        }
        _conv.logger.info(
            "[speedup] ocr=%s tables=%s threads=%s layout=%s",
            DO_OCR,
            DO_TABLES,
            NUM_THREADS,
            "egret_medium" if USE_FAST_LAYOUT else "heron",
        )
        return DocumentConverter(format_options=format_options)

    _conv._get_converter = _fast_get_converter


def _register_fast_tool() -> None:
    """Register `convert_url_fast` MCP tool using PyMuPDF4LLM."""
    import pymupdf4llm
    from pydantic import Field
    from typing import Annotated
    from mcp.types import ToolAnnotations

    from docling_mcp.tools import conversion as _conv

    mcp = _conv.mcp  # same FastMCP instance docling-mcp registers its tools on
    logger = _conv.logger

    @dataclass
    class FastConvertOutput:
        source: str
        markdown: str
        pages: int
        chars: int
        avg_chars_per_page: int
        looks_scanned: bool
        tool: str = "pymupdf4llm"

    def _download(source: str, timeout: int = 20) -> str:
        """Return a local file path. Downloads if source is an http(s) URL."""
        parsed = urllib.parse.urlparse(source)
        if parsed.scheme not in ("http", "https"):
            return source
        import httpx

        headers = {
            "User-Agent": (
                "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
            ),
            "Accept": "application/pdf,application/octet-stream,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.5",
        }
        suffix = os.path.splitext(parsed.path)[1] or ".pdf"
        fd, path = tempfile.mkstemp(suffix=suffix)
        try:
            with httpx.stream(
                "GET", source, headers=headers, timeout=timeout, follow_redirects=True
            ) as resp:
                resp.raise_for_status()
                with os.fdopen(fd, "wb") as f:
                    for chunk in resp.iter_bytes(1 << 20):
                        f.write(chunk)
            return path
        except Exception:
            try:
                os.close(fd)
            except OSError:
                pass
            try:
                os.unlink(path)
            except OSError:
                pass
            raise

    @mcp.tool(
        title="Fast URL-to-Markdown (PyMuPDF)",
        annotations=ToolAnnotations(readOnlyHint=True, destructiveHint=False),
    )
    def convert_url_fast(
        source: Annotated[
            str, Field(description="HTTP(S) URL or local file path to a PDF.")
        ],
    ) -> FastConvertOutput:
        """Convert a PDF to Markdown via PyMuPDF4LLM (fast path).

        Uses pymupdf + pymupdf-layout for layout analysis and table extraction.
        Designed as the default path for born-digital PDFs; callers should
        inspect `looks_scanned` / `avg_chars_per_page` and fall back to
        `convert_document_into_docling_document` when the doc needs OCR or
        heavy layout/table accuracy.
        """
        source = source.strip("\"'")
        logger.info(f"[fast] converting {source}")

        downloaded_path = None
        try:
            local_path = _download(source)
            downloaded_path = local_path if local_path != source else None

            md = pymupdf4llm.to_markdown(
                local_path,
                show_progress=False,
            )

            # Page count via pymupdf
            import pymupdf
            with pymupdf.open(local_path) as doc:
                pages = doc.page_count

            chars = len(md)
            avg = chars // max(pages, 1)
            # Heuristic: pages with almost no text = scanned. Threshold ~80
            # chars/page catches most scanned docs while leaving near-empty
            # legitimate PDFs (cover pages, forms) alone.
            looks_scanned = avg < 80

            logger.info(
                f"[fast] done {source}: pages={pages} chars={chars} "
                f"avg={avg}/pg scanned={looks_scanned}"
            )
            return FastConvertOutput(
                source=source,
                markdown=md,
                pages=pages,
                chars=chars,
                avg_chars_per_page=avg,
                looks_scanned=looks_scanned,
            )
        finally:
            if downloaded_path:
                try:
                    os.unlink(downloaded_path)
                except OSError:
                    pass

    logger.info("[speedup] registered MCP tool: convert_url_fast")


_install_docling_patch()
_register_fast_tool()

from docling_mcp.servers.mcp_server import app  # noqa: E402

if __name__ == "__main__":
    sys.exit(app())
