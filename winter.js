'use strict';

const video = document.querySelector('#fir');
const viewer = document.querySelector('#viewer');
const gate = document.querySelector('#orientation-gate');
const play = document.querySelector('#playback');
const statusLine = document.querySelector('#status');
const landscape = matchMedia('(orientation: landscape)');
const mp4 = 'fir-pink-1080.mp4';
const hls = 'stream-pink/stream.m3u8';
const codec = 'video/mp4; codecs="avc1.4d4028"';
const supportsHls = Boolean(video.canPlayType('application/vnd.apple.mpegurl'));
const appleMobile = /iP(?:ad|hone|od)/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const supportsSegments = typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported(codec);
let sourceMode = supportsHls && (appleMobile || !supportsSegments) ? 'hls' :
  supportsSegments ? 'segments' : 'mp4';
let forced = false;
let loaded = false;
let wanted = !matchMedia('(prefers-reduced-motion: reduce)').matches;
let startupTimer;
let loadStartedAt;
let playRequest = null;
let segmentRequest;
let streamUrl;

async function resume() {
  if (viewer.hidden || !loaded || playRequest || !video.paused) return;
  if (!wanted) {
    statusLine.textContent = '';
    play.hidden = false;
    return;
  }
  try {
    playRequest = video.play();
    await playRequest;
  } catch (error) {
    if (error.name === 'NotAllowedError') {
      wanted = false;
      if (!viewer.hidden) {
        statusLine.textContent = '';
        play.hidden = false;
      }
    }
  } finally {
    playRequest = null;
    if (viewer.hidden) video.pause();
  }
}

function prepare() {
  clearTimeout(startupTimer);
  loaded = false;
  play.hidden = true;
  statusLine.textContent = '';
  loadStartedAt = performance.now();
  video.preload = 'auto';
  video.src = sourceMode === 'segments' ? openSegments() : sourceMode === 'hls' ? hls : mp4;
  video.load();
  startupTimer = setTimeout(onMediaError, 25000);
}

function onMediaError() {
  clearTimeout(startupTimer);
  if (sourceMode !== 'mp4') {
    releaseSegments();
    sourceMode = 'mp4';
    prepare();
    return;
  }
  play.hidden = true;
  statusLine.textContent = '视频加载失败，请刷新页面。';
}

function releaseSegments() {
  segmentRequest?.abort();
  if (streamUrl) URL.revokeObjectURL(streamUrl);
  streamUrl = undefined;
}

function openSegments() {
  const stream = new MediaSource();
  segmentRequest = new AbortController();
  const {signal} = segmentRequest;
  stream.addEventListener('sourceopen', () => {
    fillBuffer(stream, signal).catch(() => {
      if (!signal.aborted) onMediaError();
    });
  }, {once: true});
  streamUrl = URL.createObjectURL(stream);
  return streamUrl;
}

async function fillBuffer(stream, signal) {
  async function download(path) {
    const response = await fetch(path, {signal});
    if (!response.ok) throw new Error('Media segment is unavailable');
    return response;
  }

  const playlist = (await (await download(hls)).text()).replace(/\r/g, '');
  const init = playlist.match(/^#EXT-X-MAP:URI="(init\.mp4)"$/m)?.[1];
  const segmentNames = playlist.match(/^segment-\d+\.mp4$/gm);
  const durations = [...playlist.matchAll(/^#EXTINF:([\d.]+),/gm)];
  if (!init || !segmentNames?.length || durations.length !== segmentNames.length) {
    throw new Error('Incomplete video playlist');
  }

  const buffer = stream.addSourceBuffer(codec);
  stream.duration = durations.reduce((total, entry) => total + Number(entry[1]), 0);
  const base = new URL(hls, location.href);
  for (const name of [init, ...segmentNames]) {
    const segment = await (await download(new URL(name, base))).arrayBuffer();
    await new Promise((resolve, reject) => {
      buffer.addEventListener('updateend', () => {
        if (video.error || signal.aborted) reject(new Error('Video buffering interrupted'));
        else resolve();
      }, {once: true});
      buffer.appendBuffer(segment);
    });
    allowPlayback();
  }
  stream.endOfStream();
}

function layout() {
  if (landscape.matches) forced = false;
  const active = landscape.matches || forced;
  viewer.hidden = !active;
  gate.hidden = active;
  viewer.classList.toggle('sideways', forced);
  if (!active) {
    video.pause();
    return;
  }
  if (!video.hasAttribute('src')) prepare();
  else resume();
}

const rotate = document.querySelector('#rotate');
rotate.addEventListener('click', () => { forced = true; layout(); });
rotate.disabled = false;
if (landscape.addEventListener) landscape.addEventListener('change', layout);
else landscape.addListener(layout);
play.addEventListener('click', () => { wanted = true; resume(); });
video.addEventListener('canplay', () => {
  clearTimeout(startupTimer);
  allowPlayback();
});
video.addEventListener('progress', allowPlayback);
video.addEventListener('canplaythrough', allowPlayback);

function allowPlayback() {
  if (loaded || video.readyState < HTMLMediaElement.HAVE_FUTURE_DATA) return;
  if (sourceMode === 'segments') {
    // Leave a safety margin so the remaining download can finish before the loop ends.
    const {buffered, duration} = video;
    if (!Number.isFinite(duration) || !buffered.length || buffered.start(0) > 0.05) return;
    const end = buffered.end(0);
    const elapsed = (performance.now() - loadStartedAt) / 1000;
    const remainingDownload = (duration - end) * elapsed / end;
    const fullyBuffered = end >= duration - 0.1;
    if (!fullyBuffered && (end < 2 || remainingDownload > duration - 3)) return;
  }
  loaded = true;
  resume();
}

video.addEventListener('error', onMediaError);
video.addEventListener('playing', () => {
  play.hidden = true;
  statusLine.textContent = '';
});
window.addEventListener('pagehide', event => {
  if (!event.persisted) releaseSegments();
});
layout();
