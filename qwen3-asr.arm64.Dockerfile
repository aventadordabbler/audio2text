ARG CUDA_VERSION=12.8.0

FROM nvidia/cuda:${CUDA_VERSION}-devel-ubuntu22.04

ARG TARGETARCH
ARG CMAKE_VERSION=3.26.1

ENV DEBIAN_FRONTEND=noninteractive
ENV MAX_JOBS=8
ENV NVCC_THREADS=2
ENV CCACHE_DIR=/root/.cache/ccache
ENV PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple

RUN set -eux; \
    find /etc/apt -type f \( -name '*.list' -o -name '*.sources' \) -exec \
      sed -i -E \
        -e 's#https?://(archive|security)\.ubuntu\.com/ubuntu/?#https://mirrors.tuna.tsinghua.edu.cn/ubuntu#g' \
        -e 's#https?://ports\.ubuntu\.com/ubuntu-ports/?#https://mirrors.tuna.tsinghua.edu.cn/ubuntu-ports#g' \
      {} +

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        git git-lfs python3 python3-pip python3-dev \
        wget vim libsndfile1 ccache ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY ./cmake-3.26.1-linux-aarch64.sh /tmp/cmake-install.sh

RUN chmod +x /tmp/cmake-install.sh; \
    mkdir -p /opt/cmake; \
    /tmp/cmake-install.sh --skip-license --prefix=/opt/cmake; \
    ln -s /opt/cmake/bin/* /usr/local/bin/; \
    rm /tmp/cmake-install.sh

RUN ln -s /usr/bin/python3 /usr/bin/python
RUN git lfs install

WORKDIR /data/shared/Qwen3-ASR

RUN --mount=type=cache,target=/root/.cache/pip \
    python3 -m pip install \
      --index-url https://pypi.tuna.tsinghua.edu.cn/simple \
      -U pip setuptools wheel

# qwen-asr[vllm] requires torch==2.9.1. The generic ARM64 PyPI wheel is
# CPU-only, so install the ARM64 CUDA 12.8 wheel before installing qwen-asr.
RUN --mount=type=cache,target=/root/.cache/pip \
    python3 -m pip install \
      --index-url https://pypi.tuna.tsinghua.edu.cn/simple \
      --extra-index-url https://mirror.sjtu.edu.cn/pytorch-wheels/cu128/ \
      "torch==2.9.1+cu128" \
      "torchaudio==2.9.1"

RUN --mount=type=cache,target=/root/.cache/pip \
    set -eu; \
    printf '%s\n' 'torch==2.9.1+cu128' 'torchaudio==2.9.1' > /tmp/pytorch-constraints.txt; \
    python3 -m pip install \
      --index-url https://pypi.tuna.tsinghua.edu.cn/simple \
      --extra-index-url https://mirror.sjtu.edu.cn/pytorch-wheels/cu128/ \
      --constraint /tmp/pytorch-constraints.txt \
      "qwen-asr[vllm]==0.0.6"; \
    rm /tmp/pytorch-constraints.txt

# Triton 3.5.1 bundles CUDA 12.8 ptxas, which cannot compile GB10 (sm_121a).
# Use a newer assembler while retaining the CUDA 12.8 PyTorch/vLLM runtime.
RUN --mount=type=cache,target=/root/.cache/pip \
    python3 -m pip install \
      --index-url https://pypi.tuna.tsinghua.edu.cn/simple \
      "nvidia-cuda-nvcc-cu12==12.9.86"

ENV TRITON_PTXAS_PATH=/usr/local/lib/python3.10/dist-packages/nvidia/cuda_nvcc/bin/ptxas

# Build workers need no GPU, but the installed PyTorch must include CUDA.
RUN python3 -c "import pathlib, torch; \
        assert torch.__version__ == '2.9.1+cu128', torch.__version__; \
        assert torch.version.cuda == '12.8', torch.version.cuda; \
        assert (pathlib.Path(torch.__file__).parent / 'lib/libtorch_cuda.so').is_file(), 'libtorch_cuda.so is missing'; \
        print('Verified PyTorch', torch.__version__, 'CUDA', torch.version.cuda)" \
    && printf '.version 8.8\n.target sm_121a\n.address_size 64\n.visible .entry check_sm121() { ret; }\n' > /tmp/check-sm121.ptx \
    && "$TRITON_PTXAS_PATH" -arch=sm_121a /tmp/check-sm121.ptx -o /tmp/check-sm121.cubin \
    && rm /tmp/check-sm121.ptx /tmp/check-sm121.cubin

EXPOSE 80

CMD ["bash"]
