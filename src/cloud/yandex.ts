/**
 * Тонкая обёртка над официальным Yandex Cloud SDK (@yandex-cloud/nodejs-sdk, v3).
 *
 * Аутентификация (выбирается первый заданный способ из .env):
 *   YC_OAUTH_TOKEN   — OAuth-токен пользователя
 *   YC_IAM_TOKEN     — короткоживущий IAM-токен
 *   YC_SA_KEY_FILE   — путь к JSON ключу сервис-аккаунта (`yc iam key create`)
 */
import { readFileSync } from "node:fs";
import { Session } from "@yandex-cloud/nodejs-sdk";
import { cloudService, folderService } from "@yandex-cloud/nodejs-sdk/resourcemanager-v1";
import { instanceService } from "@yandex-cloud/nodejs-sdk/compute-v1";
import { config } from "../config.js";

let session: Session | undefined;

function getSession(): Session {
  if (session) return session;

  const { oauthToken, iamToken, saKeyFile } = config.yandex;

  if (oauthToken) {
    session = new Session({ oauthToken });
  } else if (iamToken) {
    session = new Session({ iamToken });
  } else if (saKeyFile) {
    // Формат файла из `yc iam key create`: { id, service_account_id, private_key }
    const key = JSON.parse(readFileSync(saKeyFile, "utf8"));
    session = new Session({
      serviceAccountJson: {
        accessKeyId: key.id,
        serviceAccountId: key.service_account_id,
        privateKey: key.private_key,
      },
    });
  } else {
    throw new Error(
      "Не заданы учётные данные Yandex Cloud: укажите YC_OAUTH_TOKEN, YC_IAM_TOKEN или YC_SA_KEY_FILE в .env",
    );
  }
  return session;
}

export interface YcCloud {
  id: string;
  name: string;
}

export async function listClouds(): Promise<YcCloud[]> {
  const client = getSession().client(cloudService.CloudServiceClient);
  const res = await client.list(cloudService.ListCloudsRequest.fromPartial({ pageSize: 100 }));
  return res.clouds.map((c) => ({ id: c.id, name: c.name }));
}

export interface YcFolder {
  id: string;
  name: string;
  status: string;
}

export async function listFolders(cloudId?: string): Promise<YcFolder[]> {
  const id = cloudId ?? config.yandex.cloudId;
  if (!id) throw new Error("Не указан cloudId (аргумент cloudId или YC_CLOUD_ID в .env)");
  const client = getSession().client(folderService.FolderServiceClient);
  const res = await client.list(
    folderService.ListFoldersRequest.fromPartial({ cloudId: id, pageSize: 100 }),
  );
  return res.folders.map((f) => ({ id: f.id, name: f.name, status: String(f.status) }));
}

export interface YcInstance {
  id: string;
  name: string;
  status: string;
  zoneId: string;
}

export async function listInstances(folderId?: string): Promise<YcInstance[]> {
  const id = folderId ?? config.yandex.folderId;
  if (!id) throw new Error("Не указан folderId (аргумент folderId или YC_FOLDER_ID в .env)");
  const client = getSession().client(instanceService.InstanceServiceClient);
  const res = await client.list(
    instanceService.ListInstancesRequest.fromPartial({ folderId: id, pageSize: 100 }),
  );
  return res.instances.map((i) => ({
    id: i.id,
    name: i.name,
    status: String(i.status),
    zoneId: i.zoneId,
  }));
}
