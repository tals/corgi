"""Create equal-duration pitch alternatives (requires ffmpeg and rubberband)."""
import array
import json
import math
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parent

def decode(path):
    return array.array('f', subprocess.check_output(['ffmpeg', '-v', 'error', '-i', str(path), '-f', 'f32le', '-']))

with tempfile.TemporaryDirectory() as folder:
    source = Path(folder) / 'source.wav'
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', str(ROOT/'happy-terrier-raw.mp3'), '-c:a', 'pcm_f32le', str(source)], check=True)
    reference = decode(source)
    variants = []
    for semitones in [-3, -5, -7]:
        shifted = Path(folder) / 'shifted.wav'
        subprocess.run(['rubberband', '-3', '-t', '1', '-p', str(semitones), str(source), str(shifted)], check=True, capture_output=True)
        samples = decode(shifted)
        assert len(samples) == len(reference), 'Pitch shift changed sample count'
        peak = max(map(abs, samples))
        gain = min(1, 10**(-3/20) / peak)
        file = f'happy-terrier-minus{abs(semitones)}.wav'
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', str(shifted), '-af', f'volume={gain}', '-c:a', 'pcm_s24le', str(ROOT/file)], check=True)
        output = decode(ROOT/file)
        assert len(output) == len(reference)
        assert max(map(abs, output)) < .72
        variants.append(dict(label=f'{semitones} semitones', file=file, semitones=semitones,
            processing=f'Rubber Band 4.0 R3 offline; time ratio 1; formants shift with pitch; gain {20*math.log10(gain):.2f} dB; 24-bit WAV. Exact decoded sample count preserved.'))
        print(file, 'sample count unchanged; peak', round(20*math.log10(max(map(abs, output))), 2), 'dBFS')
    path = ROOT/'sources.json'
    entries = json.loads(path.read_text())
    item = next(entry for entry in entries if entry['slug']=='happy-terrier')
    item['pitch_variants'] = variants
    item['default_pitch_variant'] = 1
    item['description'] = 'Original rejected as too high-pitched. Audition lower-pitched alternatives; timing is unchanged.'
    path.write_text(json.dumps(entries, indent=2)+'\n')
