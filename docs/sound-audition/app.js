/* Shared source-view renderer. All sample-specific content lives in data.js. */
const rows = window.AUDITION_DATA;
const players = [];
const status = document.querySelector('#status');
const escapeHTML = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const totalLength = ranges => ranges.reduce((sum, [a,b]) => sum + b-a, 0);
const format = seconds => seconds.toFixed(2);

function waveform(peaks) {
  return peaks.map(([low,high], i) => `M${i},${32-high*29}V${32-low*29}`).join(' ');
}

function renderSample(sample) {
  const {candidates} = sample;
  const variants = sample.variants ?? [{label: 'Original', media:sample.media}];
  let variantIndex = sample.defaultVariant ?? 0;
  let media = variants[variantIndex].media;
  const duration = media.duration;
  const article = document.createElement('article');
  article.innerHTML = `
    <div><h3>${escapeHTML(sample.title)}</h3><p>${escapeHTML(sample.description)}</p>
      <p class="credit">${escapeHTML(sample.author)} · <a href="${escapeHTML(sample.sourceUrl)}">Source</a> · <a href="${escapeHTML(sample.licenseUrl)}">${escapeHTML(sample.license)}</a></p></div>
    <div class="player">
      ${variants.length>1 ? `<div class="pitch-choices">${variants.map((v,i)=>`<button data-variant="${i}" aria-pressed="${i===variantIndex}">${escapeHTML(v.label)}</button>`).join('')}</div><p class="variant-note"></p>` : ''}
      <div class="choices">${candidates.map((c,i) => `<button data-choice="${i}">${escapeHTML(c.label)} · ${Math.round(totalLength(c.ranges)*1000)} ms</button>`).join('')}<button data-choice="full">Full clip</button></div>
      <div class="readout"><span class="clock"></span><span class="length"></span></div>
      <div class="timeline" tabindex="0" role="group" aria-label="${escapeHTML(sample.title)} source timeline. Click to seek; drag to select; arrow keys move the selection.">
        <svg class="wave" viewBox="0 0 ${media.peaks.length} 65" preserveAspectRatio="none" aria-hidden="true"><path d="${waveform(media.peaks)}" fill="none" stroke="#49735b" stroke-width="1"/></svg>
        <img class="spectrum" src="${escapeHTML(media.spectrum)}" alt="Source spectrogram for ${escapeHTML(sample.title)}" draggable="false">
        <div class="regions"></div><div class="cursor"></div>
      </div>
      <div class="ticks">${Array.from({length:6},(_,i)=>`<span>${format(duration*i/5)}s</span>`).join('')}</div>
      <div class="controls"><button class="play">Play</button><label>Start <input class="start" type="number" min="0" max="${duration}" step="0.01"> s</label><label>End <input class="end" type="number" min="0" max="${duration}" step="0.01"> s</label></div>
      <div class="range-info"></div>
      <audio controls preload="metadata" src="${escapeHTML(media.file)}"></audio>
    </div>`;
  const q = selector => article.querySelector(selector);
  const audio = q('audio');
  players.push(audio);
  audio.volume = .65;
  let ranges = [], playback = [], activeRange = 0, frame = 0, anchor = null;
  let expectedSeek = null, playhead = 0;
  const nextEnd = time => ranges.find(([,end]) => end > time + .002)?.[1] ?? duration;
  function seek(time) {
    playhead = time;
    expectedSeek = time;
    audio.currentTime = time;
    paint();
  }
  function setPlayhead(time) {
    playback = [[time, nextEnd(time)]];
    activeRange = 0;
    seek(time);
  }

  function paint() {
    q('.clock').textContent = `${format(audio.currentTime)} / ${format(duration)}s`;
    q('.cursor').style.left = `${audio.currentTime/duration*100}%`;
  }
  function setRanges(next, choice = null) {
    audio.pause();
    ranges = next.map(([a,b]) => [Math.max(0,Math.min(duration-.01,a)),Math.min(duration,b)])
      .map(([a,b]) => [a,Math.max(a+.01,b)]);
    activeRange = 0;
    playback = ranges.map(range => [...range]);
    q('.regions').innerHTML = ranges.map(([a,b]) => `<div class="region" style="left:${a/duration*100}%;width:${(b-a)/duration*100}%"></div>`).join('');
    q('.start').value = format(ranges[0][0]);
    q('.end').value = format(ranges.at(-1)[1]);
    q('.length').textContent = `${Math.round(totalLength(ranges)*1000)} ms selected`;
    q('.range-info').textContent = ranges.map(([a,b]) => `${format(a)}–${format(b)}s`).join(' + ') + (ranges.length>1 ? ' · gaps skipped during playback; editing start/end makes one continuous range' : '');
    for (const button of article.querySelectorAll('[data-choice]')) button.setAttribute('aria-pressed', String(button.dataset.choice === choice));
    seek(ranges[0][0]);
  }
  function tick() {
    cancelAnimationFrame(frame);
    if (!audio.paused && audio.currentTime >= playback[activeRange][1]-.002) {
      if (activeRange+1<playback.length) seek(playback[++activeRange][0]);
      else { audio.pause(); seek(playback.at(-1)[1]); }
    }
    paint();
    if (!audio.paused) frame = requestAnimationFrame(tick);
  }
  function playSelection() {
    playback = ranges.map(range => [...range]);
    activeRange = 0;
    seek(ranges[0][0]);
    return playCurrent();
  }
  async function playCurrent() {
    try { await audio.play(); } catch (error) { if(error.name !== 'AbortError') status.textContent = `Playback failed: ${error.message}`; }
  }
  for (const button of article.querySelectorAll('[data-choice]')) button.addEventListener('click', () => {
    const choice = button.dataset.choice;
    setRanges(choice === 'full' ? [[0,duration]] : candidates[Number(choice)].ranges, choice);
    playSelection();
  });
  q('.play').addEventListener('click', playCurrent);
  for(const input of [q('.start'), q('.end')]) input.addEventListener('change', () => {
    const a=q('.start').valueAsNumber, b=q('.end').valueAsNumber;
    if(Number.isFinite(a)&&Number.isFinite(b)) setRanges([[a,b]]);
  });
  const timeline = q('.timeline');
  const timeAt = event => {
    const box = timeline.getBoundingClientRect();
    return Math.max(0,Math.min(duration,(event.clientX-box.left)/box.width*duration));
  };
  timeline.addEventListener('pointerdown', event => {
    anchor = {time:timeAt(event), x:event.clientX, dragging:false};
    audio.pause();
    timeline.setPointerCapture(event.pointerId);
  });
  timeline.addEventListener('pointermove', event => {
    if(anchor===null)return;
    if(Math.abs(event.clientX-anchor.x)>=4)anchor.dragging=true;
    if(anchor.dragging){const t=timeAt(event);setRanges([[Math.min(anchor.time,t),Math.max(anchor.time,t)]]);}
  });
  timeline.addEventListener('pointerup', event => {
    if(anchor===null)return;
    const t=timeAt(event);
    if(anchor.dragging || Math.abs(event.clientX-anchor.x)>=4)
      setRanges([[Math.min(anchor.time,t),Math.max(anchor.time,t)]]);
    else setPlayhead(t);
    anchor=null;
  });
  timeline.addEventListener('pointercancel',()=>{anchor=null;});
  timeline.addEventListener('keydown', event => {
    if(!['ArrowLeft','ArrowRight',' '].includes(event.key))return;
    event.preventDefault();
    if(event.key===' '){playCurrent();return;}
    const requested=event.key==='ArrowLeft'?-.05:.05;
    const delta=Math.max(-ranges[0][0],Math.min(duration-ranges.at(-1)[1],requested));
    setRanges(ranges.map(([a,b])=>[a+delta,b+delta]));
  });
  audio.addEventListener('play', () => {
    status.textContent='';
    for(const other of players) if(other!==audio) other.pause();
    if(audio.currentTime >= playback.at(-1)[1]-.002 || audio.currentTime < playback[activeRange][0]-.002)
      setPlayhead(audio.currentTime);
    tick();
  });
  audio.addEventListener('seeking',()=>{
    if(expectedSeek!==null && Math.abs(audio.currentTime-expectedSeek)<.005) expectedSeek=null;
    else {
      expectedSeek=null;
      playhead=audio.currentTime;
      playback=[[playhead,nextEnd(playhead)]];
      activeRange=0;
    }
    paint();
  });
  audio.addEventListener('timeupdate',paint);
  audio.addEventListener('pause',()=>{cancelAnimationFrame(frame);paint();});
  audio.addEventListener('ended',()=>{cancelAnimationFrame(frame);paint();});
  audio.addEventListener('loadedmetadata',()=>{if(audio.paused)seek(playhead);paint();});
  audio.addEventListener('error',()=>{status.textContent=`Could not load ${sample.title}. Keep the page with its media files.`;});
  function describeVariant() {
    if(q('.variant-note'))q('.variant-note').textContent = variants[variantIndex].processing ?? 'Unchanged original recording.';
  }
  let variantSwitch = 0;
  for(const button of article.querySelectorAll('[data-variant]'))button.addEventListener('click',()=>{
    const version = ++variantSwitch;
    audio.pause();
    variantIndex = Number(button.dataset.variant);
    media = variants[variantIndex].media;
    q('.wave path').setAttribute('d',waveform(media.peaks));
    q('.spectrum').src = media.spectrum;
    for(const choice of article.querySelectorAll('[data-variant]'))choice.setAttribute('aria-pressed',String(choice===button));
    describeVariant();
    audio.addEventListener('loadedmetadata',()=>{if(version===variantSwitch)playSelection();},{once:true});
    audio.src = media.file;
    audio.load();
  });
  describeVariant();
  setRanges(candidates[0].ranges,'0');
  return article;
}

for(const [section,title] of [['current','Current'],['proposal','Proposals'],['rejected','Rejected']]){
  const matches=rows.filter(row=>row.section===section);
  if(section!=='current') matches.sort((a,b)=>b.addedOrder-a.addedOrder);
  const heading=document.createElement('h2');heading.textContent=`${title} · ${matches.length}${section==='current'?'':' · newest added first'}`;
  document.querySelector('#samples').append(heading,...matches.map(renderSample));
}
document.querySelector('#stop').addEventListener('click',()=>{for(const audio of players)audio.pause();});
