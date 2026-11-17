"""Builds the sound track: an original, synthesised background track (so there are no licensing
questions) with the voice lines placed at each scene's start, and the music ducked under the voice.

Needs only the Python standard library and macOS's afconvert.
Reads build/voice/*.aiff, build/timeline.json and build/frames.json; writes build/soundtrack.wav.
"""
import array
import json
import math
import os
import random
import subprocess
import wave

HERE = os.path.dirname(os.path.abspath(__file__))
BUILD = os.path.join(HERE, "build")
RATE = 44100
VOICE_DELAY = 0.35  # seconds after a scene starts before its line begins
MUSIC_LEVEL = 0.26
MUSIC_UNDER_VOICE = 0.085


def load_voice(scene_id):
    wav = os.path.join(BUILD, "voice", f"{scene_id}.wav")
    subprocess.run(["afconvert", "-f", "WAVE", "-d", f"LEI16@{RATE}", "-c", "1",
                    os.path.join(BUILD, "voice", f"{scene_id}.aiff"), wav], check=True)
    with wave.open(wav) as w:
        data = array.array("h", w.readframes(w.getnframes()))
    return [s / 32768 for s in data]


def note(n):
    """MIDI note number to frequency."""
    return 440.0 * 2 ** ((n - 69) / 12)


def music(seconds):
    """A calm, upbeat bed: C-G-Am-F at 100 bpm with a pad, an arpeggio, a soft kick and a shaker."""
    total = int(seconds * RATE)
    out = array.array("f", bytes(4 * total))
    beat = 60 / 100
    bar = beat * 4
    chords = [[48, 55, 60, 64, 67], [43, 50, 59, 62, 67], [45, 52, 57, 60, 64], [41, 48, 57, 60, 65]]
    rnd = random.Random(7)
    two_pi = 2 * math.pi

    def add(start, length, fn):
        a = int(start * RATE)
        for i in range(max(0, a), min(total, a + int(length * RATE))):
            out[i] += fn((i - a) / RATE)

    t = 0.0
    n_bar = 0
    while t < seconds:
        chord = chords[n_bar % 4]
        # Pad: soft, slightly detuned sines that swell over the bar.
        for m in chord[1:]:
            f = note(m)
            add(t, bar + 0.4, lambda x, f=f: 0.045 * min(1, x / 0.6) * min(1, (bar + 0.4 - x) / 0.6)
                * (math.sin(two_pi * f * x) + 0.6 * math.sin(two_pi * f * 1.003 * x)))
        # Bass on the root.
        fb = note(chord[0] - 12)
        for k in (0, 2):
            add(t + k * beat, beat * 1.8, lambda x, f=fb: 0.16 * math.exp(-x * 2.2) * math.sin(two_pi * f * x))
        # Arpeggio in eighth notes once the intro has settled in.
        if n_bar >= 1:
            pattern = [chord[2], chord[3], chord[4], chord[3] + 12, chord[4], chord[3], chord[2] + 12, chord[3]]
            for k, m in enumerate(pattern):
                f = note(m + 12)
                add(t + k * beat / 2, 0.45, lambda x, f=f: 0.05 * math.exp(-x * 7) * (math.sin(two_pi * f * x) + 0.3 * math.sin(two_pi * 2 * f * x)))
        # Soft kick on 1 and 3, shaker on the off-beats, from the second bar.
        if n_bar >= 2:
            for k in (0, 2):
                add(t + k * beat, 0.25, lambda x: 0.32 * math.exp(-x * 18) * math.sin(two_pi * (50 + 90 * math.exp(-x * 30)) * x))
            for k in range(4):
                add(t + k * beat + beat / 2, 0.06, lambda x: 0.035 * math.exp(-x * 60) * (rnd.random() * 2 - 1))
        t += bar
        n_bar += 1

    # Gentle fade in and a longer fade out.
    for i in range(total):
        x = i / RATE
        out[i] *= min(1, x / 1.5) * min(1, (seconds - x) / 3.0)
    return out


def main():
    frames = json.load(open(os.path.join(BUILD, "frames.json")))
    timeline = json.load(open(os.path.join(BUILD, "timeline.json")))
    start = frames["frames"][0]["t"]
    seconds = frames["end"] - start
    total = int(seconds * RATE)

    voice = array.array("f", bytes(4 * total))
    speaking = array.array("f", bytes(4 * total))
    for scene in timeline:
        clip = load_voice(scene["id"])
        at = int((scene["t"] - start + VOICE_DELAY) * RATE)
        for i, s in enumerate(clip):
            if at + i < total:
                voice[at + i] += s * 0.95
                speaking[at + i] = 1
    # Smooth the "someone is speaking" envelope so the music dips and returns gently.
    # Music level follows a one-pole envelope: quick to dip under the voice, slow to come back.
    down = 1 - math.exp(-1 / (0.15 * RATE))
    up = 1 - math.exp(-1 / (0.8 * RATE))
    ahead = int(0.2 * RATE)  # look ahead, so the music is already down when the first word starts
    bed = music(seconds)
    peak = max(abs(x) for x in bed) or 1
    level = MUSIC_LEVEL
    mix = array.array("h", bytes(2 * total))
    for i in range(total):
        target = MUSIC_UNDER_VOICE if speaking[min(total - 1, i + ahead)] else MUSIC_LEVEL
        level += (target - level) * (down if target < level else up)
        v = voice[i] + bed[i] / peak * level
        mix[i] = max(-32767, min(32767, int(math.tanh(v) * 32767)))
    with wave.open(os.path.join(BUILD, "soundtrack.wav"), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(mix.tobytes())
    print(f"soundtrack: {seconds:.1f}s")


if __name__ == "__main__":
    main()
