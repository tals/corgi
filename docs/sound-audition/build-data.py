"""Rebuild local browser data and spectrograms: python3 build-data.py (requires ffmpeg)."""
import array
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parent

def media(file, key):
    path = ROOT / file
    pcm = array.array('f', subprocess.check_output([
        'ffmpeg', '-v', 'error', '-i', str(path), '-ac', '1', '-ar', '24000', '-f', 'f32le', '-']))
    duration = len(pcm) / 24000
    peak = max(map(abs, pcm)) or 1
    count = 700
    peaks = []
    for i in range(count):
        chunk = pcm[i * len(pcm) // count:(i + 1) * len(pcm) // count]
        peaks.append([round(min(chunk) / peak, 4), round(max(chunk) / peak, 4)])
    image = f'media/{key}.png'
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', str(path), '-lavfi',
        'aresample=24000,showspectrumpic=s=1200x240:legend=0:scale=log:fscale=log:color=viridis:drange=75',
        '-frames:v', '1', str(ROOT / image)], check=True)
    return dict(file=file, duration=duration, peaks=peaks, spectrum=image)

rows = []
for slug, title in [('request', 'Attention / needs input'), ('done', 'Done')]:
    source = media(f'../../src/sounds/{slug}.mp3', slug)
    rows.append(dict(id=slug, section='current', title=title, description='Current Herdr cue.',
        author='Herdr', license='Apache-2.0', licenseUrl='../../src/sounds/LICENSE',
        sourceUrl='https://github.com/herdrdev/herdr/tree/3667151744e379ac5c8f76d57203b675de8a6ebc/assets/sounds',
        media=source, candidates=[dict(label='Full cue', ranges=[[0, source['duration']]])]))

for entry in json.loads((ROOT / 'sources.json').read_text()):
    slug = entry['slug']
    source = media(f'{slug}-raw.mp3', slug)
    candidates = []
    if entry.get('candidates'):
        for i, candidate in enumerate(entry['candidates']):
            candidates.append(dict(label=chr(65 + i), ranges=[[candidate['start'], candidate['end']]]))
    elif entry.get('gap_trim') and not entry.get('quality_check') and entry.get('status') == 'proposal':
        # Spliced proposal: retain the actual selected source intervals, not a fictitious continuous cut.
        offset = entry.get('silence_trim', {}).get('leading_seconds', 0)
        candidates = [dict(label='A', ranges=[[a + offset, b + offset]
            for a, b in entry['gap_trim']['kept_spans_seconds']])]
    elif 'excerpt_start' in entry:
        candidates = [dict(label='A', ranges=[[entry['excerpt_start'],
            min(source['duration'], entry['excerpt_start'] + entry['excerpt_duration'])]])]
    else:
        candidates = [dict(label='Full clip', ranges=[[0, source['duration']]])]
    row = dict(id=slug, section=entry['status'], title=entry['title'], addedOrder=entry['added_order'],
        description=entry.get('rejection_reason', entry.get('description', 'Selected dog vocalization.')),
        author=entry['author'], license=entry['license'],
        licenseUrl='https://creativecommons.org/publicdomain/zero/1.0/', sourceUrl=entry['source'],
        media=source, candidates=candidates)
    if entry.get('pitch_variants'):
        row['variants'] = [dict(label='Original', media=source)] + [
            dict(label=variant['label'], media=media(variant['file'], Path(variant['file']).stem), processing=variant['processing'])
            for variant in entry['pitch_variants']]
        row['defaultVariant'] = entry.get('default_pitch_variant', 0)
        for variant in row['variants']:
            assert abs(variant['media']['duration'] - source['duration']) < .001
    rows.append(row)
    for i, rejected in enumerate(entry.get('rejected_variants', [])):
        rows.append(dict(row, id=f'{slug}-rejected-{i}', section='rejected',
            title=f'{entry["title"]} · rejected late cut', description=rejected['reason'], addedOrder=rejected['added_order'],
            candidates=[dict(label='Rejected cut', ranges=[[rejected['start'], rejected['end']]])]))

for row in rows:
    for candidate in row['candidates']:
        for start, end in candidate['ranges']:
            assert 0 <= start < end <= row['media']['duration'] + .001, (row['id'], start, end)
(ROOT / 'data.js').write_text('window.AUDITION_DATA = ' + json.dumps(rows, separators=(',', ':')) + ';\n')
print(f'Built {len(rows)} source views from sources.json.')
