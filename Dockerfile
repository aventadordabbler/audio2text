FROM ghcr.io/astral-sh/uv:0.11.11 AS uv
FROM python:3.12-slim
WORKDIR /app
COPY --from=uv /uv /uvx /bin/
COPY pyproject.toml README.md uv.lock ./
COPY app ./app
RUN pip install --no-cache-dir uv && uv sync --frozen --no-dev
COPY web ./web
COPY main.py ./main.py
ENV PATH="/app/.venv/bin:$PATH" PYTHONUNBUFFERED=1
EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
