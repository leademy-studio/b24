/**
 * Тонкая обёртка над Google Cloud SDK (@google-cloud/storage).
 *
 * Аутентификация: библиотека сама подхватывает Application Default Credentials.
 * Проще всего задать переменную GOOGLE_APPLICATION_CREDENTIALS с путём к JSON
 * ключу сервис-аккаунта (см. .env.example).
 */
import { Storage } from "@google-cloud/storage";
import { config } from "../config.js";

let storage: Storage | undefined;

function getStorage(): Storage {
  if (!storage) {
    storage = new Storage({
      projectId: config.google.projectId,
      keyFilename: config.google.credentialsFile,
    });
  }
  return storage;
}

export interface GcsBucket {
  name: string;
  location?: string;
  storageClass?: string;
}

export async function listBuckets(): Promise<GcsBucket[]> {
  const [buckets] = await getStorage().getBuckets();
  return buckets.map((b) => ({
    name: b.name,
    location: b.metadata?.location,
    storageClass: b.metadata?.storageClass,
  }));
}

export interface GcsObject {
  name: string;
  size?: string | number;
  updated?: string;
}

export async function listObjects(
  bucket: string,
  prefix?: string,
  maxResults = 100,
): Promise<GcsObject[]> {
  const [files] = await getStorage()
    .bucket(bucket)
    .getFiles({ prefix, maxResults });
  return files.map((f) => ({
    name: f.name,
    size: f.metadata?.size,
    updated: f.metadata?.updated,
  }));
}
