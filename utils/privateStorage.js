const fs = require('fs');
const path = require('path');
const { supabaseAdmin, supabasePrivateBucket, isSupabaseServiceConfigured } = require('../config/supabase');

let privateBucketReady;
const localProofRoot = path.resolve(__dirname, '..', 'private-uploads', 'fee-proofs');

const getLocalProofPath = (objectPath) => {
  if (typeof objectPath !== 'string' || !objectPath || objectPath.startsWith('/') ||
      objectPath.split(/[\\/]/).some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error('Invalid private file path');
  }

  const filePath = path.resolve(localProofRoot, objectPath);
  if (!filePath.startsWith(`${localProofRoot}${path.sep}`)) {
    throw new Error('Invalid private file path');
  }
  return filePath;
};

const isLocalPrivateStorageEnabled = () => process.env.NODE_ENV !== 'production';

const ensurePrivateStorageConfigured = () => {
  if (!isSupabaseServiceConfigured && !isLocalPrivateStorageEnabled()) {
    throw new Error('Private proof storage requires SUPABASE_SERVICE_ROLE_KEY in production');
  }
};

const ensurePrivateBucket = async () => {
  if (!isSupabaseServiceConfigured) {
    ensurePrivateStorageConfigured();
    return;
  }

  if (!privateBucketReady) {
    privateBucketReady = (async () => {
      const { data, error } = await supabaseAdmin.storage.getBucket(supabasePrivateBucket);
      if (!error && data) {
        if (data.public) {
          const { error: updateError } = await supabaseAdmin.storage.updateBucket(supabasePrivateBucket, {
            public: false,
            allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
            fileSizeLimit: '10MB',
          });
          if (updateError) throw updateError;
        }
        return;
      }

      const { error: createError } = await supabaseAdmin.storage.createBucket(supabasePrivateBucket, {
        public: false,
        allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
        fileSizeLimit: '10MB',
      });
      if (createError) {
        const retry = await supabaseAdmin.storage.getBucket(supabasePrivateBucket);
        if (retry.error || !retry.data || retry.data.public) throw createError;
      }
    })();
  }

  try {
    await privateBucketReady;
  } catch (error) {
    privateBucketReady = null;
    throw error;
  }
};

const uploadPrivateProof = async ({ buffer, path: objectPath, contentType }) => {
  ensurePrivateStorageConfigured();
  if (!isSupabaseServiceConfigured) {
    const filePath = getLocalProofPath(objectPath);
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await fs.promises.writeFile(filePath, buffer, { flag: 'wx', mode: 0o600 });
    return `private-local://${objectPath}`;
  }

  getLocalProofPath(objectPath);
  await ensurePrivateBucket();
  const { error } = await supabaseAdmin.storage.from(supabasePrivateBucket).upload(objectPath, new Uint8Array(buffer), {
    contentType,
    cacheControl: '300',
    upsert: false,
  });
  if (error) throw error;
  return `private-storage://${objectPath}`;
};

const getPrivateProofSignedUrl = async (reference, expiresIn = 300) => {
  const localPrefix = 'private-local://';
  if (typeof reference === 'string' && reference.startsWith(localPrefix)) {
    const objectPath = reference.slice(localPrefix.length);
    const filePath = getLocalProofPath(objectPath);
    const extension = path.extname(filePath).toLowerCase();
    const contentTypes = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.webp': 'image/webp',
    };
    const contentType = contentTypes[extension];
    if (!contentType) throw new Error('Unsupported private proof file type');
    const content = await fs.promises.readFile(filePath);
    return `data:${contentType};base64,${content.toString('base64')}`;
  }

  const prefix = 'private-storage://';
  if (typeof reference !== 'string' || !reference.startsWith(prefix)) {
    throw new Error('Invalid private file reference');
  }
  const objectPath = reference.slice(prefix.length);
  getLocalProofPath(objectPath);

  await ensurePrivateBucket();
  const { data, error } = await supabaseAdmin.storage.from(supabasePrivateBucket).createSignedUrl(objectPath, expiresIn);
  if (error) throw error;
  return data.signedUrl;
};

const deletePrivateProof = async (reference) => {
  const localPrefix = 'private-local://';
  if (typeof reference === 'string' && reference.startsWith(localPrefix)) {
    const objectPath = reference.slice(localPrefix.length);
    await fs.promises.unlink(getLocalProofPath(objectPath));
    return;
  }

  const prefix = 'private-storage://';
  if (typeof reference !== 'string' || !reference.startsWith(prefix)) return;
  const objectPath = reference.slice(prefix.length);
  getLocalProofPath(objectPath);
  await ensurePrivateBucket();
  const { error } = await supabaseAdmin.storage.from(supabasePrivateBucket).remove([objectPath]);
  if (error) throw error;
};

module.exports = { uploadPrivateProof, getPrivateProofSignedUrl, deletePrivateProof };
