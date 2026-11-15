FROM pytorch/pytorch:2.9.1-cuda12.8-cudnn9-runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/ComfyUI
RUN git init /opt/ComfyUI && \
    git -C /opt/ComfyUI remote add origin https://github.com/comfyanonymous/ComfyUI.git && \
    git -C /opt/ComfyUI fetch --depth 1 origin b0b743566f65daafc423b4fea8a2fbda94b3384a && \
    git -C /opt/ComfyUI checkout --detach FETCH_HEAD
RUN pip install --no-cache-dir -r requirements.txt

EXPOSE 8188
CMD ["python", "main.py", "--listen", "0.0.0.0", "--port", "8188", "--disable-auto-launch"]
