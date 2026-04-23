FROM python:3.12-slim

# Install curl for uv and runtime libs Docling's image/PDF stack needs
# (pypdfium2 -> libxcb1, pillow/opencv-headless -> libgl1+libglib2.0-0).
RUN apt-get update && apt-get install -y --no-install-recommends \
        curl \
        libxcb1 \
        libglib2.0-0 \
        libgl1 \
        libgomp1 \
    && rm -rf /var/lib/apt/lists/*

# Install uv for package management
RUN curl -LsSf https://astral.sh/uv/install.sh | sh \
    && echo 'export PATH="/root/.local/bin:$PATH"' >> /root/.bashrc

ENV PATH="/root/.local/bin:$PATH"

# Install CPU-only torch first, then docling-mcp (reuses CPU torch)
RUN uv pip install --system torch torchvision -i https://download.pytorch.org/whl/cpu

# Install docling-mcp (reuses existing CPU torch)
RUN uv pip install --system docling-mcp

# Install PyMuPDF4LLM + layout addon for the fast path (born-digital PDFs, tables).
# Pulls pymupdf, pymupdf-layout, tabulate as deps.
RUN uv pip install --system pymupdf4llm

# Patch torch to skip CUDA global deps loading on CPU
RUN python3 -c "p='/usr/local/lib/python3.12/site-packages/torch/__init__.py'; f=open(p); c=f.read(); f.close(); c=c.replace('def _load_global_deps():','def _load_global_deps():\n    return  # patched for CPU'); f=open(p,'w'); f.write(c); f.close()"

# Install the speedup wrapper entrypoint
COPY k8s/docling-mcp/docling-speedup.py /usr/local/bin/docling-mcp-fast
RUN chmod +x /usr/local/bin/docling-mcp-fast

# Expose streamable-http port
EXPOSE 8000

# Run the wrapped server (monkey-patches converter options before start)
CMD ["docling-mcp-fast", "--transport", "streamable-http", "--host", "0.0.0.0", "--port", "8000"]
