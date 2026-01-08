const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
const schedulerService = require('./schedulerService');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db/database');
const Stream = require('../models/Stream');
const Playlist = require('../models/Playlist');

// === DETEKSI ARSITEKTUR UNTUK OPTIMASI ARM32 ===
const os = require('os');
const isARM32 = os.arch() === 'arm' && os.totalmem() < 2 * 1024 * 1024 * 1024;
console.log(`[StreamingService] Architecture: ${os.arch()}, RAM: ${(os.totalmem() / 1024 / 1024).toFixed(0)} MB, isARM32: ${isARM32}`);

// === KONFIGURASI DEFAULT BERDASARKAN ARSITEKTUR ===
const DEFAULT_BITRATE = isARM32 ? 1000 : 2500;
const DEFAULT_RESOLUTION = isARM32 ? '960x540' : '1280x720';
const DEFAULT_FPS = isARM32 ? 25 : 30;
const ENCODING_PRESET = isARM32 ? 'ultrafast' : 'veryfast';

let ffmpegPath;
if (fs.existsSync('/usr/bin/ffmpeg')) {
  ffmpegPath = '/usr/bin/ffmpeg';
  console.log('Using system FFmpeg at:', ffmpegPath);
} else {
  ffmpegPath = ffmpegInstaller.path;
  console.log('Using bundled FFmpeg at:', ffmpegPath);
}

const Video = require('../models/Video');
const activeStreams = new Map();
const streamLogs = new Map();
const streamRetryCount = new Map();
const streamLastSuccessTime = new Map();
const MAX_RETRY_ATTEMPTS = isARM32 ? 5 : 10;
const RETRY_RESET_INTERVAL = 30 * 60 * 1000;
const manuallyStoppingStreams = new Set();
const MAX_LOG_LINES = 100;
const HEALTH_CHECK_INTERVAL = 60 * 1000;

function addStreamLog(streamId, message) {
  if (!streamLogs.has(streamId)) {
    streamLogs.set(streamId, []);
  }
  const logs = streamLogs.get(streamId);
  logs.push({
    timestamp: new Date().toISOString(),
    message
  });
  if (logs.length > MAX_LOG_LINES) {
    logs.shift();
  }
}

function cleanupStreamData(streamId, keepLogs = true) {
  streamRetryCount.delete(streamId);
  streamLastSuccessTime.delete(streamId);
  if (!keepLogs) {
    streamLogs.delete(streamId);
  }
}

function cleanupOldLogs() {
  const activeIds = new Set(activeStreams.keys());
  for (const [streamId] of streamLogs) {
    if (!activeIds.has(streamId)) {
      const logs = streamLogs.get(streamId);
      if (logs && logs.length > 0) {
        const lastLogTime = new Date(logs[logs.length - 1].timestamp).getTime();
        if (Date.now() - lastLogTime > 60 * 60 * 1000) {
          streamLogs.delete(streamId);
          console.log(`[StreamingService] Cleaned up old logs for stream ${streamId}`);
        }
      }
    }
  }
}

function checkAndResetRetryCounter(streamId) {
  const lastSuccess = streamLastSuccessTime.get(streamId);
  if (lastSuccess && (Date.now() - lastSuccess) >= RETRY_RESET_INTERVAL) {
    const oldCount = streamRetryCount.get(streamId) || 0;
    if (oldCount > 0) {
      streamRetryCount.set(streamId, 0);
      console.log(`[StreamingService] Reset retry counter for stream ${streamId}`);
    }
    streamLastSuccessTime.set(streamId, Date.now());
  }
}

function markStreamSuccess(streamId) {
  if (!streamLastSuccessTime.has(streamId)) {
    streamLastSuccessTime.set(streamId, Date.now());
  }
  checkAndResetRetryCounter(streamId);
}

async function buildFFmpegArgsForPlaylist(stream, playlist) {
  if (!playlist.videos || playlist.videos.length === 0) {
    throw new Error(`Playlist is empty for playlist_id: ${stream.video_id}`);
  }

  const projectRoot = path.resolve(__dirname, '..');
  const rtmpUrl = `${stream.rtmp_url.replace(/\/$/, '')}/${stream.stream_key}`;

  let videoPaths = [];

  if (playlist.is_shuffle || playlist.shuffle) {
    const shuffledVideos = [...playlist.videos].sort(() => Math.random() - 0.5);
    videoPaths = shuffledVideos.map(video => {
      const relativeVideoPath = video.filepath.startsWith('/') ? video.filepath.substring(1) : video.filepath;
      return path.join(projectRoot, 'public', relativeVideoPath);
    });
  } else {
    videoPaths = playlist.videos.map(video => {
      const relativeVideoPath = video.filepath.startsWith('/') ? video.filepath.substring(1) : video.filepath;
      return path.join(projectRoot, 'public', relativeVideoPath);
    });
  }

  for (const videoPath of videoPaths) {
    if (!fs.existsSync(videoPath)) {
      throw new Error(`Video file not found: ${videoPath}`);
    }
  }

  const concatFile = path.join(projectRoot, 'temp', `playlist_${stream.id}.txt`);
  const tempDir = path.dirname(concatFile);
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }

  let concatContent = '';
  const loopLimit = isARM32 ? 10 : 1000;
  const actualLoop = stream.loop_video ? loopLimit : 1;

  for (let i = 0; i < actualLoop; i++) {
    videoPaths.forEach(videoPath => {
      concatContent += `file '${videoPath.replace(/\\/g, '/')}'\n`;
    });
  }

  fs.writeFileSync(concatFile, concatContent);

  if (!stream.use_advanced_settings) {
    return [
      '-nostdin',
      '-loglevel', 'warning',
      '-re',
      '-fflags', '+genpts+igndts',
      '-f', 'concat',
      '-safe', '0',
      '-i', concatFile,
      '-c:v', 'copy',
      '-c:a', 'copy',
      '-b:a', '128k',
      '-ar', '44100',
      '-f', 'flv',
      rtmpUrl
    ];
  }

  const resolution = stream.resolution || DEFAULT_RESOLUTION;
  const bitrate = stream.bitrate || DEFAULT_BITRATE;
  const fps = stream.fps || DEFAULT_FPS;
  const gopSize = fps * 2;

  return [
    '-nostdin',
    '-loglevel', 'warning',
    '-re',
    '-fflags', '+genpts+igndts',
    '-f', 'concat',
    '-safe', '0',
    '-i', concatFile,
    '-c:v', 'libx264',
    '-preset', ENCODING_PRESET,
    '-profile:v', 'high',
    '-level', '4.1',
    '-b:v', `${bitrate}k`,
    '-maxrate', `${Math.round(bitrate * 1.2)}k`,
    '-bufsize', `${bitrate * 2}k`,
    '-pix_fmt', 'yuv420p',
    '-g', gopSize.toString(),
    '-keyint_min', gopSize.toString(),
    '-sc_threshold', '0',
    '-s', resolution,
    '-r', fps.toString(),
    '-c:a', 'aac',
    '-b:a', '128k',
    '-ar', '44100',
    '-ac', '2',
    '-f', 'flv',
    rtmpUrl
  ];
}

async function buildFFmpegArgs(stream) {
  const streamWithVideo = await Stream.getStreamWithVideo(stream.id);

  if (streamWithVideo && streamWithVideo.video_type === 'playlist') {
    const playlist = await Playlist.findByIdWithVideos(stream.video_id);
    if (!playlist) {
      throw new Error(`Playlist not found for playlist_id: ${stream.video_id}`);
    }
    return await buildFFmpegArgsForPlaylist(stream, playlist);
  }

  const video = await Video.findById(stream.video_id);
  if (!video) {
    throw new Error(`Video record not found in database for video_id: ${stream.video_id}`);
  }

  const relativeVideoPath = video.filepath.startsWith('/') ? video.filepath.substring(1) : video.filepath;
  const projectRoot = path.resolve(__dirname, '..');
  const videoPath = path.join(projectRoot, 'public', relativeVideoPath);

  if (!fs.existsSync(videoPath)) {
    console.error(`[StreamingService] CRITICAL: Video file not found on disk.`);
    console.error(`[StreamingService] Checked path: ${videoPath}`);
    throw new Error('Video file not found on disk.');
  }

  const rtmpUrl = `${stream.rtmp_url.replace(/\/$/, '')}/${stream.stream_key}`;
  const loopOption = '-stream_loop';
  const loopValue = stream.loop_video ? (isARM32 ? '5' : '-1') : '0';

  if (!stream.use_advanced_settings) {
    return [
      '-nostdin',
      '-loglevel', 'warning',
      '-re',
      '-fflags', '+genpts+igndts',
      loopOption, loopValue,
      '-i', videoPath,
      '-c:v', 'copy',
      '-c:a', 'copy',
      '-b:a', '128k',
      '-ar', '44100',
      '-f', 'flv',
      rtmpUrl
    ];
  }

  const resolution = stream.resolution || DEFAULT_RESOLUTION;
  const bitrate = stream.bitrate || DEFAULT_BITRATE;
  const fps = stream.fps || DEFAULT_FPS;
  const gopSize = fps * 2;

  return [
    '-nostdin',
    '-loglevel', 'warning',
    '-re',
    '-fflags', '+genpts+igndts',
    loopOption, loopValue,
    '-i', videoPath,
    '-c:v', 'libx264',
    '-preset', ENCODING_PRESET,
    '-profile:v', 'high',
    '-level', '4.1',
    '-b:v', `${bitrate}k`,
    '-maxrate', `${Math.round(bitrate * 1.2)}k`,
    '-bufsize', `${bitrate * 2}k`,
    '-pix_fmt', 'yuv420p',
    '-g', gopSize.toString(),
    '-keyint_min', gopSize.toString(),
    '-sc_threshold', '0',
    '-s', resolution,
    '-r', fps.toString(),
    '-c:a', 'aac',
    '-b:a', '128k',
    '-ar', '44100',
    '-ac', '2',
    '-f', 'flv',
    rtmpUrl
  ];
}

async function startStream(streamId, isRetry = false) {
  try {
    if (!isRetry) {
      streamRetryCount.set(streamId, 0);
    }

    if (activeStreams.has(streamId)) {
      return { success: false, error: 'Stream is already active' };
    }

    if (isARM32 && activeStreams.size >= 1) {
      const msg = 'Only 1 concurrent stream allowed on ARM32 to prevent system overload';
      addStreamLog(streamId, msg);
      console.warn(msg);
      return { success: false, error: msg };
    }

    const stream = await Stream.findById(streamId);
    if (!stream) {
      return { success: false, error: 'Stream not found' };
    }

    const startTimeIso = new Date().toISOString();
    const ffmpegArgs = await buildFFmpegArgs(stream);
    const fullCommand = `${ffmpegPath} ${ffmpegArgs.join(' ')}`;
    addStreamLog(streamId, `Starting stream with command: ${fullCommand}`);
    console.log(`Starting stream: ${fullCommand}`);

    const ffmpegProcess = spawn(ffmpegPath, ffmpegArgs, {
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    activeStreams.set(streamId, {
      process: ffmpegProcess,
      userId: stream.user_id,
      startTime: startTimeIso,
      pid: ffmpegProcess.pid
    });

    streamLastSuccessTime.set(streamId, Date.now());
    await Stream.updateStatus(streamId, 'live', stream.user_id, { startTimeOverride: startTimeIso });

    ffmpegProcess.stdout.on('data', (data) => {
      const message = data.toString().trim();
      if (message) {
        addStreamLog(streamId, `[OUTPUT] ${message}`);
        markStreamSuccess(streamId);
      }
    });

    ffmpegProcess.stderr.on('data', (data) => {
      const message = data.toString().trim();
      if (message) {
        addStreamLog(streamId, `[FFmpeg] ${message}`);
        if (message.includes('frame=')) {
          markStreamSuccess(streamId);
        } else {
          console.error(`[FFMPEG_STDERR] ${streamId}: ${message}`);
        }
      }
    });

    ffmpegProcess.on('exit', async (code, signal) => {
      addStreamLog(streamId, `Stream ended with code ${code}, signal: ${signal}`);
      console.log(`[FFMPEG_EXIT] ${streamId}: Code=${code}, Signal=${signal}`);

      const wasActive = activeStreams.delete(streamId);
      const isManualStop = manuallyStoppingStreams.has(streamId);

      let currentStream;
      try {
        currentStream = await Stream.findById(streamId);
      } catch (err) {
        console.error(`[StreamingService] Error fetching stream ${streamId}: ${err.message}`);
      }

      const userId = currentStream?.user_id || stream.user_id;

      if (isManualStop) {
        manuallyStoppingStreams.delete(streamId);
        cleanupStreamData(streamId);
        if (wasActive) {
          await Stream.updateStatus(streamId, 'offline', userId);
          if (typeof schedulerService.handleStreamStopped === 'function') {
            schedulerService.handleStreamStopped(streamId);
          }
        }
        return;
      }

      const shouldRetry = (signal === 'SIGSEGV' || signal === 'SIGKILL' || (code !== 0 && code !== null));

      if (shouldRetry) {
        const retryCount = streamRetryCount.get(streamId) || 0;
        if (retryCount < MAX_RETRY_ATTEMPTS) {
          streamRetryCount.set(streamId, retryCount + 1);
          const backoffMs = Math.min(3000 * Math.pow(2, retryCount), isARM32 ? 30000 : 60000);

          console.log(`[StreamingService] Restarting stream ${streamId} in ${backoffMs}ms (attempt ${retryCount + 1})`);
          addStreamLog(streamId, `Restarting in ${backoffMs / 1000}s (attempt ${retryCount + 1})`);

          setTimeout(async () => {
            try {
              const streamInfo = await Stream.findById(streamId);
              if (streamInfo && streamInfo.status !== 'offline') {
                await startStream(streamId, true);
              } else {
                cleanupStreamData(streamId);
              }
            } catch (e) {
              console.error(`[StreamingService] Restart failed:`, e);
              await Stream.updateStatus(streamId, 'offline', userId);
              cleanupStreamData(streamId);
            }
          }, backoffMs);
          return;
        }
      }

      if (wasActive) {
        await Stream.updateStatus(streamId, 'offline', userId);
        if (typeof schedulerService.handleStreamStopped === 'function') {
          schedulerService.handleStreamStopped(streamId);
        }
        cleanupStreamData(streamId);
      }
    });

    ffmpegProcess.on('error', async (err) => {
      addStreamLog(streamId, `Process error: ${err.message}`);
      console.error(`[FFMPEG_PROCESS_ERROR] ${streamId}: ${err.message}`);
      activeStreams.delete(streamId);
      await Stream.updateStatus(streamId, 'offline', stream.user_id);
      cleanupStreamData(streamId);
    });

    if (stream.end_time) {
      const endTime = new Date(stream.end_time);
      const now = new Date();
      const remainingMs = endTime.getTime() - now.getTime();
      if (remainingMs > 0) {
        const remainingMinutes = remainingMs / 60000;
        console.log(`[StreamingService] Scheduling termination for stream ${streamId} (${remainingMinutes.toFixed(1)} min)`);
        schedulerService.scheduleStreamTermination(streamId, remainingMinutes);
      }
    }

    return {
      success: true,
      message: 'Stream started successfully',
      isAdvancedMode: stream.use_advanced_settings
    };
  } catch (error) {
    addStreamLog(streamId, `Failed to start: ${error.message}`);
    console.error(`Error starting stream ${streamId}:`, error);
    return { success: false, error: error.message };
  }
}

async function stopStream(streamId) {
  try {
    const streamData = activeStreams.get(streamId);
    const isActive = !!streamData;

    if (!isActive) {
      const stream = await Stream.findById(streamId);
      if (stream && stream.status === 'live') {
        await Stream.updateStatus(streamId, 'offline', stream.user_id);
        if (typeof schedulerService.handleStreamStopped === 'function') {
          schedulerService.handleStreamStopped(streamId);
        }
        cleanupStreamData(streamId);
        return { success: true, message: 'Fixed inconsistent live status' };
      }
      return { success: false, error: 'Stream not active' };
    }

    addStreamLog(streamId, 'Stopping stream...');
    manuallyStoppingStreams.add(streamId);

    const ffmpegProcess = streamData.process;
    if (ffmpegProcess && typeof ffmpegProcess.kill === 'function') {
      ffmpegProcess.kill('SIGTERM');

      setTimeout(() => {
        if (ffmpegProcess.exitCode === null) {
          try { ffmpegProcess.kill('SIGKILL'); } catch (e) {}
        }
      }, 5000);
    }

    activeStreams.delete(streamId);

    const tempConcatFile = path.join(__dirname, '..', 'temp', `playlist_${streamId}.txt`);
    if (fs.existsSync(tempConcatFile)) {
      fs.unlinkSync(tempConcatFile);
    }

    const stream = await Stream.findById(streamId);
    if (stream) {
      const endTimeForHistory = new Date().toISOString();
      await saveStreamHistory({ ...stream, end_time: endTimeForHistory });
      await Stream.updateStatus(streamId, 'offline', stream.user_id);
    }

    if (typeof schedulerService.handleStreamStopped === 'function') {
      schedulerService.handleStreamStopped(streamId);
    }

    manuallyStoppingStreams.delete(streamId);
    cleanupStreamData(streamId);
    return { success: true, message: 'Stream stopped successfully' };
  } catch (error) {
    manuallyStoppingStreams.delete(streamId);
    console.error(`Error stopping stream ${streamId}:`, error);
    return { success: false, error: error.message };
  }
}

async function syncStreamStatuses() {
  try {
    const liveStreams = await Stream.findAll(null, 'live');
    for (const stream of liveStreams) {
      if (!activeStreams.has(stream.id)) {
        const retryCount = streamRetryCount.get(stream.id);
        const isRetrying = retryCount > 0 && retryCount < MAX_RETRY_ATTEMPTS;
        if (!isRetrying) {
          await Stream.updateStatus(stream.id, 'offline', stream.user_id);
          cleanupStreamData(stream.id);
        }
      }
    }

    const activeStreamIds = Array.from(activeStreams.keys());
    for (const id of activeStreamIds) {
      const s = await Stream.findById(id);
      if (!s) {
        activeStreams.delete(id);
        cleanupStreamData(id);
      }
    }
  } catch (e) {
    console.error('[StreamingService] Sync error:', e);
  }
}

async function healthCheckStreams() {
  try {
    for (const [id, data] of activeStreams) {
      if (data.process.exitCode !== null) {
        activeStreams.delete(id);
        const s = await Stream.findById(id);
        if (s && s.status === 'live') await Stream.updateStatus(id, 'offline', s.user_id);
        cleanupStreamData(id);
      }
      checkAndResetRetryCounter(id);
    }
  } catch (e) {
    console.error('[StreamingService] Health check error:', e);
  }
}

setInterval(syncStreamStatuses, 5 * 60 * 1000);
setInterval(healthCheckStreams, HEALTH_CHECK_INTERVAL);
setInterval(cleanupOldLogs, 30 * 60 * 1000);

async function gracefulShutdown() {
  console.log('[StreamingService] Graceful shutdown initiated...');
  const ids = Array.from(activeStreams.keys());
  for (const id of ids) {
    manuallyStoppingStreams.add(id);
    const p = activeStreams.get(id)?.process;
    if (p?.kill) p.kill('SIGTERM');
    setTimeout(() => { if (p?.exitCode === null) p?.kill('SIGKILL'); }, 5000);
    const s = await Stream.findById(id);
    if (s) await Stream.updateStatus(id, 'offline', s.user_id);
    activeStreams.delete(id);
    cleanupStreamData(id, false);
  }
  console.log('[StreamingService] Shutdown completed');
}

process.on('SIGTERM', async () => { await gracefulShutdown(); process.exit(0); });
process.on('SIGINT', async () => { await gracefulShutdown(); process.exit(0); });

function isStreamActive(streamId) {
  const data = activeStreams.get(streamId);
  if (!data) return false;
  if (data.process.exitCode !== null) {
    activeStreams.delete(streamId);
    return false;
  }
  return true;
}

function getActiveStreams() {
  return Array.from(activeStreams.keys());
}

function getActiveStreamInfo(streamId) {
  const data = activeStreams.get(streamId);
  if (!data) return null;
  return {
    streamId,
    userId: data.userId,
    startTime: data.startTime,
    pid: data.pid,
    retryCount: streamRetryCount.get(streamId) || 0
  };
}

function getStreamLogs(streamId) {
  return streamLogs.get(streamId) || [];
}

async function saveStreamHistory(stream) {
  try {
    if (!stream.start_time) {
      console.log(`[StreamingService] Not saving history for stream ${stream.id} - no start time recorded`);
      return false;
    }
    const startTime = new Date(stream.start_time);
    const endTime = stream.end_time ? new Date(stream.end_time) : new Date();
    const durationSeconds = Math.floor((endTime - startTime) / 1000);
    if (durationSeconds < 1) {
      console.log(`[StreamingService] Not saving history for stream ${stream.id} - duration too short (${durationSeconds}s)`);
      return false;
    }
    const videoDetails = stream.video_id ? await Video.findById(stream.video_id) : null;
    const historyData = {
      id: uuidv4(),
      stream_id: stream.id,
      title: stream.title,
      platform: stream.platform || 'Custom',
      platform_icon: stream.platform_icon,
      video_id: stream.video_id,
      video_title: videoDetails ? videoDetails.title : null,
      resolution: stream.resolution,
      bitrate: stream.bitrate,
      fps: stream.fps,
      start_time: stream.start_time,
      end_time: stream.end_time || new Date().toISOString(),
      duration: durationSeconds,
      use_advanced_settings: stream.use_advanced_settings ? 1 : 0,
      user_id: stream.user_id
    };

    return new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO stream_history (
          id, stream_id, title, platform, platform_icon, video_id, video_title,
          resolution, bitrate, fps, start_time, end_time, duration, use_advanced_settings, user_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          historyData.id, historyData.stream_id, historyData.title,
          historyData.platform, historyData.platform_icon, historyData.video_id, historyData.video_title,
          historyData.resolution, historyData.bitrate, historyData.fps,
          historyData.start_time, historyData.end_time, historyData.duration,
          historyData.use_advanced_settings, historyData.user_id
        ],
        function (err) {
          if (err) {
            console.error('[StreamingService] Error saving stream history:', err.message);
            return reject(err);
          }
          console.log(`[StreamingService] Stream history saved for stream ${stream.id}, duration: ${durationSeconds}s`);
          resolve(historyData);
        }
      );
    });
  } catch (error) {
    console.error('[StreamingService] Failed to save stream history:', error);
    return false;
  }
}

module.exports = {
  startStream,
  stopStream,
  isStreamActive,
  getActiveStreams,
  getActiveStreamInfo,
  getStreamLogs,
  syncStreamStatuses,
  healthCheckStreams,
  saveStreamHistory,
  gracefulShutdown
};
