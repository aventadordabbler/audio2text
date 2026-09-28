FROM astral/uv:0.11.26 AS uv

FROM node:24-slim AS frontend
WORKDIR /frontend
ENV NPM_CONFIG_REGISTRY=https://registry.npmmirror.com
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web ./
RUN npm run build

FROM python:3.12-slim
WORKDIR /app
RUN set -eux; \
    for sources in /etc/apt/sources.list /etc/apt/sources.list.d/debian.sources; do \
        if [ -f "$sources" ]; then \
            sed -i \
                -e 's|http://deb.debian.org|https://mirrors.tuna.tsinghua.edu.cn|g' \
                -e 's|https://deb.debian.org|https://mirrors.tuna.tsinghua.edu.cn|g' \
                -e 's|http://security.debian.org|https://mirrors.tuna.tsinghua.edu.cn|g' \
                -e 's|https://security.debian.org|https://mirrors.tuna.tsinghua.edu.cn|g' \
                "$sources"; \
        fi; \
    done; \
    apt-get update; \
    apt-get install -y --no-install-recommends libgomp1 libsndfile1 ffmpeg; \
    rm -rf /var/lib/apt/lists/*
COPY --from=uv /uv /uvx /bin/
COPY pyproject.toml README.md uv.lock ./
COPY app ./app
RUN uv sync --frozen --no-dev
COPY --from=frontend /frontend/dist ./web/dist
COPY main.py ./main.py
ENV PATH="/app/.venv/bin:$PATH" PYTHONUNBUFFERED=1
EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
