// Make a copy of each video that every browser can play smoothly, without giving up resolution or frame rate.
//
//   direct     The original is already H.264 (8-bit, SDR) at a sane bitrate: its video stream is copied
//              bit for bit into an MP4 whose index sits at the front, so playback can start while it downloads.
//   converted  Anything else (HEVC, HDR, 10-bit, unusual codecs, runaway bitrates) is encoded once to H.264
//              at the SAME resolution and frame rate (up to 4K and 60 fps), with HDR tone-mapped to SDR.
//
// The uploaded original itself is never modified.
import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';

function run(cmd, args, { capture = false } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', capture ? 'pipe' : 'ignore', 'pipe'] });
    let out = '', err = '';
    if (capture) p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { err = (err + d).slice(-4000); });
    p.on('error', reject);
    p.on('close', code => (code === 0 ? resolve(out) : reject(new Error(`${cmd} exited ${code}: ${err.trim().split('\n').slice(-3).join(' | ')}`))));
  });
}

export async function probe(file) {
  const j = JSON.parse(await run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file], { capture: true }));
  const v = (j.streams || []).find(s => s.codec_type === 'video' && s.disposition?.attached_pic !== 1);
  if (!v) throw new Error('no video stream');
  const a = (j.streams || []).find(s => s.codec_type === 'audio');
  const [n, d] = String(v.avg_frame_rate || v.r_frame_rate || '0/1').split('/').map(Number);
  const rot = Number(v.tags?.rotate ?? v.side_data_list?.find(s => s.rotation !== undefined)?.rotation ?? 0);
  const turned = Math.abs(rot) % 180 === 90;
  const duration = Number(j.format?.duration || v.duration || 0);
  const size = Number(j.format?.size || 0);
  return {
    width: turned ? v.height : v.width, height: turned ? v.width : v.height,
    fps: d ? Math.round(n / d * 100) / 100 : 0,
    duration, size,
    bitrate: Number(v.bit_rate) || (duration ? size * 8 / duration : 0),   // bits per second
    codec: v.codec_name, pix: v.pix_fmt,
    hdr: ['smpte2084', 'arib-std-b67'].includes(v.color_transfer),
    audio: a ? a.codec_name : null,
  };
}

// The most a clip of this size and frame rate is allowed to weigh, in bits per second. Roughly: 1080p30 10 Mb/s,
// 1080p60 16, 4K30 25, 4K60 40. High enough that phone footage shows no visible loss, low enough to stream.
export function ceiling(width, height, fps) {
  const perSecond = width * height * Math.min(Math.max(fps || 30, 24), 60);
  return Math.round(10e6 * Math.pow(perSecond / (1920 * 1080 * 30), 0.66));
}

const TONEMAP = 'zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv';
const audioArgs = info => (!info.audio ? [] : info.audio === 'aac' ? ['-map', '0:a:0', '-c:a', 'copy'] : ['-map', '0:a:0', '-c:a', 'aac', '-b:a', '160k', '-ac', '2']);
const OUT = ['-movflags', '+faststart', '-max_muxing_queue_size', '4096', '-f', 'mp4'];

function isDirect(info) {
  return info.codec === 'h264' && ['yuv420p', 'yuvj420p'].includes(info.pix) && !info.hdr
    && Math.max(info.width, info.height) <= 3840 && info.fps <= 61
    && info.bitrate <= ceiling(info.width, info.height, info.fps) * 1.35;
}
async function remux(src, dst, info) {
  await run('ffmpeg', ['-v', 'error', '-y', '-i', src, '-map', '0:v:0', '-c:v', 'copy', ...audioArgs(info), ...OUT, dst]);
}
async function encode(src, dst, info, tonemap) {
  const long = Math.max(info.width, info.height), cap = ceiling(Math.min(info.width, 3840), Math.min(info.height, 3840), info.fps);
  const vf = [
    ...(long > 3840 ? ["scale=w='if(gte(iw,ih),3840,-2)':h='if(gte(iw,ih),-2,3840)'"] : []),   // only beyond 4K
    ...(tonemap ? [TONEMAP] : []),
    ...(info.fps > 61 ? ['fps=60'] : []),                                                        // only beyond 60 fps
    'format=yuv420p',
  ].join(',');
  await run('nice', ['-n', '10', 'ffmpeg', '-v', 'error', '-y', '-i', src, '-map', '0:v:0', '-map_metadata', '-1', '-vf', vf,
    '-c:v', 'libx264', '-preset', long > 1920 ? 'veryfast' : 'fast', '-crf', '19', '-profile:v', 'high',
    '-maxrate', String(cap), '-bufsize', String(cap * 2), '-g', String(Math.round(Math.min(info.fps || 30, 60) * 2)),
    ...(tonemap ? [] : ['-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709']),
    ...audioArgs(info), ...OUT, dst]);
}

// Writes dst (mp4) and poster (jpg). Returns what the player and the admin page need to know.
export async function prepare(src, dst, poster) {
  const info = await probe(src), tmp = dst + '.part';
  let mode = 'converted';
  try {
    if (isDirect(info)) {
      try { await remux(src, tmp, info); mode = 'direct'; }
      catch (e) { console.error('copy failed, converting instead:', e.message); await encode(src, tmp, info, false); }
    } else if (info.hdr) {
      try { await encode(src, tmp, info, true); }
      catch (e) { console.error('tone mapping failed, converting without it:', e.message); await encode(src, tmp, info, false); }
    } else await encode(src, tmp, info, false);

    const out = await probe(tmp);
    await run('ffmpeg', ['-v', 'error', '-y', '-ss', String(Math.min(1, out.duration / 3)), '-i', tmp, '-frames:v', '1', '-q:v', '3',
      '-vf', "scale='min(1280,iw)':-2", '-f', 'image2', poster]);
    await fsp.rename(tmp, dst);
    return {
      mode, width: out.width, height: out.height, fps: out.fps, duration: out.duration, size: (await fsp.stat(dst)).size,
      from: { codec: info.codec, width: info.width, height: info.height, fps: info.fps, hdr: info.hdr, mbps: Math.round(info.bitrate / 1e5) / 10 },
    };
  } finally {
    await fsp.rm(tmp, { force: true });
  }
}
