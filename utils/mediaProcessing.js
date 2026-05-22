const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');
const ffmpegPath = require('ffmpeg-static');
const { spawn } = require('child_process');

const MAX_MEDIA_BYTES = 10 * 1024 * 1024;

const isRasterImage = (mime = '', extension = '') =>
  mime.startsWith('image/') &&
  !['image/svg+xml', 'image/gif'].includes(mime) &&
  !['.svg', '.gif'].includes(extension);

const buildSafeBaseName = (originalName = 'upload') =>
  path
    .parse(String(originalName || 'upload'))
    .name.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50) || 'upload';

const processImageUpload = async (file, options = {}) => {
  const extension = path.extname(String(file.originalname || '')).toLowerCase();
  const mime = String(file.mimetype || '').toLowerCase();

  if (!isRasterImage(mime, extension)) {
    return {
      ...file,
      processedBuffer: file.buffer,
      processedMimeType: file.mimetype,
      processedExtension: extension || '',
      processedOriginalName: file.originalname,
      size: file.buffer.length,
    };
  }

  const processedBuffer = await sharp(file.buffer, { animated: false })
    .rotate()
    .resize({
      width: options.maxWidth || 1600,
      height: options.maxHeight || 1600,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .webp({
      quality: options.quality || 82,
      effort: 4,
    })
    .toBuffer();

  return {
    ...file,
    processedBuffer,
    processedMimeType: 'image/webp',
    processedExtension: '.webp',
    processedOriginalName: `${buildSafeBaseName(file.originalname)}.webp`,
    size: processedBuffer.length,
  };
};

const runFfmpeg = (args) =>
  new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { windowsHide: true });
    let stderr = '';

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(stderr || `FFmpeg exited with code ${code}`));
    });
  });

const processVideoUpload = async (file) => {
  if (!ffmpegPath) {
    return {
      ...file,
      processedBuffer: file.buffer,
      processedMimeType: file.mimetype,
      processedExtension: path.extname(file.originalname || '').toLowerCase() || '.mp4',
      processedOriginalName: file.originalname,
      size: file.buffer.length,
    };
  }

  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'school-manager-video-'));
  const inputPath = path.join(tempDir, `input${path.extname(file.originalname || '.mp4') || '.mp4'}`);
  const outputPath = path.join(tempDir, 'output.mp4');

  try {
    await fs.promises.writeFile(inputPath, file.buffer);

    await runFfmpeg([
      '-y',
      '-i',
      inputPath,
      '-vf',
      "scale='min(1280,iw)':-2",
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '31',
      '-movflags',
      '+faststart',
      '-c:a',
      'aac',
      '-b:a',
      '96k',
      outputPath,
    ]);

    const processedBuffer = await fs.promises.readFile(outputPath);

    return {
      ...file,
      processedBuffer,
      processedMimeType: 'video/mp4',
      processedExtension: '.mp4',
      processedOriginalName: `${buildSafeBaseName(file.originalname)}.mp4`,
      size: processedBuffer.length,
    };
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
};

const ensureUploadWithinLimit = (file, label = 'File') => {
  if (Number(file?.size || 0) > MAX_MEDIA_BYTES) {
    throw new Error(`${label} exceeds the 10MB upload limit after processing`);
  }

  return file;
};

module.exports = {
  MAX_MEDIA_BYTES,
  buildSafeBaseName,
  processImageUpload,
  processVideoUpload,
  ensureUploadWithinLimit,
};
