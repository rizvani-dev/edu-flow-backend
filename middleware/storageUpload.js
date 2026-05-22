const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { randomUUID } = require('crypto');
const { supabase, supabaseBucket, isSupabaseConfigured } = require('../config/supabase');
const {
  MAX_MEDIA_BYTES,
  buildSafeBaseName,
  processImageUpload,
  processVideoUpload,
  ensureUploadWithinLimit,
} = require('../utils/mediaProcessing');

const createFileFilter = (allowedMimePatterns, allowedExtensions) => {
  return (req, file, cb) => {
    const mime = String(file?.mimetype || '').toLowerCase();
    const extension = path.extname(String(file?.originalname || '')).toLowerCase();
    const isMimeAllowed = allowedMimePatterns.some((pattern) => pattern.test(mime));
    const isExtensionAllowed = allowedExtensions.includes(extension);

    if (isMimeAllowed || isExtensionAllowed) {
      cb(null, true);
      return;
    }

    cb(new Error('Unsupported file type'));
  };
};

const createMemoryUploader = ({ fileSize, fileFilter }) =>
  multer({
    storage: multer.memoryStorage(),
    limits: { fileSize },
    fileFilter,
  });

const buildStoragePath = (folder, originalName, extension) => {
  const now = new Date();
  const year = String(now.getUTCFullYear());
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  const safeName = buildSafeBaseName(originalName);
  return `${folder}/${year}/${month}/${safeName}-${randomUUID()}${extension}`;
};

const uploadBufferToSupabase = async (buffer, storagePath, contentType) => {
  const { error } = await supabase.storage.from(supabaseBucket).upload(storagePath, buffer, {
    contentType,
    cacheControl: '31536000',
    upsert: false,
  });

  if (error) {
    throw error;
  }

  const { data } = supabase.storage.from(supabaseBucket).getPublicUrl(storagePath);
  return {
    path: data.publicUrl,
    secure_url: data.publicUrl,
    public_id: storagePath,
  };
};

const processUploadByType = async (file, kind) => {
  if (kind === 'chat') {
    const mime = String(file.mimetype || '').toLowerCase();

    if (mime.startsWith('image/')) {
      return ensureUploadWithinLimit(await processImageUpload(file), 'Image');
    }

    if (mime.startsWith('video/')) {
      return ensureUploadWithinLimit(await processVideoUpload(file), 'Video');
    }
  }

  if (kind === 'profile' || kind === 'logo' || kind === 'document') {
    const mime = String(file.mimetype || '').toLowerCase();
    if (mime.startsWith('image/')) {
      const processed = await processImageUpload(file);
      return ensureUploadWithinLimit(processed, 'Image');
    }
  }

  return ensureUploadWithinLimit(
    {
      ...file,
      processedBuffer: file.buffer,
      processedMimeType: file.mimetype,
      processedExtension: path.extname(file.originalname || '').toLowerCase() || '.bin',
      processedOriginalName: file.originalname,
      size: file.buffer.length,
    },
    'File'
  );
};

const createStorageUploader = (uploader, { folder, kind }) => {
  const single = (fieldName = 'file') => (req, res, next) => {
    uploader.single(fieldName)(req, res, async (error) => {
      if (error) {
        next(error);
        return;
      }

      if (!req.file) {
        next();
        return;
      }

      if (!isSupabaseConfigured) {
        next(new Error('Supabase storage is not configured on the server'));
        return;
      }

      try {
        const processedFile = await processUploadByType(req.file, kind);
        // Ensure extension matches processing (e.g. if PNG converted to WebP)
        const storagePath = buildStoragePath(
          folder,
          processedFile.processedOriginalName || req.file.originalname,
          processedFile.processedExtension || path.extname(processedFile.processedOriginalName || req.file.originalname)
        );
        const result = await uploadBufferToSupabase(
          processedFile.processedBuffer,
          storagePath,
          processedFile.processedMimeType || req.file.mimetype
        );

        req.file = {
          ...processedFile,
          path: result.secure_url,
          secure_url: result.secure_url,
          filename: path.basename(storagePath),
          public_id: result.public_id,
          originalname: processedFile.processedOriginalName || req.file.originalname,
          mimetype: processedFile.processedMimeType || req.file.mimetype,
          storage_path: storagePath,
        };

        next();
      } catch (uploadError) {
        next(uploadError);
      }
    });
  };

  return { single };
};

const imageFileFilter = createFileFilter(
  [/^image\//],
  ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.heic', '.heif']
);

const documentFileFilter = createFileFilter(
  [
    /^image\//,
    /^application\/pdf$/,
    /^application\/(msword|vnd\.openxmlformats-officedocument\.wordprocessingml\.document)$/,
    /^application\/(vnd\.ms-excel|vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet)$/,
  ],
  ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.pdf', '.doc', '.docx', '.xls', '.xlsx']
);

const chatFileFilter = createFileFilter(
  [/^image\//, /^video\//, /^audio\//, /^application\/pdf$/],
  [
    '.jpg',
    '.jpeg',
    '.png',
    '.gif',
    '.webp',
    '.svg',
    '.pdf',
    '.mp4',
    '.webm',
    '.mov',
    '.mkv',
    '.mp3',
    '.wav',
    '.m4a',
    '.aac',
    '.ogg',
    '.opus',
  ]
);

const uploadProfile = createStorageUploader(
  createMemoryUploader({
    fileSize: MAX_MEDIA_BYTES,
    fileFilter: imageFileFilter,
  }),
  { folder: 'profiles', kind: 'profile' }
);

const uploadLogo = createStorageUploader(
  createMemoryUploader({
    fileSize: MAX_MEDIA_BYTES,
    fileFilter: imageFileFilter,
  }),
  { folder: 'logos', kind: 'logo' }
);

const uploadDoc = createStorageUploader(
  createMemoryUploader({
    fileSize: MAX_MEDIA_BYTES,
    fileFilter: documentFileFilter,
  }),
  { folder: 'documents', kind: 'document' }
);

const uploadChat = createStorageUploader(
  createMemoryUploader({
    fileSize: MAX_MEDIA_BYTES,
    fileFilter: chatFileFilter,
  }),
  { folder: 'chat', kind: 'chat' }
);

const tempUploadDir = path.join(__dirname, '..', 'uploads', 'temp');
if (!fs.existsSync(tempUploadDir)) {
  fs.mkdirSync(tempUploadDir, { recursive: true });
}

const tempDiskUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, tempUploadDir),
    filename: (req, file, cb) => {
      const safeName = String(file.originalname || 'upload')
        .replace(/\s+/g, '_')
        .replace(/[^a-zA-Z0-9._-]/g, '');
      cb(null, `${Date.now()}-${safeName}`);
    },
  }),
  limits: { fileSize: MAX_MEDIA_BYTES },
});

const uploadToSupabase = async (filePath, folder) => {
  if (!isSupabaseConfigured) {
    throw new Error('Supabase storage is not configured on the server');
  }

  try {
    const buffer = await fs.promises.readFile(filePath);
    const extension = path.extname(filePath).toLowerCase();
    const storagePath = buildStoragePath(folder, path.basename(filePath, extension), extension);
    const result = await uploadBufferToSupabase(buffer, storagePath, undefined);

    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    return result;
  } catch (error) {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    throw error;
  }
};

module.exports = {
  isSupabaseConfigured,
  uploadProfile,
  uploadLogo,
  uploadDoc,
  uploadChat,
  upload: tempDiskUpload,
  uploadToSupabase,
};
