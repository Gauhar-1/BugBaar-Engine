/**
 * CloudinaryStorage
 *
 * Replaces Supabase Storage for document upload and retrieval.
 * Provides upload via stream, signed download URL generation,
 * and file deletion.
 *
 * @module infrastructure/storage/CloudinaryStorage
 */

import { v2 as cloudinary, UploadApiResponse } from 'cloudinary';
import { Readable } from 'stream';
import {
  getCloudinaryCloudName,
  getCloudinaryApiKey,
  getCloudinaryApiSecret,
  getCloudinaryFolder,
} from '@/config/env';
import { createLogger } from '@/lib/logger';
import { AppError } from '@/lib/errors';

const log = createLogger('CloudinaryStorage');

export interface CloudinaryUploadResult {
  /** Cloudinary public_id for the uploaded file (used for downloads and deletions) */
  publicId: string;
  /** Full secure HTTPS URL */
  secureUrl: string;
  /** Original filename */
  originalFilename: string;
  /** File size in bytes */
  bytes: number;
  /** Cloudinary resource type */
  resourceType: string;
}

let _initialized = false;

/**
 * Configures the Cloudinary SDK once on first use.
 */
function ensureInitialized(): void {
  if (_initialized) return;

  cloudinary.config({
    cloud_name: getCloudinaryCloudName(),
    api_key: getCloudinaryApiKey(),
    api_secret: getCloudinaryApiSecret(),
    secure: true,
  });

  _initialized = true;
  log.info('Cloudinary SDK initialized');
}

export class CloudinaryStorage {
  constructor() {
    ensureInitialized();
  }

  /**
   * Uploads a file buffer to Cloudinary using an upload stream.
   * Files are stored as raw resources to support arbitrary file types (PDF, TXT).
   *
   * @param buffer - Raw file buffer
   * @param filename - Original filename (used as the public_id suffix)
   * @param folder - Optional subfolder override (defaults to env CLOUDINARY_FOLDER)
   */
  async uploadBuffer(
    buffer: Buffer,
    filename: string,
    folder?: string
  ): Promise<CloudinaryUploadResult> {
    const targetFolder = folder ?? getCloudinaryFolder();
    const publicId = `${targetFolder}/${Date.now()}-${filename.replace(/[^a-z0-9._-]/gi, '_')}`;

    log.info('Uploading file to Cloudinary', { filename, folder: targetFolder, publicId });

    return new Promise((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        {
          public_id: publicId,
          resource_type: 'raw', // supports PDF, TXT, and other non-image files
          overwrite: false,
          use_filename: true,
          unique_filename: true,
        },
        (error, result) => {
          if (error || !result) {
            log.error('Cloudinary upload failed', {
              error: error?.message ?? 'No result returned',
            });
            return reject(
              new AppError(
                `Cloudinary upload failed: ${error?.message ?? 'Unknown error'}`,
                'CLOUDINARY_UPLOAD_ERROR',
                502
              )
            );
          }

          log.info('File uploaded to Cloudinary', {
            publicId: result.public_id,
            bytes: result.bytes,
          });

          resolve({
            publicId: result.public_id,
            secureUrl: result.secure_url,
            originalFilename: filename,
            bytes: result.bytes,
            resourceType: result.resource_type,
          });
        }
      );

      // Pipe buffer into the upload stream
      const readable = new Readable();
      readable.push(buffer);
      readable.push(null);
      readable.pipe(uploadStream);
    });
  }

  /**
   * Generates a time-limited signed download URL for a stored file.
   *
   * @param publicId - Cloudinary public_id of the file
   * @param expiresInSeconds - URL validity window (default: 1 hour)
   */
  getSignedDownloadUrl(
    publicId: string,
    expiresInSeconds: number = 3600
  ): string {
    const expiresAt = Math.floor(Date.now() / 1000) + expiresInSeconds;

    const url = cloudinary.url(publicId, {
      resource_type: 'raw',
      sign_url: true,
      expires_at: expiresAt,
      secure: true,
    });

    log.info('Signed download URL generated', { publicId, expiresAt });
    return url;
  }

  /**
   * Deletes a file from Cloudinary by its public_id.
   *
   * @param publicId - Cloudinary public_id of the file to delete
   */
  async deleteFile(publicId: string): Promise<void> {
    try {
      log.info('Deleting file from Cloudinary', { publicId });

      const result = await cloudinary.uploader.destroy(publicId, {
        resource_type: 'raw',
      });

      if (result.result !== 'ok' && result.result !== 'not found') {
        throw new AppError(
          `Cloudinary delete failed: ${result.result}`,
          'CLOUDINARY_DELETE_ERROR',
          502
        );
      }

      log.info('File deleted from Cloudinary', { publicId, result: result.result });
    } catch (error) {
      if (error instanceof AppError) throw error;
      const err = error instanceof Error ? error : new Error(String(error));
      log.error('Cloudinary delete failed', { publicId, error: err.message });
      throw new AppError(`Cloudinary delete failed: ${err.message}`, 'CLOUDINARY_DELETE_ERROR', 502);
    }
  }
}
