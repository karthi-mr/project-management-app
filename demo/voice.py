"""Reads every line of demo/script.json aloud with macOS `say` and notes how long each one is."""
import json
import os
import subprocess

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "build", "voice")
os.makedirs(OUT, exist_ok=True)
script = json.load(open(os.path.join(HERE, "script.json")))
lengths = {}
for scene in script["scenes"]:
    path = os.path.join(OUT, f"{scene['id']}.aiff")
    subprocess.run(["say", "-v", script["voice"], "-r", str(script["rate"]), "-o", path, scene["text"]], check=True)
    info = subprocess.run(["afinfo", path], capture_output=True, text=True, check=True).stdout
    lengths[scene["id"]] = float(next(l for l in info.splitlines() if "estimated duration" in l).split(":")[1].split()[0])
    print(f"{scene['id']:<12}{lengths[scene['id']]:.1f}s")
json.dump(lengths, open(os.path.join(HERE, "build", "voice.json"), "w"), indent=1)
