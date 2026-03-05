FROM python:3.11-slim

# Install ffmpeg (Linux build includes glob support)
RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy the server entry point
COPY main.py .

# Work directory for job outputs (mounted as volume)
RUN mkdir -p /data
ENV ZYRA_DATA_DIR=/data

EXPOSE 8765

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8765"]
