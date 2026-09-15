#!/usr/bin/env python3
"""Standalone Whisper transcription server for Huddle.
Usage: python whisper_server.py
Then set WHISPER_BASE_URL=http://192.168.4.38:8765/v1 in Coolify.
"""
import os, tempfile
from fastapi import FastAPI, File, Form, UploadFile
from fastapi.responses import JSONResponse
import uvicorn

MODEL = os.environ.get("WHISPER_MODEL", "mlx-community/whisper-large-v3-turbo")
app = FastAPI()

@app.get("/health")
def health():
    return {"ok": True}

@app.post("/v1/audio/transcriptions")
async def transcribe(
    file: UploadFile = File(...),
    model: str = Form(default=MODEL),
    response_format: str = Form(default="json"),
):
    import mlx_whisper
    data = await file.read()
    ext = os.path.splitext(file.filename or "audio.webm")[1] or ".webm"
    with tempfile.NamedTemporaryFile(suffix=ext, delete=False) as f:
        f.write(data); tmp = f.name
    try:
        result = mlx_whisper.transcribe(tmp, path_or_hf_repo=MODEL)
        return JSONResponse({"text": result.get("text", "").strip()})
    finally:
        try: os.unlink(tmp)
        except: pass

if __name__ == "__main__":
    print(f"Whisper server starting on http://0.0.0.0:8765  (model: {MODEL})")
    uvicorn.run(app, host="0.0.0.0", port=8765)
