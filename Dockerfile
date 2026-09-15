FROM ghcr.io/astral-sh/uv:0.11.11 AS uv

FROM node:24-slim AS frontend
WORKDIR /frontend
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web ./
RUN npm run build

FROM python:3.12-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
COPY --from=uv /uv /uvx /bin/
COPY pyproject.toml README.md uv.lock ./
COPY app ./app
RUN uv sync --frozen --no-dev
COPY --from=frontend /frontend/dist ./web/dist
COPY main.py ./main.py
ENV PATH="/app/.venv/bin:$PATH" PYTHONUNBUFFERED=1
EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
