// Turn whatever a phone recorded (4K, 60 fps, HEVC, HDR, rotated) into one file every browser plays:
// H.264 + AAC in MP4, long edge at most 1920 px, at most 30 fps, SDR. The original is never modified.
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
  const [n, d] = String(v.avg_frame_rate || v.r_frame_rate || '0/1').split('/').map(Number);
  const rot = Number(v.tags?.rotate ?? v.side_data_list?.find(s => s.rotation !== undefined)?.rotation ?? 0);
  const turned = Math.abs(rot) % 180 === 90;
  return {
    width: turned ? v.height : v.width, height: turned ? v.width : v.height,
    fps: d ? n / d : 0,
    duration: Number(j.format?.duration || v.duration || 0),
    hdr: ['smpte2084', 'arib-std-b67'].includes(v.color_transfer),
    audio: (j.streams || []).some(s => s.codec_type === 'audio'),
  };
}

const SCALE = "scale=w='if(gte(iw,ih),trunc(min(1920,iw)/2)*2,-2)':h='if(gte(iw,ih),-2,trunc(min(1920,ih)/2)*2)'";
const TONEMAP = 'zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv';

async function encode(src, dst, info, tonemap) {
  const vf = [SCALE, ...(tonemap ? [TONEMAP] : []), ...(info.fps > 30.5 ? ['fps=30'] : []), 'format=yuv420p'].join(',');
  await run('nice', ['-n', '10', 'ffmpeg', '-v', 'error', '-y', '-i', src,
    '-map', '0:v:0', ...(info.audio ? ['-map', '0:a:0'] : []), '-map_metadata', '-1',
    '-vf', vf, '-c:v', 'libx264', '-preset', 'fast', '-crf', '21', '-profile:v', 'high',
    ...(tonemap ? [] : ['-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709']),
    ...(info.audio ? ['-c:a', 'aac', '-b:a', '128k', '-ac', '2'] : []),
    '-movflags', '+faststart', '-max_muxing_queue_size', '2048', '-f', 'mp4', dst]);
}

// Writes dst (mp4) and poster (jpg). Returns what the player needs to know about the result.
export async function transcode(src, dst, poster) {
  const info = await probe(src), tmp = dst + '.part';
  try {
    if (info.hdr) {
      try { await encode(src, tmp, info, true); }
      catch (e) { console.error('tone mapping failed, encoding without it:', e.message); await encode(src, tmp, info, false); }
    } else await encode(src, tmp, info, false);
    const out = await probe(tmp);
    await run('ffmpeg', ['-v', 'error', '-y', '-ss', String(Math.min(1, out.duration / 3)), '-i', tmp, '-frames:v', '1', '-q:v', '3',
      '-vf', "scale='min(1280,iw)':-2", '-f', 'image2', poster]);
    await fsp.rename(tmp, dst);
    return { width: out.width, height: out.height, duration: out.duration, size: (await fsp.stat(dst)).size };
  } finally {
    await fsp.rm(tmp, { force: true });
  }
}
