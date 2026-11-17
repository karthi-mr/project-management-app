# Demo video

A narrated product demo (about 80 seconds, 1080p, voice-over and background music), made entirely
on a Mac with no extra software: the app runs on a throwaway database with a fictional company
(Northwind Retail), Playwright drives it, macOS `say` reads the script, the music is synthesised in
Python, and AVFoundation encodes the MP4.

```bash
# 1. Voice lines (edit the words in demo/script.json first if you like)
python3 demo/voice.py
# 2. Record the walkthrough (needs the frontend built: cd frontend && npx vite build)
node demo/record.mjs
# 3. Music and voice mixed into one sound track
python3 demo/audio.py
# 4. The video
swift demo/assemble.swift demo/build demo/output/trackly-demo.mp4
```

The result is `demo/output/trackly-demo.mp4`. Each scene lasts as long as its voice line, so
changing the narration re-times the video automatically. Never uses your real data.
